import type { WorkerEnv } from "../alchemy.run.ts";
import { cancelAnnouncements, handleAnnouncementEmail } from "./announce.ts";
import { HOME, SOURCES } from "./config.ts";
import { dashboard } from "./dashboard.ts";
import { claimAndNotify, TOUCH_EVERY_MS } from "./jobs.ts";
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

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const authed = !!env.ADMIN_KEY && url.searchParams.get("key") === env.ADMIN_KEY;

    if (url.pathname === "/run" && authed) return Response.json(await run(env, { manual: true }));
    if (url.pathname === "/announcements/cancel" && authed) {
      const id = url.searchParams.get("id");
      const announcer = url.searchParams.get("announcer");
      if (!id && !announcer) return new Response("pass ?id= or ?announcer=\n", { status: 400 });
      const cancelled = await cancelAnnouncements(env, {
        id: id ? Number(id) : undefined,
        announcer: announcer ?? undefined,
      });
      return Response.json({ cancelled });
    }
    if (url.pathname === "/test" && authed) {
      // Goes through the notify Queue like a real alert. A fresh id each time so dedupe doesn't skip it.
      const id = `test:${Date.now()}`;
      const p = Number(url.searchParams.get("priority") ?? 1);
      const priority = (p === 0 || p === 2 ? p : 1) as 0 | 1 | 2;
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

  // announce@morgannstovold.com: agency interest-list emails, the early warning before a posting exists.
  async email(message: ForwardableEmailMessage, env: WorkerEnv): Promise<void> {
    const result = await handleAnnouncementEmail(message, env);
    console.log(`announce@ from ${message.from}: ${JSON.stringify(result)}`);
  },
};
