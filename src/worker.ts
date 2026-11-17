import type { WorkerEnv } from "../alchemy.run.ts";
import { remindersFor } from "./announce-watch.ts";
import { fmtPT, handleAnnouncementEmail } from "./announce.ts";
import { HOME, SOURCES } from "./config.ts";
import { type AnnouncementRow, claimAndNotify, TOUCH_EVERY_MS } from "./jobs.ts";
import { enqueue, handleNotifyBatch, jobMessages, type NotifyMessage } from "./notify.ts";
import { fetchSource } from "./sources.ts";
import type { Job } from "./types.ts";

/** Alert once if a board has been failing for this long (scrapers break silently). */
const BROKEN_AFTER_MS = 6 * 60 * 60 * 1000;

/**
 * Exponential backoff after consecutive failures (e.g. a board rate-limiting us with 403s), scaled from
 * the board's own pace: every-minute boards retry after 1, 2, 4, 8… min; a 5-minute board after
 * 5, 10, 20, 40 min. Capped at 60. One success resets it.
 */
export const backoffMs = (failures: number, everyMinutes = 1) =>
  Math.min(everyMinutes * 2 ** (failures - 1), 60) * 60_000;

/** Cron ticks drift by a few seconds; a board due within this window counts as due now. */
const TICK_SLACK_MS = 15_000;

/**
 * Is this board due? A failing board waits out its backoff (`next_attempt`). A healthy board runs on
 * its pace by the clock - every tick for 1-minute boards, ticks on :00/:05/:10… for 5-minute ones -
 * so pacing needs no stored state (and no writes).
 */
const isDue = (everyMinutes: number, s: Status | undefined, now: number) =>
  s?.failures ? (s.next_attempt ?? 0) <= now + TICK_SLACK_MS : Math.round(now / 60_000) % everyMinutes === 0;

type Status = {
  source: string;
  last_ok: number | null;
  alerted: number;
  last_count: number | null;
  last_error: string | null;
  last_error_at: number | null;
  failures: number;
  next_attempt: number | null;
};

