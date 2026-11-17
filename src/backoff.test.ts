import { afterAll, beforeEach, expect, setSystemTime, test } from "bun:test";

import { SOURCES } from "./config.ts";
import { memoryD1 } from "./testing/d1.ts";
import worker, { backoffMs } from "./worker.ts";

test("backoff scales from each board's pace", () => {
  expect([1, 2, 3, 4, 9].map((n) => backoffMs(n) / 60_000)).toEqual([1, 2, 4, 8, 60]);
  expect([1, 2, 3, 4, 5, 9].map((n) => backoffMs(n, 5) / 60_000)).toEqual([5, 10, 20, 40, 60, 60]);
});

let db: ReturnType<typeof memoryD1>;
let queued: any[] = [];
const env: any = {
  get DB() {
    return db.DB;
  },
  EMAIL: { send: async () => ({}) },
  NOTIFY: { sendBatch: async (msgs: { body: any }[]) => void queued.push(...msgs.map((m) => m.body)) },
  NOTIFY_DLQ_NAME: "notify-dlq",
  NOTIFY_EMAIL: "me@example.com",
  FROM_EMAIL: "jobs@example.com",
  PUSHOVER_TOKEN: "",
  PUSHOVER_USER: "",
  DASHBOARD_URL: "",
};

// Which boards each tick hit, and what they return.
let hits: Record<string, number[]> = {};
let falckDown = true;
let gmrJobs: any[] = [];
let minute = 0;
const hit = (board: string) => (hits[board] ??= []).push(minute);

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string) => {
  const url = String(input);
  if (url.includes("onshift")) {
    hit("falck");
    return falckDown ? new Response("Forbidden", { status: 403 }) : Response.json([]);
  }
  if (url.includes("gmr.net")) {
    hit("gmr");
    return Response.json({ totalCount: gmrJobs.length, jobs: gmrJobs });
  }
  if (url.includes("calopps")) hit("calopps");
  if (url.includes("smartrecruiters")) return Response.json({ content: [] });
  return new Response("");
}) as any;

beforeEach(() => {
  db = memoryD1();
  hits = {};
  queued = [];
  falckDown = true;
  gmrJobs = [];
});
afterAll(() => {
  globalThis.fetch = realFetch;
  setSystemTime();
});

const tick = async (m: number) => {
  minute = m;
  // Real cron ticks arrive a few seconds late.
  setSystemTime(new Date(Date.UTC(2026, 10, 17, 17, 0) + m * 60_000 + 3_000));
  await worker.scheduled({} as any, env);
};

test("every-minute boards run each tick; Falck/CalOpps keep their 5-minute pace", async () => {
  falckDown = false;
  for (let m = 0; m <= 20; m++) await tick(m);
  expect(hits.gmr).toEqual(Array.from({ length: 21 }, (_, i) => i));
  expect(hits.falck).toEqual([0, 5, 10, 15, 20]);
  expect(hits.calopps).toEqual([0, 5, 10, 15, 20]);
});

test("failing Falck backs off 5 → 10 → 20 → 40 → 60 min, then returns to its pace", async () => {
  for (let m = 0; m <= 140; m++) await tick(m);
  // Fails at 0 → +5 → 5 → +10 → 15 → +20 → 35 → +40 → 75 → +60 → 135
  expect(hits.falck).toEqual([0, 5, 15, 35, 75, 135]);
  expect(hits.gmr.length).toBe(141); // healthy boards never skipped

  falckDown = false;
  for (let m = 141; m <= 205; m++) await tick(m);
  expect(hits.falck.slice(6)).toEqual([195, 200, 205]);
  const s = db.sqlite.query(`SELECT failures FROM source_status WHERE source = 'Falck NorCal'`).get() as any;
  expect(s.failures).toBe(0);
});

test("a new job alerts exactly once, even across overlapping runs", async () => {
  gmrJobs = [
    {
      data: {
        req_id: 999,
        title: "EMT - 911 Full Time",
        city: "Concord",
        state: "California",
        latitude: 37.978,
        longitude: -122.031,
        posted_date: "2026-11-17T17:00:00+0000",
        tags2: ["AMR"],
      },
    },
  ];
  setSystemTime(new Date(Date.UTC(2026, 10, 17, 17, 0, 3)));
  // Two runs at once (e.g. a slow tick overlapping the next one).
  await Promise.all([worker.scheduled({} as any, env), worker.scheduled({} as any, env)]);
  await tick(1);
  await tick(2);
  // One push (AMR = priority 2) + one email, enqueued once despite the overlapping runs.
  expect(queued.map((m) => [m.kind, m.title, m.priority])).toEqual([
    ["push", "AMR: EMT - 911 Full Time", 2],
    ["email", "New EMT job: EMT - 911 Full Time - AMR", 2],
  ]);
});

test("an hour of healthy one-minute runs writes only a handful of rows", async () => {
  falckDown = false;
  gmrJobs = [
    {
      data: {
        req_id: 1,
        title: "EMT",
        city: "Concord",
        state: "California",
        latitude: 37.978,
        longitude: -122.031,
        tags2: ["AMR"],
      },
    },
  ];
  for (let m = 0; m < 60; m++) await tick(m);
  const { written } = db.sqlite.query(`SELECT total_changes() AS written`).get() as any;
  // First run: one row per board + 1 job. Then every 10 min: each board's refresh + 1 "still listed" touch.
  // (Writing a status row on every run would be ~SOURCES.length × 60.)
  console.log(`rows written in 60 one-minute runs: ${written} (${SOURCES.length} boards)`);
  expect(written).toBeLessThanOrEqual(SOURCES.length * 6 + 10);
});

const amrJob = (id: number, city: string, coords: boolean) => ({
  data: {
    req_id: id,
    title: "EMT - 911 Full Time",
    city,
    state: "California",
    ...(coords ? { latitude: 37.978, longitude: -122.031 } : {}),
    tags2: ["AMR"],
  },
});

test("a board that suddenly returns 0 listings is flagged but keeps checking every minute", async () => {
  falckDown = false;
  gmrJobs = [amrJob(1, "Concord", true)];
  await tick(0);
  gmrJobs = [];
  for (let m = 1; m <= 5; m++) await tick(m);
  expect(hits.gmr).toEqual([0, 1, 2, 3, 4, 5]); // no backoff
  const s = db.sqlite.query(`SELECT failures, last_error FROM source_status WHERE source = 'AMR / GMR'`).get() as any;
  // Marked failing (repeat failures aren't rewritten every minute, to save D1 writes).
  expect(s.failures).toBeGreaterThan(0);
  expect(s.last_error).toContain("returned 0 listings (was 1)");

  gmrJobs = [amrJob(1, "Concord", true)];
  await tick(6);
  const ok = db.sqlite.query(`SELECT failures FROM source_status WHERE source = 'AMR / GMR'`).get() as any;
  expect(ok.failures).toBe(0);
});

test("AMR jobs without coordinates are kept only when the city is nearby", async () => {
  gmrJobs = [amrJob(10, "Concord", false), amrJob(11, "Fresno", false)];
  await tick(0);
  expect(queued.filter((m) => m.kind === "push").map((m) => m.url)).toEqual(["https://careers.gmr.net/jobs/10"]);
});
