import { afterAll, beforeEach, expect, test } from "bun:test";

import { handleNotifyBatch, type NotifyMessage } from "./notify.ts";
import { memoryD1 } from "./testing/d1.ts";

let db: ReturnType<typeof memoryD1>;
let emails: { subject: string; text: string }[] = [];
let pushes: URLSearchParams[] = [];
let pushoverUp = true;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init: any) => {
  if (String(url).includes("pushover")) {
    if (!pushoverUp) return new Response('{"errors":["application token is invalid"]}', { status: 400 });
    pushes.push(init.body);
    return Response.json({ status: 1 });
  }
  throw new Error(`unexpected fetch ${url}`);
}) as any;
afterAll(() => {
  globalThis.fetch = realFetch;
});

const env = () =>
  ({
    DB: db.DB,
    EMAIL: { send: async (m: any) => void emails.push({ subject: m.subject, text: m.text }) },
    NOTIFY_EMAIL: "me@example.com",
    FROM_EMAIL: "jobs@example.com",
    PUSHOVER_TOKEN: "t",
    PUSHOVER_USER: "u",
    DASHBOARD_URL: "https://jobs.example",
    NOTIFY_DLQ_NAME: "notify-dlq",
  }) as any;

beforeEach(() => {
  db = memoryD1();
  emails = [];
  pushes = [];
  pushoverUp = true;
});

const push: NotifyMessage = {
  kind: "push",
  title: "AMR: EMT - 911 Full Time",
  body: "Concord",
  url: "https://apply.example/1",
  urlTitle: "Apply",
  priority: 2,
  dedupeKey: "push:gmr:1",
};

/** A fake MessageBatch; records what the consumer did with each message. */
const batch = (queue: string, bodies: NotifyMessage[], attempts = 1) => {
  const log: string[] = [];
  return {
    log,
    batch: {
      queue,
      messages: bodies.map((body) => ({
        body,
        attempts,
        ack: () => log.push("ack"),
        retry: (o?: { delaySeconds?: number }) => log.push(`retry ${o?.delaySeconds}s`),
      })),
    } as any,
  };
};

test("sends a push at its priority, records it, and skips a redelivery", async () => {
  const first = batch("notify", [push]);
  await handleNotifyBatch(first.batch, env());
  expect(first.log).toEqual(["ack"]);
  expect(pushes).toHaveLength(1);
  expect(pushes[0].get("priority")).toBe("2");
  expect(pushes[0].get("retry")).toBe("30"); // emergency priority needs retry/expire
  expect(pushes[0].get("url")).toBe("https://apply.example/1");

  // At-least-once delivery: the same message again is acked without a second push.
  const again = batch("notify", [push]);
  await handleNotifyBatch(again.batch, env());
  expect(again.log).toEqual(["ack"]);
  expect(pushes).toHaveLength(1);
});

test("a failed send retries with a short, growing delay", async () => {
  pushoverUp = false;
  for (const [attempts, delay] of [
    [1, 10],
    [2, 30],
    [3, 60],
    [8, 1800],
  ]) {
    const b = batch("notify", [push], attempts);
    await handleNotifyBatch(b.batch, env());
    expect(b.log).toEqual([`retry ${delay}s`]);
  }
  expect(db.sqlite.query(`SELECT COUNT(*) AS n FROM sent`).get()).toEqual({ n: 0 });
});

test("dead-lettered push falls back to email; dead-lettered email falls back to push", async () => {
  pushoverUp = false;
  const dead = batch("notify-dlq", [push]);
  await handleNotifyBatch(dead.batch, env());
  expect(dead.log).toEqual(["ack"]);
  expect(emails).toHaveLength(1);
  expect(emails[0].subject).toBe("AMR: EMT - 911 Full Time");
  expect(emails[0].text).toContain("https://apply.example/1");

  pushoverUp = true;
  const email: NotifyMessage = {
    kind: "email",
    title: "New EMT job",
    body: "details",
    priority: 1,
    dedupeKey: "email:x",
  };
  const deadEmail = batch("notify-dlq", [email]);
  await handleNotifyBatch(deadEmail.batch, env());
  expect(pushes).toHaveLength(1);
  expect(pushes[0].get("title")).toBe("New EMT job");
});

test("a failed fallback is logged and acked, not retried forever", async () => {
  pushoverUp = false;
  const email: NotifyMessage = { kind: "email", title: "x", body: "y", priority: 1, dedupeKey: "email:y" };
  const dead = batch("notify-dlq", [email]);
  await handleNotifyBatch(dead.batch, env());
  expect(dead.log).toEqual(["ack"]);
});
