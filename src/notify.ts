import type { WorkerEnv } from "../alchemy.run.ts";
import { HOME, SOURCES } from "./config.ts";
import type { Job } from "./types.ts";

/**
 * Pushover priority. 1 = high: always sounds, even during your Pushover quiet hours.
 * 2 = emergency: repeats every 30s until you acknowledge it in the app (for 1h max).
 */
export type Priority = 1 | 2;

/**
 * Every outbound alert is a message on the `notify` Queue instead of a direct send, so a Pushover
 * or email hiccup is retried instead of lost. One push per job (tap opens its apply page), one email
 * per batch.
 */
export interface NotifyMessage {
  kind: "push" | "email";
  /** Push title / email subject. */
  title: string;
  /** Push message / email plain text. */
  body: string;
  /** Email HTML (falls back to `body`). */
  html?: string;
  /** Push link; the dashboard when omitted. */
  url?: string;
  urlTitle?: string;
  priority: Priority;
  /** Queues deliver at least once; a key already in the `sent` table is skipped. */
  dedupeKey: string;
}

/** Retry delays for a failed send, by attempt. Alerts are time-critical, so start short. */
const RETRY_DELAYS_S = [10, 30, 60, 120, 300, 600, 900, 1800];

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const line = (j: Job) => [j.title, j.employer, j.location, j.detail].filter(Boolean).join(" · ");

/** Short stable hash for dedupe keys built from many ids. */
const hash = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
};

export const priorityOf = (job: Job): Priority => SOURCES.find((s) => s.name === job.source)?.priority ?? 1;

