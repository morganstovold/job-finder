// The steps of AnnouncementWorkflow, kept free of `cloudflare:workers` so they can be tested with a fake
// `step`. Each step.do is idempotent: it reads the row first, and reminders carry a dedupe key.
import type { WorkerEnv } from "../alchemy.run.ts";
import { fmtPT } from "./announce.ts";
import { EMERGENCY_WITHIN_MIN, REMINDERS_MIN } from "./config.ts";
import type { AnnouncementRow } from "./jobs.ts";
import { enqueue } from "./notify.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The subset of WorkflowStep this uses. */
export interface Step {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  sleepUntil(name: string, at: number): Promise<void>;
  waitForEvent<T>(name: string, opts: { type: string; timeout: number }): Promise<{ payload: T }>;
}

/** Reminder offsets in minutes, largest first: REMINDER_OFFSETS_MIN if set, else REMINDERS_MIN. */
export const reminderOffsets = (env: WorkerEnv) => {
  const fromEnv = (env.REMINDER_OFFSETS_MIN || "")
    .split(",")
    .map(Number)
    .filter((n) => n > 0);
  return [...new Set(fromEnv.length ? fromEnv : REMINDERS_MIN)].toSorted((a, b) => b - a);
};

/** This announcement's reminders: those still in the future when the email arrived. */
export const remindersFor = (env: WorkerEnv, row: Pick<AnnouncementRow, "open_at" | "received_at">) =>
  row.open_at
    ? reminderOffsets(env)
        .map((minutes) => ({ minutes, at: row.open_at! - minutes * 60_000 }))
        .filter((r) => r.at > row.received_at)
    : [];

/** "24 hours", "3 hours", "90 minutes", "5 minutes". */
const inWords = (minutes: number) =>
  minutes >= 60 && minutes % 60 === 0
    ? `${minutes / 60} hour${minutes === 60 ? "" : "s"}`
    : `${minutes} minute${minutes === 1 ? "" : "s"}`;

const readRow = (env: WorkerEnv, id: number) =>
  env.DB.prepare(`SELECT * FROM announcements WHERE id = ?`).bind(id).first<AnnouncementRow>();

/** Skips once the posting is confirmed; a repeated step re-enqueues the same dedupe key, so no double push. */
async function remind(env: WorkerEnv, id: number, minutes: number) {
  const row = await readRow(env, id);
  if (!row || row.status !== "watching" || !row.open_at) return "skipped";
  const urgent = minutes <= EMERGENCY_WITHIN_MIN;
  await enqueue(env, [
    {
      kind: "push",
      title: `${row.announcer}: single-role EMT opens in ${inWords(minutes)} (${fmtPT(row.open_at)}) - ${urgent ? "get ready to apply" : "application ready?"}`,
      body: row.subject,
      priority: urgent ? 2 : 1,
      dedupeKey: `remind:${id}:${minutes}m`,
    },
  ]);
  return "sent";
}

/**
 * Sleep to each reminder time and push (see REMINDERS_MIN), then wait for the scraper's
 * "posting-confirmed" event, up to 30 days after opening (270 days after receipt when no date was
 * stated). Timeout = expired.
 */
export async function watchAnnouncement(env: WorkerEnv, id: number, step: Step) {
  const row = await step.do("load", () => readRow(env, id));
  if (!row) return "missing";
  const reminders = remindersFor(env, row);

  for (const r of reminders) {
    await step.sleepUntil(`until-${r.minutes}m`, r.at);
    await step.do(`remind-${r.minutes}m`, () => remind(env, id, r.minutes));
  }

  // Measured from when the wait starts: the last reminder, or receipt.
  const start = reminders.at(-1)?.at ?? row.received_at;
  const timeout = row.open_at ? row.open_at + 30 * DAY_MS - start : 270 * DAY_MS;
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
