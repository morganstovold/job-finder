// Inbound announcement emails ("Sac Fire: single-role EMT / Fire Recruit applications open 11/16 at 12:01 AM").
// Agencies email their interest lists before a posting exists, so these are the only early warning.
import * as chrono from "chrono-node";
import PostalMime from "postal-mime";

import type { WorkerEnv } from "../alchemy.run.ts";
import { ANNOUNCERS, FF_TRAINEE_EXCLUDE, PRIORITY, SOURCES, type Announcer } from "./config.ts";
import { type Category, classifyTitle } from "./filter.ts";
import { claimAndNotify } from "./jobs.ts";
export type { AnnouncementRow } from "./jobs.ts";
import { enqueue } from "./notify.ts";
import { fetchSource } from "./sources.ts";

export const TZ = "America/Los_Angeles";
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Sender allowlist: unknown senders are only forwarded. ANNOUNCE_TEST_FROM (an exact address, kept in
 * .env so it isn't committed) is accepted as a "Test" announcer with no boards linked, so a test
 * announcement can't mark a real posting "OPEN NOW".
 */
export const findAnnouncer = (from: string, env?: Pick<WorkerEnv, "ANNOUNCE_TEST_FROM">): Announcer | undefined => {
  const test = env?.ANNOUNCE_TEST_FROM?.trim().toLowerCase();
  if (test && from.trim().toLowerCase() === test) return { name: "Test", from: /$^/, sources: [] };
  return ANNOUNCERS.find((a) => a.from.test(from) && !a.notFrom?.test(from));
};

/** Strong body phrases. Plain "EMT" isn't enough ("EMT certification required" is on every FF posting). */
const BODY_EMT = /single[- ]role|EMS trainee|Fire Service EMT/i;
const BODY_FF = /fire ?fighter (trainee|recruit)|fire recruit/gi;

/** The text around a match, up to sentence boundaries. */
const sentenceAt = (text: string, index: number) => {
  const start = Math.max(text.lastIndexOf(".", index), text.lastIndexOf("\n", index)) + 1;
  const ends = [text.indexOf(".", index), text.indexOf("\n", index)].filter((i) => i >= 0);
  return text.slice(start, ends.length ? Math.min(...ends) : undefined);
};

/**
 * What an announcement is about: "emt" (single-role EMT / EMS trainee), "ff" (firefighter trainee /
 * recruit), or null (e.g. a Fire Recruit Paramedic recruitment). Subject first, then strong body phrases
 * with the same paramedic-only and lateral excludes as job titles.
 */
/** Form-submission copies and subscription confirmations: about a signup, not an opening. */
const NOT_ANNOUNCEMENT =
  /formstack submission|submitted at|signup for|sign-up for|confirm (your )?(subscription|email)|thank you for (signing up|subscribing)|you('ve| have)? (been )?(subscribed|unsubscribed)/i;

/** An announcement talks about an opening. ("recruitment", not "recruit": signup checkboxes say "Firefighter recruit".) */
const OPENING_SIGNAL =
  /\b(open|opens|opened|opening|reopen|reopens|reopening|accept|accepts|accepting|apply|applications?|recruitment|hiring|filing|vacanc(y|ies))\b/i;

export function classifyAnnouncement(subject: string, text: string): Category | null {
  if (NOT_ANNOUNCEMENT.test(`${subject}\n${text}`)) return null;
  if (!OPENING_SIGNAL.test(`${subject}\n${text}`)) return null;
  const fromSubject = classifyTitle(subject);
  if (fromSubject) return fromSubject;
  if (BODY_EMT.test(text)) return "emt";
  for (const m of text.matchAll(BODY_FF)) {
    const sentence = sentenceAt(text, m.index!);
    if (FF_TRAINEE_EXCLUDE.test(sentence)) continue;
    if (/paramedic/i.test(sentence) && !/\bEMT\b/i.test(sentence)) continue;
    return "ff";
  }
  return null;
}

export const categoryNoun = (c: Category) => (c === "ff" ? "Fire Recruit" : "single-role EMT");

/** Sentences that talk about applications opening; other dates (deadlines, the send date) are ignored. */
const OPENING = /\b(open|opens|opening|accept|accepting|begin|begins|start|starts|available|launch)/i;

const ptParts = (ms: number) =>
  Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(ms)
      .map((p) => [p.type, p.value]),
  );

/** How far Pacific time is from UTC at this instant (ms, negative: -8h PST, -7h PDT). */
const ptOffset = (ms: number) => {
  const p = ptParts(ms);
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
};

/** A Pacific wall-clock time as epoch ms, DST-aware and independent of the machine's time zone. */
export const fromPT = (year: number, month: number, day: number, hour = 0, minute = 0) => {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const guess = wall - ptOffset(wall);
  return wall - ptOffset(guess);
};

/**
 * The opening date/time, if one is stated, as epoch ms. Only future dates count. A date with no time
 * ("opens Nov 16") is taken as midnight Pacific, the earliest it could open, so reminders are never late.
 * chrono reads the wall-clock values; the Pacific conversion is done here, because chrono's own
 * `timezone` option leans on the machine's zone (Workers run in UTC).
 */
/** A date right after one of these is a closing date ("accepted through Nov 30", "closes 11/30"). */
const CLOSING_BEFORE = /\b(through|thru|until|till|by|close[sd]?|closing|deadline|due|ends?)\b/i;

export function parseOpenAt(subject: string, text: string, receivedAt: number): number | null {
  const sentences = `${subject}.\n${text}`.split(/(?<=[.!?])\s+|\n+/).filter((s) => OPENING.test(s));
  const p = ptParts(receivedAt);
  // chrono resolves "Nov 16" / "Monday" against a reference date; give it today's date in Pacific.
  const ref = new Date(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  for (const sentence of sentences) {
    const openings = [...sentence.matchAll(new RegExp(OPENING.source, "gi"))].map((m) => m.index! + m[0].length);
    // Within a sentence, prefer the date closest after an opening keyword; dates before any keyword last.
    const distance = (index: number) => {
      const before = openings.filter((o) => o <= index);
      return before.length ? index - Math.max(...before) : Number.MAX_SAFE_INTEGER;
    };
    const candidates = chrono
      .parse(sentence, ref, { forwardDate: true })
      .filter((r) => !CLOSING_BEFORE.test(sentence.slice(Math.max(0, r.index - 25), r.index)))
      .toSorted((a, b) => distance(a.index) - distance(b.index));
    for (const r of candidates) {
      const c = r.start;
      const hasTime = c.isCertain("hour");
      const at = fromPT(
        c.get("year")!,
        c.get("month")!,
        c.get("day")!,
        hasTime ? c.get("hour")! : 0,
        hasTime ? (c.get("minute") ?? 0) : 0,
      );
      if (at > receivedAt) return at;
    }
  }
  return null;
}

/** "Mon 11/16 12:01 AM" in Pacific time. */
export const fmtPT = (ms: number) => {
  const p = ptParts(ms);
  const h = +p.hour % 12 || 12;
  return `${p.weekday} ${p.month}/${p.day} ${h}:${p.minute} ${+p.hour < 12 ? "AM" : "PM"}`;
};

/** Watch an announcement until its posting shows up, or this long. */
export const watchUntil = (openAt: number | null, receivedAt: number) =>
  openAt ? openAt + 30 * DAY_MS : receivedAt + 270 * DAY_MS;

/** The `email()` handler for announce@: forward, parse, store, push, start the Workflow, check now. */
export async function handleAnnouncementEmail(message: ForwardableEmailMessage, env: WorkerEnv) {
  // Forward first: mailing lists send a "confirm your subscription" link you need to see, and nothing
  // is lost if anything below fails.
  if (env.NOTIFY_EMAIL) await message.forward(env.NOTIFY_EMAIL);

  // Nothing below may throw: an error here bounces the mail back to the agency's list server, which
  // can unsubscribe the address. The email was already forwarded, so log and move on.
  try {
    const announcer = findAnnouncer(message.from, env);
    if (!announcer) return { action: "forwarded", reason: "unknown sender" };

    const email = await PostalMime.parse(message.raw);
    const subject = email.subject ?? "";
    const text = email.text ?? (email.html ?? "").replace(/<[^>]+>/g, " ");
    const category = classifyAnnouncement(subject, text);
    if (!category) return { action: "forwarded", reason: "not relevant" };

    const receivedAt = Date.now();
    const openAt = parseOpenAt(subject, text, receivedAt);
    const row = await env.DB.prepare(
      `INSERT INTO announcements (announcer, subject, received_at, open_at, category) VALUES (?, ?, ?, ?, ?) RETURNING id`,
    )
      .bind(announcer.name, subject.slice(0, 300), receivedAt, openAt, category)
      .first<{ id: number }>();
    const id = row!.id;

    await enqueue(env, [
      {
        kind: "push",
        title: `${announcer.name}: ${categoryNoun(category)} opening announced - ${openAt ? `opens ${fmtPT(openAt)}` : "date not stated"}`,
        body: subject,
        // EMT announcements sound through quiet hours; FF recruit ones are a normal notification.
        priority: category === "ff" ? PRIORITY.ff : 1,
        dedupeKey: `announce:${id}`,
      },
    ]);

    await env.ANNOUNCE_WF.create({ id: `ann-${id}`, params: { announcementId: id } });

    // The posting may already be live: check the announcer's boards now. A match is claimed and
    // confirmed through the normal path ("OPEN NOW -").
    const sources = SOURCES.filter((s) => announcer.sources.includes(s.name));
    const found = (await Promise.allSettled(sources.map(fetchSource))).flatMap((r) =>
      r.status === "fulfilled" ? r.value : [],
    );
    await claimAndNotify(env, found, receivedAt);

    return { action: "watching", id, openAt, category };
  } catch (e) {
    console.error(`announce@ from ${message.from}: ${(e as Error)?.message ?? e}`);
    return { action: "forwarded", reason: "error", error: String((e as Error)?.message ?? e) };
  }
}

/**
 * Admin: cancel announcements (by id, or every one from an announcer, e.g. "Test"). Terminates each
 * one's Workflow so no reminders fire, then deletes the row so it leaves the dashboard.
 */
export async function cancelAnnouncements(env: WorkerEnv, by: { id?: number; announcer?: string }) {
  const { results } = await env.DB.prepare(
    `SELECT id FROM announcements WHERE (?1 IS NOT NULL AND id = ?1) OR (?2 IS NOT NULL AND announcer = ?2)`,
  )
    .bind(by.id ?? null, by.announcer ?? null)
    .all<{ id: number }>();
  for (const { id } of results) {
    try {
      await (await env.ANNOUNCE_WF.get(`ann-${id}`)).terminate();
    } catch (e) {
      // Already finished (or never started): nothing left to stop.
      console.log(`announcement ${id}: workflow not terminated: ${(e as Error)?.message ?? e}`);
    }
    await env.DB.prepare(`DELETE FROM announcements WHERE id = ?`).bind(id).run();
  }
  return results.map((r) => r.id);
}
