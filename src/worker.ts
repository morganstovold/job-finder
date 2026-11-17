import type { WorkerEnv } from "../alchemy.run.ts";
import { HOME, SOURCES } from "./config.ts";
import { isMatch } from "./filter.ts";
import { notifyNewJobs, sendEmail, sendPush } from "./notify.ts";
import { fetchSource } from "./sources.ts";
import type { Job } from "./types.ts";

/** Alert once if a board has been failing for this long (scrapers break silently). */
const BROKEN_AFTER_MS = 6 * 60 * 60 * 1000;

/**
 * Exponential backoff after consecutive failures (e.g. a board rate-limiting us with 403s):
 * 1 failure → retry next tick (10 min), 2 → 20, 3 → 40, 4+ → 60. One success resets it.
 */
export const backoffMs = (failures: number) => Math.min(10 * 2 ** (failures - 1), 60) * 60_000;

type Status = {
  source: string;
  last_ok: number | null;
  alerted: number;
  failures: number;
  next_attempt: number | null;
};

async function run(env: WorkerEnv, { manual = false } = {}) {
  const now = Date.now();
  const status = new Map(
    (
      await env.DB.prepare(`SELECT source, last_ok, alerted, failures, next_attempt FROM source_status`).all<Status>()
    ).results.map((s) => [s.source, s]),
  );
  // Cron ticks land a few seconds early or late, so allow a minute of slack. Manual /run checks everything.
  const sources = SOURCES.filter((s) => manual || (status.get(s.name)?.next_attempt ?? 0) <= now + 60_000);
  const results = await Promise.allSettled(sources.map(fetchSource));

  const matches: Job[] = [];
  const statusWrites: D1PreparedStatement[] = [];
  const broken: string[] = [];

  for (const [i, r] of results.entries()) {
    const name = sources[i].name;
    if (r.status === "fulfilled") {
      matches.push(...r.value.filter(isMatch));
      statusWrites.push(
        env.DB.prepare(
          `INSERT INTO source_status (source, last_ok, last_count, alerted, failures, next_attempt)
           VALUES (?1, ?2, ?3, 0, 0, NULL)
           ON CONFLICT (source) DO UPDATE SET last_ok = ?2, last_count = ?3, alerted = 0, failures = 0, next_attempt = NULL`,
        ).bind(name, now, r.value.length),
      );
    } else {
      const msg = String(r.reason?.message ?? r.reason).slice(0, 500);
      const prev = status.get(name);
      const failures = (prev?.failures ?? 0) + 1;
      const retryAt = now + backoffMs(failures);
      console.error(`${name} failed (${failures}x, retry in ${backoffMs(failures) / 60_000} min): ${msg}`);
      // ~6h of failures: measured from the last success, or by count (8 ≈ 6h of backoff) for a board that never worked.
      const longBroken = prev?.last_ok ? now - prev.last_ok > BROKEN_AFTER_MS : failures >= 8;
      const shouldAlert = !prev?.alerted && longBroken;
      if (shouldAlert) broken.push(`${name}: ${msg}`);
      statusWrites.push(
        env.DB.prepare(
          `INSERT INTO source_status (source, last_error, last_error_at, alerted, failures, next_attempt)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)
           ON CONFLICT (source) DO UPDATE SET last_error = ?2, last_error_at = ?3,
             alerted = MAX(alerted, ?4), failures = ?5, next_attempt = ?6`,
        ).bind(name, msg, now, shouldAlert ? 1 : 0, failures, retryAt),
      );
    }
  }

  // The same posting can show up on two boards (e.g. SFFD on SmartRecruiters + CalOpps) - those have
  // different ids, which is fine: you'd rather hear twice than miss one.
  const unique = [...new Map(matches.map((j) => [j.id, j])).values()];
  const known = new Set(
    unique.length
      ? (
          await env.DB.prepare(`SELECT id FROM jobs WHERE id IN (SELECT value FROM json_each(?))`)
            .bind(JSON.stringify(unique.map((j) => j.id)))
            .all<{ id: string }>()
        ).results.map((r) => r.id)
      : [],
  );
  const fresh = unique.filter((j) => !known.has(j.id));

  const upsert = env.DB.prepare(
    `INSERT INTO jobs (id, source, title, employer, location, url, posted_at, detail, first_seen, last_seen)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
     ON CONFLICT (id) DO UPDATE SET last_seen = ?9, title = ?3, url = ?6`,
  );
  await env.DB.batch([
    ...statusWrites,
    ...unique.map((j) =>
      upsert.bind(j.id, j.source, j.title, j.employer, j.location, j.url, j.postedAt ?? null, j.detail ?? null, now),
    ),
  ]);

  if (fresh.length) await notifyNewJobs(env, fresh);
  if (broken.length) {
    const body = `These job boards have been failing for 6+ hours - the scraper probably needs a fix:\n\n${broken.join("\n")}`;
    await Promise.allSettled([
      sendEmail(env, "EMT Job Watch: a job board stopped working", body, `<pre>${body}</pre>`),
      sendPush(env, "Job board scraper broken", broken.join("\n")),
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
  const [{ results: jobs }, { results: status }] = await Promise.all([
    env.DB.prepare(`SELECT * FROM jobs WHERE last_seen > ? ORDER BY first_seen DESC LIMIT 100`).bind(since).all<any>(),
    env.DB.prepare(`SELECT * FROM source_status ORDER BY source`).all<any>(),
  ]);
  const html = `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>EMT Job Watch</title>
<style>body{font:15px system-ui,sans-serif;max-width:720px;margin:24px auto;padding:0 16px;color:#111;background:#fff}
@media(prefers-color-scheme:dark){body{color:#eee;background:#111}a{color:#8ab4ff}}
.j{padding:10px 0;border-top:1px solid #8884}.m{color:#888;font-size:13px}.gone{opacity:.45}</style>
<h1>EMT Job Watch</h1><p class=m>EMT-B jobs within ${HOME.radiusMiles} mi of ${HOME.label}. Faded = no longer listed.</p>
${
  jobs
    .map(
      (j: any) => `<div class="j ${Date.now() - j.last_seen > 60 * 60 * 1000 ? "gone" : ""}">
<a href="${esc(j.url)}"><b>${esc(j.title)}</b></a><br>${esc([j.employer, j.location].filter(Boolean).join(" - "))}
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
      await notifyNewJobs(env, [
        {
          id: "test",
          source: "test",
          title: "Test alert - EMT Job Watch is working",
          employer: "EMT Job Watch",
          location: HOME.label,
          url: url.origin,
        },
      ]);
      return new Response("sent\n");
    }
    if (url.pathname === "/") return dashboard(env);
    return new Response("not found\n", { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: WorkerEnv): Promise<void> {
    await run(env);
  },
};
