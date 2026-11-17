import { afterAll, beforeEach, expect, test } from "bun:test";

import { type Step, watchAnnouncement } from "./announce-watch.ts";
import { classifyAnnouncement, findAnnouncer, handleAnnouncementEmail, parseOpenAt } from "./announce.ts";
import { claimAndNotify } from "./jobs.ts";
import { memoryD1 } from "./testing/d1.ts";

// Received Tue 11/10/2026 10:00 AM PT.
const RECEIVED = Date.parse("2026-11-10T18:00:00Z");

test("opening date/time is read in Pacific time", () => {
  expect(parseOpenAt("", "Applications open 11/16/2026 at 12:01 AM.", RECEIVED)).toBe(
    Date.parse("2026-11-16T08:01:00Z"),
  );
  // Subject works too, and DST is handled (July = PDT).
  expect(parseOpenAt("Single-role EMT applications open July 4 at 9am", "", RECEIVED)).toBe(
    Date.parse("2027-07-04T16:00:00Z"),
  );
  // No time stated: midnight PT, the earliest it could open.
  expect(parseOpenAt("", "The recruitment will open on November 20.", RECEIVED)).toBe(
    Date.parse("2026-11-20T08:00:00Z"),
  );
});

test("closing dates are not taken as the opening date", () => {
  expect(parseOpenAt("", "Applications will be accepted through November 30.", RECEIVED)).toBeNull();
  expect(parseOpenAt("", "The filing period closes 11/30; applications open Monday 11/16 at 12:01 AM.", RECEIVED)).toBe(
    Date.parse("2026-11-16T08:01:00Z"),
  );
  expect(parseOpenAt("", "Applications open 11/16 at 8 AM and are due by 11/30.", RECEIVED)).toBe(
    Date.parse("2026-11-16T16:00:00Z"),
  );
});

test("no stated date, past dates, and non-opening dates give null", () => {
  expect(parseOpenAt("", "A single role EMT recruitment is expected to open in spring.", RECEIVED)).toBeNull();
  expect(parseOpenAt("", "Applications opened 11/1/2026 at 8 AM.", RECEIVED)).toBeNull();
  expect(parseOpenAt("", "The filing deadline is 12/1/2026. Sent 11/10/2026.", RECEIVED)).toBeNull();
});

test("announcement category: single-role EMT, firefighter recruit, or not relevant", () => {
  expect(classifyAnnouncement("Single Role EMT recruitment opening soon", "")).toBe("emt");
  expect(classifyAnnouncement("EMS Trainee program", "")).toBe("emt");
  expect(classifyAnnouncement("Hiring update", "Our Fire Service EMT recruitment opens 12/1.")).toBe("emt");
  expect(classifyAnnouncement("Firefighter Recruit recruitment", "Applications open 12/1.")).toBe("ff");
  expect(classifyAnnouncement("Hiring update", "The Fire Recruit (EMT) recruitment opens 12/1.")).toBe("ff");
  expect(classifyAnnouncement("Fire Recruit Paramedic", "Fire Recruit (Paramedic) applications open 12/1.")).toBeNull();
  expect(classifyAnnouncement("Hiring update", "Lateral Firefighter Recruit applications open 12/1.")).toBeNull();
  // Plain "EMT" in the body isn't enough: every firefighter posting says this.
  expect(classifyAnnouncement("Hiring update", "EMT certification required. Apply by 12/1.")).toBeNull();
});

test("sender allowlist", () => {
  expect(findAnnouncer("SacFireRecruitment@cityofsacramento.org")?.name).toBe("Sac City Fire");
  expect(findAnnouncer("hr@cityofsacramento.gov")?.name).toBe("Sac City Fire");
  expect(findAnnouncer("news@example.com")).toBeUndefined();
});

// ── handler + confirmation + workflow, against an in-memory D1 and fake bindings ──

