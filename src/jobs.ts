import type { WorkerEnv } from "../alchemy.run.ts";
import { ANNOUNCERS } from "./config.ts";
import { categorize } from "./filter.ts";
import { enqueue, jobMessages } from "./notify.ts";
import type { Job } from "./types.ts";

/** "Still listed" timestamps only need refreshing this often (saves D1 writes at one run a minute). */
export const TOUCH_EVERY_MS = 10 * 60_000;

/** A job that disappears for this long and comes back is alerted again. */
const REALERT_AFTER_MS = 24 * 60 * 60 * 1000;

export interface AnnouncementRow {
  id: number;
  announcer: string;
  subject: string;
  received_at: number;
  open_at: number | null;
  category: "emt" | "ff";
  status: "watching" | "confirmed" | "expired";
  job_id: string | null;
}

/** Announcements still waiting for their posting. */
export async function watchingAnnouncements(env: WorkerEnv) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM announcements WHERE status = 'watching' ORDER BY id`,
  ).all<AnnouncementRow>();
  return results;
}

/** Mark an announcement confirmed by a scraped posting and wake its Workflow. */
export async function confirmAnnouncement(env: WorkerEnv, row: AnnouncementRow, jobId: string) {
  await env.DB.prepare(`UPDATE announcements SET status = 'confirmed', job_id = ? WHERE id = ? AND status = 'watching'`)
    .bind(jobId, row.id)
    .run();
  try {
    const instance = await env.ANNOUNCE_WF.get(`ann-${row.id}`);
    await instance.sendEvent({ type: "posting-confirmed", payload: { jobId } });
  } catch (e) {
    console.error(`announcement ${row.id}: couldn't signal its workflow: ${(e as Error)?.message ?? e}`);
  }
}

/**
 * Filter fetched jobs to EMT matches, claim the new ones, and enqueue their alerts. A new job from a
 * board an announcement is watching is the posting it announced: alert as "OPEN NOW -" (at its job type's priority)
 * and confirm the announcement. `extra` statements (board status) ride in the same D1 batch.
 */
export async function claimAndNotify(env: WorkerEnv, jobs: Job[], now: number, extra: D1PreparedStatement[] = []) {
  // The same posting can show up on two boards (e.g. SFFD on SmartRecruiters + CalOpps) - those have
  // different ids, which is fine: you'd rather hear twice than miss one.
  const matched = jobs.map(categorize).filter((j) => j !== null);
  const unique = [...new Map(matched.map((j) => [j.id, j])).values()];

  // Claim new jobs atomically: INSERT … RETURNING only returns a row to the run that actually inserted
  // (or revived) it, so two overlapping runs (a slow board at one run a minute) can't both alert one job.
  // Re-alert rule: a job unseen for 24h+ that shows up again (a reposted recruitment, same id) counts
  // as new - first_seen resets and it alerts again.
  const claim = env.DB.prepare(
    `INSERT INTO jobs (id, source, title, employer, location, url, posted_at, detail, first_seen, last_seen, category)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?10)
     ON CONFLICT (id) DO UPDATE SET first_seen = ?9, last_seen = ?9, title = ?3, url = ?6, category = ?10
       WHERE jobs.last_seen < ?9 - ${REALERT_AFTER_MS}
     RETURNING id`,
  );
  const touch = env.DB.prepare(`UPDATE jobs SET last_seen = ?2, title = ?3, url = ?4 WHERE id = ?1 AND last_seen < ?5`);
  const statements = [
    ...unique.map((j) =>
      claim.bind(
        j.id,
        j.source,
        j.title,
        j.employer,
        j.location,
        j.url,
        j.postedAt ?? null,
        j.detail ?? null,
        now,
        j.category,
      ),
    ),
    ...unique.map((j) => touch.bind(j.id, now, j.title, j.url, now - TOUCH_EVERY_MS)),
    ...extra,
  ];
  const batch = statements.length ? await env.DB.batch(statements) : [];
  const fresh = unique.filter((_, i) => (batch[i]?.results?.length ?? 0) > 0);
  if (!fresh.length) return { unique, fresh };

  const watching = await watchingAnnouncements(env);
  // A fresh job confirms an announcement only if it's on that agency's board and the same kind of job.
  const announcementFor = (j: Job) =>
    watching.find(
      (a) => a.category === j.category && ANNOUNCERS.find((x) => x.name === a.announcer)?.sources.includes(j.source),
    );
  const opened = fresh.filter(announcementFor);
  const regular = fresh.filter((j) => !announcementFor(j));

  // If the alerts can't be queued, un-claim these jobs so the next run claims (and alerts) them again,
  // instead of them being marked seen with no alert ever sent.
  try {
    await enqueue(env, [
      ...jobMessages(regular, { claimedAt: now }),
      ...jobMessages(opened, { prefix: "OPEN NOW - ", claimedAt: now }),
    ]);
  } catch (e) {
    await env.DB.prepare(`DELETE FROM jobs WHERE id IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(fresh.map((j) => j.id)))
      .run();
    throw e;
  }
  const confirmed = new Set<number>();
  for (const j of opened) {
    const row = announcementFor(j)!;
    if (confirmed.has(row.id)) continue;
    confirmed.add(row.id);
    await confirmAnnouncement(env, row, j.id);
  }
  return { unique, fresh };
}
