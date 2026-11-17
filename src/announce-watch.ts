// The steps of AnnouncementWorkflow, kept free of `cloudflare:workers` so they can be tested with a fake
// `step`. Each step.do is idempotent: it reads the row first and skips work that's already done.
import type { WorkerEnv } from "../alchemy.run.ts";
import { fmtPT } from "./announce.ts";
import type { AnnouncementRow } from "./jobs.ts";
import { enqueue } from "./notify.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The subset of WorkflowStep this uses. */
export interface Step {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  sleepUntil(name: string, at: number): Promise<void>;
  waitForEvent<T>(name: string, opts: { type: string; timeout: number }): Promise<{ payload: T }>;
}

/**
 * Reminder offsets before opening, in minutes: "24h,1h" by default. REMINDER_OFFSETS_MIN overrides them
 * for testing, e.g. "90,30" to see both reminders on an announcement ~2 hours out.
 */
export const reminderOffsets = (env: WorkerEnv) => {
  const [day = 1440, hour = 60] = (env.REMINDER_OFFSETS_MIN || "1440,60").split(",").map(Number);
  return { dayMs: day * 60_000, hourMs: hour * 60_000 };
};

const readRow = (env: WorkerEnv, id: number) =>
  env.DB.prepare(`SELECT * FROM announcements WHERE id = ?`).bind(id).first<AnnouncementRow>();

async function remind(env: WorkerEnv, id: number, which: "24h" | "1h") {
  const row = await readRow(env, id);
  const flag = which === "24h" ? "reminded_24h" : "reminded_1h";
  if (!row || row.status !== "watching" || row[flag] || !row.open_at) return "skipped";
  await enqueue(env, [
    which === "24h"
      ? {
          kind: "push",
          title: `${row.announcer}: single-role EMT opens ${fmtPT(row.open_at)} - application ready?`,
          body: row.subject,
          priority: 1,
          dedupeKey: `remind-24h:${id}`,
        }
      : {
          kind: "push",
          title: `${row.announcer}: single-role EMT opens ${fmtPT(row.open_at)} - get ready to apply`,
          body: row.subject,
          priority: 2,
          dedupeKey: `remind-1h:${id}`,
        },
  ]);
  await env.DB.prepare(`UPDATE announcements SET ${flag} = 1 WHERE id = ?`).bind(id).run();
  return "sent";
}

/**
 * Sleep to 24h before opening (if it's further out) and remind; sleep to 1h before and remind at
 * emergency priority; then wait for the scraper's "posting-confirmed" event, up to 30 days after
 * opening (270 days after receipt when no date was stated). Timeout = expired.
 */
export async function watchAnnouncement(env: WorkerEnv, id: number, step: Step) {
  const row = await step.do("load", () => readRow(env, id));
  if (!row) return "missing";
  const { dayMs, hourMs } = reminderOffsets(env);

  if (row.open_at && row.open_at - dayMs > row.received_at) {
    await step.sleepUntil("until-24h", row.open_at - dayMs);
    await step.do("remind-24h", () => remind(env, id, "24h"));
  }
  if (row.open_at) {
    await step.sleepUntil("until-1h", row.open_at - hourMs);
    await step.do("remind-1h", () => remind(env, id, "1h"));
  }

  // Measured from when the wait starts: ~1h before opening, or right after receipt with no date.
  const timeout = row.open_at ? 30 * DAY_MS + hourMs : 270 * DAY_MS;
  try {
    const event = await step.waitForEvent<{ jobId: string }>("posting-confirmed", {
      type: "posting-confirmed",
      timeout,
    });
    await step.do("confirm", () =>
      env.DB.prepare(`UPDATE announcements SET status = 'confirmed', job_id = COALESCE(job_id, ?) WHERE id = ?`)
        .bind(event.payload.jobId, id)
        .run()
        .then(() => "confirmed"),
    );
    return "confirmed";
  } catch {
    // waitForEvent throws on timeout.
    await step.do("expire", () =>
      env.DB.prepare(`UPDATE announcements SET status = 'expired' WHERE id = ? AND status = 'watching'`)
        .bind(id)
        .run()
        .then(() => "expired"),
    );
    return "expired";
  }
}