let db: ReturnType<typeof memoryD1>;
let queued: any[] = [];
let forwarded: string[] = [];
let workflows: { created: any[]; events: any[] } = { created: [], events: [] };
let sacJobs: any[] = [];

const env = () =>
  ({
    DB: db.DB,
    NOTIFY: { sendBatch: async (m: any[]) => void queued.push(...m.map((x) => x.body)) },
    NOTIFY_EMAIL: "me@example.com",
    DASHBOARD_URL: "https://jobs.example",
    REMINDER_OFFSETS_MIN: "",
    ANNOUNCE_WF: {
      create: async (o: any) => void workflows.created.push(o),
      get: async (id: string) => ({ sendEvent: async (e: any) => void workflows.events.push({ id, ...e }) }),
    },
  }) as any;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string) => {
  // The Sac City Fire agency page (governmentjobs.com), as a list of <li> items.
  if (String(url).includes("agency=saccity")) {
    return new Response(
      sacJobs
        .map(
          (j) =>
            `<li class="list-item" data-job-id="${j.id}"><h3><a class="item-details-link" href="/careers/saccity/jobs/${j.id}/x">${j.title}</a></h3><ul class="list-meta"><li>Sacramento, CA</li></ul></li>`,
        )
        .join(""),
    );
  }
  throw new Error(`unexpected fetch ${url}`);
}) as any;
afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  db = memoryD1();
  queued = [];
  forwarded = [];
  workflows = { created: [], events: [] };
  sacJobs = [];
});

const email = (from: string, subject: string, text: string) =>
  ({
    from,
    raw: new Response(`From: ${from}\r\nTo: announce@morgannstovold.com\r\nSubject: ${subject}\r\n\r\n${text}\r\n`)
      .body,
    forward: async (to: string) => void forwarded.push(to),
  }) as any;

test("an allowlisted announcement is forwarded, stored, pushed, and watched", async () => {
  const result = await handleAnnouncementEmail(
    email(
      "SacFireRecruitment@cityofsacramento.org",
      "Single Role EMT Recruitment",
      "Applications for Single Role EMT open 12/16/2099 at 12:01 AM. Positions fill quickly.",
    ),
    env(),
  );
  expect(forwarded).toEqual(["me@example.com"]);
  expect(result.action).toBe("watching");
  const row = db.sqlite.query(`SELECT announcer, open_at, status FROM announcements`).get() as any;
  expect(row).toEqual({ announcer: "Sac City Fire", open_at: Date.parse("2099-12-16T08:01:00Z"), status: "watching" });
  expect(queued.map((m) => [m.kind, m.priority, m.title])).toEqual([
    ["push", 1, "Sac City Fire: single-role EMT opening announced - opens Wed 12/16 12:01 AM"],
  ]);
  expect(workflows.created).toEqual([{ id: "ann-1", params: { announcementId: 1 } }]);
});

test("unknown sender or irrelevant email is only forwarded", async () => {
  await handleAnnouncementEmail(email("news@example.com", "Single role EMT!", "opens 12/1"), env());
  await handleAnnouncementEmail(
    email("hr@cityofsacramento.org", "Fire Recruit Paramedic", "Fire Recruit (Paramedic) opens 12/1/2099."),
    env(),
  );
  expect(forwarded).toHaveLength(2);
  expect(db.sqlite.query(`SELECT COUNT(*) AS n FROM announcements`).get()).toEqual({ n: 0 });
  expect(queued).toEqual([]);
});

