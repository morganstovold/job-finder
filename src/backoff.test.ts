import { Database } from "bun:sqlite";
import { afterAll, beforeEach, expect, setSystemTime, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

import { SOURCES } from "./config.ts";
import worker, { backoffMs } from "./worker.ts";

test("backoff scales from each board's pace", () => {
  expect([1, 2, 3, 4, 9].map((n) => backoffMs(n) / 60_000)).toEqual([1, 2, 4, 8, 60]);
  expect([1, 2, 3, 4, 5, 9].map((n) => backoffMs(n, 5) / 60_000)).toEqual([5, 10, 20, 40, 60, 60]);
});

// Minimal D1 on top of bun:sqlite, enough for the worker's queries.
let sqlite: Database;
const stmt = (sql: string, args: unknown[] = []): any => ({
  bind: (...a: unknown[]) => stmt(sql, a),
  all: async () => ({ results: sqlite.query(sql).all(...(args as any[])) }),
  first: async () => sqlite.query(sql).get(...(args as any[])),
  run: async () => sqlite.query(sql).run(...(args as any[])),
});
let emails: string[] = [];
const env: any = {
  DB: {
    prepare: (sql: string) => stmt(sql),
    // Like D1: runs in order, one result per statement (RETURNING rows land in `results`).
    batch: async (s: any[]) => {
      const out = [];
      for (const x of s) out.push(await x.all());
      return out;
    },
  },
  EMAIL: { send: async (m: any) => void emails.push(m.subject) },
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
  sqlite = new Database(":memory:");
  for (const f of readdirSync("migrations").toSorted()) sqlite.exec(readFileSync(`migrations/${f}`, "utf8"));
  hits = {};
  emails = [];
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
  const s = sqlite.query(`SELECT failures FROM source_status WHERE source = 'Falck NorCal'`).get() as any;
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
  expect(emails).toEqual(["New EMT job: EMT - 911 Full Time - AMR"]);
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
  const { written } = sqlite.query(`SELECT total_changes() AS written`).get() as any;
  // First run: one row per board + 1 job. Then every 10 min: each board's refresh + 1 "still listed" touch.
  // (Writing a status row on every run would be ~SOURCES.length × 60.)
  console.log(`rows written in 60 one-minute runs: ${written} (${SOURCES.length} boards)`);
  expect(written).toBeLessThanOrEqual(SOURCES.length * 6 + 10);
});