async function run(env: WorkerEnv, { manual = false } = {}) {
  const now = Date.now();
  const status = new Map(
    (
      await env.DB.prepare(
        `SELECT source, last_ok, last_count, last_error, last_error_at, alerted, failures, next_attempt FROM source_status`,
      ).all<Status>()
    ).results.map((s) => [s.source, s]),
  );
  // Manual /run checks everything; cron runs only boards whose pace or backoff says they're due.
  const sources = SOURCES.filter((s) => manual || isDue(s.everyMinutes ?? 1, status.get(s.name), now));
  const results = await Promise.allSettled(sources.map(fetchSource));

  const fetched: Job[] = [];
  const statusWrites: D1PreparedStatement[] = [];
  const broken: string[] = [];

  for (const [i, r] of results.entries()) {
    const { name, everyMinutes = 1, expectNonEmpty } = sources[i];
    const prev = status.get(name);
    // A board that always has listings returning none means the parser broke (or the site changed).
    const emptied = r.status === "fulfilled" && expectNonEmpty && r.value.length === 0 && (prev?.last_count ?? 0) > 0;

    if (r.status === "fulfilled" && !emptied) {
      fetched.push(...r.value);
      // Skip the write when nothing changed: healthy before, same listing count, refreshed recently.
      const changed =
        !prev?.last_ok ||
        prev.failures > 0 ||
        prev.last_count !== r.value.length ||
        now - prev.last_ok >= TOUCH_EVERY_MS;
      if (changed)
        statusWrites.push(
          env.DB.prepare(
            `INSERT INTO source_status (source, last_ok, last_count, alerted, failures, next_attempt)
             VALUES (?1, ?2, ?3, 0, 0, NULL)
             ON CONFLICT (source) DO UPDATE SET last_ok = ?2, last_count = ?3, alerted = 0, failures = 0, next_attempt = NULL`,
          ).bind(name, now, r.value.length),
        );
      continue;
    }

    const msg =
      r.status === "rejected"
        ? String(r.reason?.message ?? r.reason).slice(0, 500)
        : `returned 0 listings (was ${prev?.last_count}) - parser likely broken`;
    const failures = (prev?.failures ?? 0) + 1;
    // No backoff for an emptied board: it may really be empty, and its next posting must not wait an hour.
    const wait = emptied ? 0 : backoffMs(failures, everyMinutes);
    console.error(`${name} failed (${failures}x, retry in ${wait / 60_000} min): ${msg}`);
    // ~6h of failures: measured from the last success, or by count (8 = several hours of backoff) for a board that never worked.
    const longBroken = prev?.last_ok ? now - prev.last_ok > BROKEN_AFTER_MS : failures >= 8;
    const shouldAlert = !prev?.alerted && longBroken;
    if (shouldAlert) broken.push(`${name}: ${msg}`);
    // An emptied board fails every minute; only rewrite its row when something changes.
    const sameAsBefore =
      emptied && prev?.failures && prev.last_error === msg && now - (prev.last_error_at ?? 0) < TOUCH_EVERY_MS;
    if (!sameAsBefore || shouldAlert)
      statusWrites.push(
        env.DB.prepare(
          `INSERT INTO source_status (source, last_error, last_error_at, alerted, failures, next_attempt)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)
           ON CONFLICT (source) DO UPDATE SET last_error = ?2, last_error_at = ?3,
             alerted = MAX(alerted, ?4), failures = ?5, next_attempt = ?6`,
        ).bind(name, msg, now, shouldAlert ? 1 : 0, failures, now + wait),
      );
  }

  // D1's free tier counts rows written (INSERT and UPDATE alike), so board status is only written
  // when something changed; it rides in the same batch as the job claims.
  const { unique, fresh } = await claimAndNotify(env, fetched, now, statusWrites);

  if (broken.length) {
    const body = `These job boards have been failing for 6+ hours - the scraper probably needs a fix:\n\n${broken.join("\n")}`;
    const dedupeKey = `broken:${broken.map((b) => b.split(":")[0]).join("|")}:${new Date(now).toISOString().slice(0, 13)}`;
    await enqueue(env, [
      {
        kind: "email",
        title: "EMT Job Watch: a job board stopped working",
        body,
        priority: 1,
        dedupeKey: `${dedupeKey}:email`,
      },
      {
        kind: "push",
        title: "Job board scraper broken",
        body: broken.join("\n"),
        priority: 1,
        dedupeKey: `${dedupeKey}:push`,
      },
    ]);
  }

  const summary = { matches: unique.length, new: fresh.map((j) => `${j.employer}: ${j.title}`), broken };
  console.log(JSON.stringify(summary));
  return summary;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const ago = (t?: number | null) => (t ? `${Math.round((Date.now() - t) / 60000)} min ago` : "never");

async function dashboard(env: WorkerEnv) {
  const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const [{ results: jobs }, { results: status }, { results: announcements }] = await Promise.all([
    env.DB.prepare(`SELECT * FROM jobs WHERE last_seen > ? ORDER BY first_seen DESC LIMIT 100`).bind(since).all<any>(),
    env.DB.prepare(`SELECT * FROM source_status ORDER BY source`).all<any>(),
    env.DB.prepare(
      `SELECT * FROM announcements WHERE status = 'watching' OR received_at > ? ORDER BY received_at DESC LIMIT 10`,
    )
      .bind(since)
      .all<AnnouncementRow>(),
  ]);
  const nextReminder = (a: AnnouncementRow) => {
    if (a.status !== "watching") return "";
    const next = remindersFor(env, a).find((r) => r.at > Date.now());
    return next ? ` · next reminder ${fmtPT(next.at)}` : "";
  };
  const announcementsHtml = announcements.length
    ? `<h2>Announcements</h2>${announcements
        .map(
          (a) => `<div class=j><b>${esc(a.announcer)}</b> - ${esc(a.subject)}
<div class=m>${a.status === "watching" ? "👀 watching" : a.status === "confirmed" ? "✅ posting found" : "⌛ expired"} · ${a.open_at ? `opens ${fmtPT(a.open_at)}` : "date not stated"}${nextReminder(a)} · received ${fmtPT(a.received_at)}</div></div>`,
        )
        .join("")}<h2>Jobs</h2>`
    : "";
  const html = `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>EMT Job Watch</title>
<style>body{font:15px system-ui,sans-serif;max-width:720px;margin:24px auto;padding:0 16px;color:#111;background:#fff}
@media(prefers-color-scheme:dark){body{color:#eee;background:#111}a{color:#8ab4ff}}
.j{padding:10px 0;border-top:1px solid #8884}.tag{font-size:11px;font-weight:600;padding:1px 6px;border-radius:4px;background:#2563eb22;color:#2563eb}.tag.ff{background:#dc262622;color:#dc2626}.m{color:#888;font-size:13px}.gone{opacity:.45}</style>
<h1>EMT Job Watch</h1><p class=m>EMT-B jobs and firefighter trainee/recruit openings within ${HOME.radiusMiles} mi of ${HOME.label}. Faded = no longer listed.</p>
${announcementsHtml}${
    jobs
      .map(
        (j: any) => `<div class="j ${Date.now() - j.last_seen > 60 * 60 * 1000 ? "gone" : ""}">
<span class="tag ${j.category}">${j.category === "ff" ? "FF Recruit" : "EMT"}</span> <a href="${esc(j.url)}"><b>${esc(j.title)}</b></a><br>${esc([j.employer, j.location].filter(Boolean).join(" - "))}
<div class=m>${esc([j.detail, `found ${new Date(j.first_seen).toLocaleString("en-US", { timeZone: "America/Los_Angeles" })}`, j.source].filter(Boolean).join(" · "))}</div></div>`,
      )
      .join("") || "<p>No matches yet.</p>"
  }
<h2>Boards</h2>${status
    .map(
      (s: any) =>
        `<div class=m>${s.last_error_at && s.last_error_at > (s.last_ok ?? 0) ? "❌" : "✅"} <b>${esc(s.source)}</b> - ok ${ago(s.last_ok)}, ${s.last_count ?? 0} listings${s.last_error_at > (s.last_ok ?? 0) ? ` - ${esc(s.last_error ?? "")}` : ""}${s.failures ? ` - ${s.failures} failures in a row, next try ${s.next_attempt > Date.now() ? `in ${Math.ceil((s.next_attempt - Date.now()) / 60000)} min` : "next tick"}` : ""}</div>`,
    )
    .join("")}`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const authed = !!env.ADMIN_KEY && url.searchParams.get("key") === env.ADMIN_KEY;

    if (url.pathname === "/run" && authed) return Response.json(await run(env, { manual: true }));
    if (url.pathname === "/test" && authed) {
      // Goes through the notify Queue like a real alert. A fresh id each time so dedupe doesn't skip it.
      const id = `test:${Date.now()}`;
      const priority = url.searchParams.get("priority") === "2" ? 2 : 1;
      await enqueue(
        env,
        jobMessages(
          [
            {
              id,
              source: "test",
              title: "Test alert - EMT Job Watch is working",
              employer: "EMT Job Watch",
              location: HOME.label,
              url: url.origin,
            },
          ],
          { priority: () => priority },
        ),
      );
      return new Response(`queued (priority ${priority})\n`);
    }
    if (url.pathname === "/") return dashboard(env);
    return new Response("not found\n", { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: WorkerEnv): Promise<void> {
    await run(env);
  },

  async queue(batch: MessageBatch<NotifyMessage>, env: WorkerEnv): Promise<void> {
    await handleNotifyBatch(batch, env);
  },

  // announce@stovold.dev: agency interest-list emails, the early warning before a posting exists.
  async email(message: ForwardableEmailMessage, env: WorkerEnv): Promise<void> {
    const result = await handleAnnouncementEmail(message, env);
    console.log(`announce@ from ${message.from}: ${JSON.stringify(result)}`);
  },
};