test("if the posting is already live, the email confirms it right away at priority 2", async () => {
  sacJobs = [{ id: 777, title: "Sacramento Fire Emergency Medical Technician" }];
  await handleAnnouncementEmail(
    email("hr@cityofsacramento.org", "Single Role EMT applications are open now", "Apply today."),
    env(),
  );
  const pushes = queued.filter((m) => m.kind === "push").map((m) => [m.priority, m.title, m.url ?? ""]);
  expect(pushes).toEqual([
    [1, "Sac City Fire: single-role EMT opening announced - date not stated", ""],
    [
      2,
      "OPEN NOW - EMT: Sac City Fire - Sacramento Fire Emergency Medical Technician",
      "https://www.governmentjobs.com/careers/saccity/jobs/777/x",
    ],
  ]);
  expect(db.sqlite.query(`SELECT status, job_id FROM announcements`).get()).toEqual({
    status: "confirmed",
    job_id: "neogov:777",
  });
  expect(workflows.events).toEqual([{ id: "ann-1", type: "posting-confirmed", payload: { jobId: "neogov:777" } }]);
});

test("a cron-found job from another board doesn't confirm a Sac City announcement", async () => {
  db.sqlite.exec(`INSERT INTO announcements (announcer, subject, received_at) VALUES ('Sac City Fire', 's', 1)`);
  await claimAndNotify(
    env(),
    [{ id: "gmr:1", source: "AMR / GMR", title: "EMT", employer: "AMR", location: "Concord", url: "u" }],
    Date.now(),
  );
  expect(queued.find((m) => m.kind === "push").title).toBe("EMT: AMR - EMT");
  expect(workflows.events).toEqual([]);
});

// ── the Workflow's steps, with a fake step that records sleeps and resolves events ──

const fakeStep = (event?: { jobId: string }) => {
  const log: string[] = [];
  const step: Step = {
    do: async (name, fn) => {
      const r = await fn();
      log.push(`do ${name}${typeof r === "string" ? `=${r}` : ""}`);
      return r;
    },
    sleepUntil: async (name, at) => void log.push(`sleep ${name} ${new Date(at).toISOString()}`),
    waitForEvent: async (name, o) => {
      log.push(`wait ${name} ${Math.round(o.timeout / 86_400_000)}d`);
      if (!event) throw new Error("timed out");
      return { payload: event } as any;
    },
  };
  return { step, log };
};

const insertAnnouncement = (openAt: number | null) =>
  db.sqlite
    .query(`INSERT INTO announcements (announcer, subject, received_at, open_at) VALUES (?, ?, ?, ?) RETURNING id`)
    .get("Sac City Fire", "Single Role EMT", RECEIVED, openAt) as { id: number };

test("workflow: reminders at 24h, 3h and 10m, then confirmed", async () => {
  const { id } = insertAnnouncement(Date.parse("2026-11-16T08:01:00Z"));
  const { step, log } = fakeStep({ jobId: "neogov:5" });
  expect(await watchAnnouncement(env(), id, step)).toBe("confirmed");
  expect(log).toEqual([
    "do load",
    "sleep until-1440m 2026-11-15T08:01:00.000Z",
    "do remind-1440m=sent",
    "sleep until-180m 2026-11-16T05:01:00.000Z",
    "do remind-180m=sent",
    "sleep until-10m 2026-11-16T07:51:00.000Z",
    "do remind-10m=sent",
    "wait posting-confirmed 30d",
    "do confirm=confirmed",
  ]);
  expect(queued.map((m) => [m.priority, m.title, m.dedupeKey])).toEqual([
    [1, "Sac City Fire: single-role EMT opens in 24 hours (Mon 11/16 12:01 AM) - application ready?", "remind:1:1440m"],
    [1, "Sac City Fire: single-role EMT opens in 3 hours (Mon 11/16 12:01 AM) - application ready?", "remind:1:180m"],
    [2, "Sac City Fire: single-role EMT opens in 10 minutes (Mon 11/16 12:01 AM) - get ready to apply", "remind:1:10m"],
  ]);
  expect(db.sqlite.query(`SELECT status, job_id FROM announcements`).get()).toEqual({
    status: "confirmed",
    job_id: "neogov:5",
  });
});

