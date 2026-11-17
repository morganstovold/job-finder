import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

import worker, { backoffMs } from "./worker.ts";

test("backoff schedule", () => {
  expect([1, 2, 3, 4, 9].map((n) => backoffMs(n) / 60_000)).toEqual([10, 20, 40, 60, 60]);
});

// Minimal D1 on top of bun:sqlite, enough for the worker's queries.
const sqlite = new Database(":memory:");
for (const f of readdirSync("migrations").toSorted()) sqlite.exec(readFileSync(`migrations/${f}`, "utf8"));
const stmt = (sql: string, args: unknown[] = []): any => ({
  bind: (...a: unknown[]) => stmt(sql, a),
  all: async () => ({ results: sqlite.query(sql).all(...(args as any[])) }),
  first: async () => sqlite.query(sql).get(...(args as any[])),
  run: async () => sqlite.query(sql).run(...(args as any[])),
});
const env: any = {
  DB: { prepare: (sql: string) => stmt(sql), batch: async (s: any[]) => Promise.all(s.map((x) => x.run())) },
  EMAIL: { send: async () => ({}) },
  NOTIFY_EMAIL: "",
  PUSHOVER_TOKEN: "",
  PUSHOVER_USER: "",
};

// Falck always 403s; every other board answers with an empty result.
let falckCalls = 0;
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (input: string) => {
    const url = String(input);
    if (url.includes("onshift")) return (falckCalls++, new Response("Forbidden", { status: 403 }));
    if (url.includes("gmr.net")) return Response.json({ totalCount: 0, jobs: [] });
    if (url.includes("smartrecruiters")) return Response.json({ content: [] });
    return new Response("");
  }) as any;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  setSystemTime();
});

const tick = async (minute: number) => {
  setSystemTime(new Date(Date.UTC(2026, 10, 17, 17, 0) + minute * 60_000));
  await worker.scheduled({} as any, env);
};
const falck = () =>
  sqlite.query(`SELECT failures, next_attempt FROM source_status WHERE source = 'Falck NorCal'`).get() as any;

test("failing board backs off 10 → 20 → 40 → 60 min, then recovers to every tick", async () => {
  // Ticks every 10 min for 3 hours; record which ticks actually hit Falck.
  const hits: number[] = [];
  for (let m = 0; m <= 180; m += 10) {
    const before = falckCalls;
    await tick(m);
    if (falckCalls > before) hits.push(m);
  }
  // Fails at 0 → waits 10 → fails at 10 → waits 20 → 30 → waits 40 → 70 → waits 60 → 130 → 190…
  expect(hits).toEqual([0, 10, 30, 70, 130]);
  expect(falck().failures).toBe(5);

  // Falck comes back: next due tick succeeds and resets to every tick.
  globalThis.fetch = (async (input: string) =>
    String(input).includes("onshift")
      ? Response.json([])
      : Response.json({ totalCount: 0, jobs: [], content: [] })) as any;
  await tick(190);
  expect(falck()).toEqual({ failures: 0, next_attempt: null });

  // Healthy boards were never skipped.
  const gmr = sqlite.query(`SELECT failures FROM source_status WHERE source = 'AMR / GMR'`).get() as any;
  expect(gmr.failures).toBe(0);
});
