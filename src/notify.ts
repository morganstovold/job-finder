import type { WorkerEnv } from "../alchemy.run.ts";
import { HOME } from "./config.ts";
import type { Job } from "./types.ts";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const line = (j: Job) => [j.title, j.employer, j.location, j.detail].filter(Boolean).join(" · ");

export async function sendEmail(env: WorkerEnv, subject: string, text: string, html: string) {
  if (!env.NOTIFY_EMAIL) return;
  await env.EMAIL.send({
    from: { email: env.FROM_EMAIL, name: "EMT Job Watch" },
    to: env.NOTIFY_EMAIL,
    subject,
    text,
    html,
  });
}

/**
 * Free push notification to the ntfy app (https://ntfy.sh) - the "SMS" channel.
 * Always max priority: lower priorities don't pop a notification on the phone.
 * Tapping opens `clickUrl` (the job), falling back to the dashboard; a "Dashboard" button is attached too.
 */
export async function sendPush(env: WorkerEnv, title: string, message: string, clickUrl?: string) {
  if (!env.NTFY_TOPIC) return;
  const res = await fetch(`https://ntfy.sh/${env.NTFY_TOPIC}`, {
    method: "POST",
    body: message,
    headers: {
      // Header values must be ASCII.
      Title: title.replace(/[^\x20-\x7e]/g, ""),
      Priority: "max",
      Tags: "ambulance",
      ...(env.NTFY_TOKEN ? { Authorization: `Bearer ${env.NTFY_TOKEN}` } : {}),
      ...(clickUrl || env.DASHBOARD_URL ? { Click: clickUrl || env.DASHBOARD_URL } : {}),
      ...(env.DASHBOARD_URL ? { Actions: `view, Dashboard, ${env.DASHBOARD_URL}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`ntfy ${res.status}: ${await res.text()}`);
}

export async function notifyNewJobs(env: WorkerEnv, jobs: Job[]) {
  const subject =
    jobs.length === 1
      ? `New EMT job: ${jobs[0].title} - ${jobs[0].employer}`
      : `${jobs.length} new EMT jobs near ${HOME.label}`;

  const text = jobs.map((j) => `${line(j)}\n${j.url}`).join("\n\n");
  const html = `<div style="font-family:system-ui,sans-serif;max-width:600px">
  <h2 style="margin:0 0 12px">${esc(subject)}</h2>
  ${jobs
    .map(
      (j) => `<div style="padding:12px 0;border-top:1px solid #ddd">
    <a href="${esc(j.url)}" style="font-size:17px;font-weight:600">${esc(j.title)}</a><br>
    <span>${esc([j.employer, j.location].filter(Boolean).join(" - "))}</span><br>
    <span style="color:#666;font-size:13px">${esc([j.detail, j.postedAt && `posted ${j.postedAt.slice(0, 10)}`, `via ${j.source}`].filter(Boolean).join(" · "))}</span>
  </div>`,
    )
    .join("")}
</div>`;

  const results = await Promise.allSettled([
    sendEmail(env, subject, text, html),
    // One push per job so each notification taps straight through to its apply page.
    ...jobs
      .slice(0, 5)
      .map((j) =>
        sendPush(env, `${j.employer}: ${j.title}`, [j.location, j.detail].filter(Boolean).join(" · "), j.url),
      ),
  ]);
  // Log the message as a string: Workers logs drop an Error object's message and keep only its stack.
  for (const r of results)
    if (r.status === "rejected") console.error(`notify failed: ${r.reason?.message ?? String(r.reason)}`);
}