test("workflow: an email that arrives late only gets the reminders still ahead", async () => {
  // Arrives 20 minutes before opening: only the 10-minute reminder is still in the future.
  const { id } = insertAnnouncement(RECEIVED + 20 * 60_000);
  const { step, log } = fakeStep({ jobId: "x" });
  await watchAnnouncement(env(), id, step);
  expect(log.filter((l) => l.startsWith("do remind"))).toEqual(["do remind-10m=sent"]);
});

test("workflow: no date stated waits 270 days, then expires", async () => {
  const { id } = insertAnnouncement(null);
  const { step, log } = fakeStep();
  expect(await watchAnnouncement(env(), id, step)).toBe("expired");
  expect(log).toEqual(["do load", "wait posting-confirmed 270d", "do expire=expired"]);
  expect(queued).toEqual([]);
});

test("workflow: confirmed while sleeping, so later reminders are skipped", async () => {
  const { id } = insertAnnouncement(Date.parse("2026-11-16T08:01:00Z"));
  db.sqlite.exec(`UPDATE announcements SET status = 'confirmed', job_id = 'neogov:9' WHERE id = ${id}`);
  const { step, log } = fakeStep({ jobId: "neogov:9" });
  await watchAnnouncement(env(), id, step);
  expect(log.filter((l) => l.startsWith("do remind"))).toEqual([
    "do remind-1440m=skipped",
    "do remind-180m=skipped",
    "do remind-10m=skipped",
  ]);
  expect(queued).toEqual([]);
});

test("workflow: REMINDER_OFFSETS_MIN overrides the list (any order, any count)", async () => {
  const { id } = insertAnnouncement(RECEIVED + 2 * 3_600_000);
  const { step, log } = fakeStep({ jobId: "x" });
  await watchAnnouncement({ ...env(), REMINDER_OFFSETS_MIN: "30,90,10" }, id, step);
  expect(log.filter((l) => l.startsWith("sleep"))).toEqual([
    "sleep until-90m 2026-11-10T18:30:00.000Z",
    "sleep until-30m 2026-11-10T19:30:00.000Z",
    "sleep until-10m 2026-11-10T19:50:00.000Z",
  ]);
  // Priority 2 only within an hour of opening.
  expect(queued.map((m) => m.priority)).toEqual([1, 2, 2]);
});

test("errors after forwarding are logged, not thrown (a bounce could unsubscribe the address)", async () => {
  const broken = { ...env(), NOTIFY: { sendBatch: async () => Promise.reject(new Error("queue down")) } };
  const result = await handleAnnouncementEmail(
    email("hr@cityofsacramento.org", "Single Role EMT Recruitment", "Applications open 12/16/2099 at 9 AM."),
    broken,
  );
  expect(forwarded).toEqual(["me@example.com"]);
  expect(result).toMatchObject({ action: "forwarded", reason: "error", error: "queue down" });
});

test("a firefighter recruit announcement is stored as ff and only an ff posting confirms it", async () => {
  sacJobs = [
    { id: 801, title: "Sacramento Fire Emergency Medical Technician" },
    { id: 802, title: "Fire Recruit (EMT)" },
  ];
  const result = await handleAnnouncementEmail(
    email("hr@cityofsacramento.org", "Fire Recruit Recruitment", "Fire Recruit applications are open now."),
    env(),
  );
  expect(result).toMatchObject({ action: "watching", category: "ff" });
  const pushes = queued.filter((m) => m.kind === "push").map((m) => m.title);
  expect(pushes).toEqual([
    "Sac City Fire: Fire Recruit opening announced - date not stated",
    "EMT: Sac City Fire - Sacramento Fire Emergency Medical Technician", // not the announced kind: normal alert
    "OPEN NOW - FF Recruit: Sac City Fire - Fire Recruit (EMT)",
  ]);
  expect(db.sqlite.query(`SELECT category, status, job_id FROM announcements`).get()).toEqual({
    category: "ff",
    status: "confirmed",
    job_id: "neogov:802",
  });
});