/** Messages for newly found jobs: one push each (at its source's priority) plus one summary email. */
export function jobMessages(jobs: Job[], opts: { priority?: (j: Job) => Priority; prefix?: (j: Job) => string } = {}) {
  if (!jobs.length) return [];
  const priority = opts.priority ?? priorityOf;
  const title = (j: Job) => `${opts.prefix?.(j) ?? ""}${j.title}`;
  const subject =
    jobs.length === 1
      ? `${opts.prefix?.(jobs[0]) ?? "New EMT job: "}${jobs[0].title} - ${jobs[0].employer}`
      : `${jobs.length} new EMT jobs near ${HOME.label}`;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:600px">
  <h2 style="margin:0 0 12px">${esc(subject)}</h2>
  ${jobs
    .map(
      (j) => `<div style="padding:12px 0;border-top:1px solid #ddd">
    <a href="${esc(j.url)}" style="font-size:17px;font-weight:600">${esc(title(j))}</a><br>
    <span>${esc([j.employer, j.location].filter(Boolean).join(" - "))}</span><br>
    <span style="color:#666;font-size:13px">${esc([j.detail, j.postedAt && `posted ${j.postedAt.slice(0, 10)}`, `via ${j.source}`].filter(Boolean).join(" · "))}</span>
  </div>`,
    )
    .join("")}
</div>`;
  const ids = jobs.map((j) => j.id).join("|");
  return [
    ...jobs.slice(0, 10).map((j): NotifyMessage => ({
      kind: "push",
      title: `${j.employer}: ${title(j)}`,
      body: [j.location, j.detail].filter(Boolean).join(" · "),
      url: j.url,
      urlTitle: "Apply",
      priority: priority(j),
      dedupeKey: `push:${opts.prefix ? "open:" : ""}${j.id}`,
    })),
    {
      kind: "email",
      title: subject,
      body: jobs.map((j) => `${line(j)}\n${j.url}`).join("\n\n"),
      html,
      priority: jobs.some((j) => priority(j) === 2) ? 2 : 1,
      dedupeKey: `email:${opts.prefix ? "open:" : ""}${hash(ids)}:${jobs.length}`,
    } satisfies NotifyMessage,
  ];
}

export async function enqueue(env: WorkerEnv, messages: NotifyMessage[]) {
  if (messages.length) await env.NOTIFY.sendBatch(messages.map((body) => ({ body })));
}

export async function sendEmail(env: WorkerEnv, subject: string, text: string, html?: string) {
  if (!env.NOTIFY_EMAIL) return;
  await env.EMAIL.send({
    from: { email: env.FROM_EMAIL, name: "EMT Job Watch" },
    to: env.NOTIFY_EMAIL,
    subject,
    text,
    html: html ?? `<pre style="font-family:system-ui,sans-serif;white-space:pre-wrap">${esc(text)}</pre>`,
  });
}

/** Push via Pushover (https://pushover.net). The link is `url` (e.g. the apply page), else the dashboard. */
export async function sendPush(
  env: WorkerEnv,
  m: Pick<NotifyMessage, "title" | "body" | "url" | "urlTitle" | "priority">,
) {
  if (!env.PUSHOVER_TOKEN || !env.PUSHOVER_USER) return;
  const link = m.url || env.DASHBOARD_URL;
  const body = new URLSearchParams({
    token: env.PUSHOVER_TOKEN,
    user: env.PUSHOVER_USER,
    title: m.title.slice(0, 250),
    message: `${esc(m.body || " ")}\n\n<a href="${esc(env.DASHBOARD_URL)}">Dashboard</a>`.slice(0, 1024),
    html: "1",
    priority: String(m.priority),
    ...(m.priority === 2 ? { retry: "30", expire: "3600" } : {}),
    ...(link ? { url: link.slice(0, 512), url_title: m.url ? (m.urlTitle ?? "Open") : "Dashboard" } : {}),
  });
  const res = await fetch("https://api.pushover.net/1/messages.json", {
    method: "POST",
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`pushover ${res.status}: ${await res.text()}`);
}

const deliver = (env: WorkerEnv, m: NotifyMessage) =>
  m.kind === "push" ? sendPush(env, m) : sendEmail(env, m.title, m.body, m.html);

/** The DLQ's last attempt goes over the other channel, so a dead Pushover still reaches the inbox. */
const otherChannel = (env: WorkerEnv, m: NotifyMessage): NotifyMessage =>
  m.kind === "push"
    ? {
        ...m,
        kind: "email",
        body: `${m.body}\n\n${m.url ?? env.DASHBOARD_URL}\n\n(Sent by email because the push notification failed.)`,
        html: undefined,
      }
    : { ...m, kind: "push", body: m.body.slice(0, 600), url: env.DASHBOARD_URL, urlTitle: "Dashboard" };

const wasSent = async (env: WorkerEnv, key: string) =>
  !!(await env.DB.prepare(`SELECT 1 FROM sent WHERE key = ?`).bind(key).first());

const markSent = (env: WorkerEnv, key: string) =>
  env.DB.prepare(`INSERT OR IGNORE INTO sent (key, sent_at) VALUES (?, ?)`).bind(key, Date.now()).run();

/**
 * Queue consumer for both `notify` and its dead-letter queue. Main queue: send, record the dedupe
 * key, ack; on failure retry with a short backoff. After `max_retries` the message lands on the DLQ,
 * whose consumer makes one last attempt over the other channel, then gives up and logs.
 */
export async function handleNotifyBatch(batch: MessageBatch<NotifyMessage>, env: WorkerEnv) {
  const isDlq = batch.queue === env.NOTIFY_DLQ_NAME;
  for (const msg of batch.messages) {
    const m = isDlq ? otherChannel(env, msg.body) : msg.body;
    const key = isDlq ? `fallback:${msg.body.dedupeKey}` : msg.body.dedupeKey;
    try {
      if (await wasSent(env, key)) {
        msg.ack();
        continue;
      }
      await deliver(env, m);
      await markSent(env, key);
      msg.ack();
    } catch (e) {
      // Log the message as a string: Workers logs drop an Error object's message and keep only its stack.
      const err = (e as Error)?.message ?? String(e);
      if (isDlq) {
        console.error(`notify fallback (${m.kind}) failed, giving up: ${err} [${key}]`);
        msg.ack();
      } else {
        const delaySeconds = RETRY_DELAYS_S[Math.min(msg.attempts, RETRY_DELAYS_S.length) - 1];
        console.error(`notify ${m.kind} failed (attempt ${msg.attempts}, retry in ${delaySeconds}s): ${err}`);
        msg.retry({ delaySeconds });
      }
    }
  }
}
