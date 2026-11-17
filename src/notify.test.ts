import { afterAll, beforeEach, expect, test } from "bun:test";

import { handleNotifyBatch, type NotifyMessage } from "./notify.ts";
import { memoryD1 } from "./testing/d1.ts";

let db: ReturnType<typeof memoryD1>;
let emails: { subject: string; text: string }[] = [];
let pushes: URLSearchParams[] = [];
let pushoverUp = true;
let emailUp = true;
let pushCalls = 0;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init: any) => {
  if (String(url).includes("pushover")) {
    pushCalls++;
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
    EMAIL: {
      send: async (m: any) => {
        if (!emailUp) throw new Error("email routing down");
        emails.push({ subject: m.subject, text: m.text });
      },
    },
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
  emailUp = true;
  pushCalls = 0;
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

test("a failing push retries twice, then the 3rd failure sends it by email right away", async () => {
  pushoverUp = false;
  for (const [attempts, delay] of [
    [1, 10],
    [2, 30],
  ]) {
    const b = batch("notify", [push], attempts);
    await handleNotifyBatch(b.batch, env());
    expect(b.log).toEqual([`retry ${delay}s`]);
  }
  expect(emails).toEqual([]);

  const third = batch("notify", [push], 3);
  await handleNotifyBatch(third.batch, env());
  expect(third.log).toEqual(["ack"]);
  expect(emails).toHaveLength(1);
  expect(emails[0].subject).toBe("AMR: EMT - 911 Full Time");
  expect(emails[0].text).toContain("https://apply.example/1");

  // A redelivery doesn't retry Pushover or send a second email.
  pushCalls = 0;
  const again = batch("notify", [push], 4);
  await handleNotifyBatch(again.batch, env());
  expect(again.log).toEqual(["ack"]);
  expect(pushCalls).toBe(0);
  expect(emails).toHaveLength(1);
});

test("if the email fallback fails too, it keeps retrying by email only", async () => {
  pushoverUp = false;
  emailUp = false;
  const third = batch("notify", [push], 3);
  await handleNotifyBatch(third.batch, env());
  expect(third.log).toEqual(["retry 60s"]);

  pushCalls = 0;
  emailUp = true;
  const fourth = batch("notify", [push], 4);
  await handleNotifyBatch(fourth.batch, env());
  expect(fourth.log).toEqual(["ack"]);
  expect(pushCalls).toBe(0);
  expect(emails).toHaveLength(1);
});

test("a failing email retries with a short, growing delay", async () => {
  emailUp = false;
  const email: NotifyMessage = { kind: "email", title: "New EMT job", body: "x", priority: 1, dedupeKey: "email:z" };
  for (const [attempts, delay] of [
    [1, 10],
    [2, 30],
    [3, 60],
    [8, 1800],
  ]) {
    const b = batch("notify", [email], attempts);
    await handleNotifyBatch(b.batch, env());
    expect(b.log).toEqual([`retry ${delay}s`]);
  }
  expect(pushes).toEqual([]); // email doesn't switch channels until the DLQ
  expect(db.sqlite.query(`SELECT COUNT(*) AS n FROM sent`).get()).toEqual({ n: 0 });
});

test("dead letters get one last try as a push (the channel not being retried)", async () => {
  const deadPush = batch("notify-dlq", [push]);
  await handleNotifyBatch(deadPush.batch, env());
  expect(deadPush.log).toEqual(["ack"]);
  expect(pushes).toHaveLength(1);

  const email: NotifyMessage = {
    kind: "email",
    title: "New EMT job",
    body: "details",
    priority: 1,
    dedupeKey: "email:x",
  };
  const deadEmail = batch("notify-dlq", [email]);
  await handleNotifyBatch(deadEmail.batch, env());
  expect(pushes).toHaveLength(2);
  expect(pushes[1].get("title")).toBe("New EMT job");
});

test("a failed last attempt is logged and acked, not retried forever", async () => {
  pushoverUp = false;
  const email: NotifyMessage = { kind: "email", title: "x", body: "y", priority: 1, dedupeKey: "email:y" };
  const dead = batch("notify-dlq", [email]);
  await handleNotifyBatch(dead.batch, env());
  expect(dead.log).toEqual(["ack"]);
});

test("email subject and push labels follow the job category", async () => {
  const { jobMessages } = await import("./notify.ts");
  const emt = { id: "a", source: "x", title: "EMT", employer: "AMR", location: "", url: "u", category: "emt" as const };
  const ff = {
    id: "b",
    source: "x",
    title: "Fire Recruit",
    employer: "ConFire",
    location: "",
    url: "u",
    category: "ff" as const,
  };
  const subject = (jobs: any[]) => jobMessages(jobs).find((m) => m.kind === "email")!.title;
  expect(subject([emt])).toBe("New EMT job: EMT - AMR");
  expect(subject([ff])).toBe("New firefighter recruit opening: Fire Recruit - ConFire");
  expect(subject([ff, { ...ff, id: "c" }])).toBe("2 new firefighter recruit openings near Benicia, CA");
  expect(subject([emt, ff])).toBe("2 new jobs (EMT + FF recruit)");
  expect(
    jobMessages([emt, ff])
      .filter((m) => m.kind === "push")
      .map((m) => m.title),
  ).toEqual(["EMT: AMR - EMT", "FF Recruit: ConFire - Fire Recruit"]);
});
