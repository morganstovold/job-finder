// The dashboard at `/`: EMT positions first, then firefighter recruit openings, announcements and board
// health. Server-rendered, no JS beyond a once-a-minute refresh. Styled after morgannstovold.com
// (Fraunces / Inter / JetBrains Mono, warm paper and ink, signal-red accent, EKG line).
import type { WorkerEnv } from "../alchemy.run.ts";
import { remindersFor } from "./announce-watch.ts";
import { fmtPT } from "./announce.ts";
import { HOME, SOURCES } from "./config.ts";
import type { AnnouncementRow } from "./jobs.ts";

interface JobRow {
  id: string;
  source: string;
  title: string;
  employer: string;
  location: string;
  url: string;
  detail: string | null;
  first_seen: number;
  last_seen: number;
  category: "emt" | "ff";
}

interface StatusRow {
  source: string;
  last_ok: number | null;
  last_count: number | null;
  last_error: string | null;
  last_error_at: number | null;
  failures: number;
  next_attempt: number | null;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Listed boards refresh "last seen" every 10 min; older than this = no longer listed. */
const GONE_AFTER = HOUR;

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** "just now", "12 min ago", "3 h ago", "2 d ago". */
const ago = (t: number | null | undefined, now: number) => {
  if (!t) return "never";
  const d = now - t;
  if (d < MIN) return "just now";
  if (d < HOUR) return `${Math.floor(d / MIN)} min ago`;
  if (d < DAY) return `${Math.floor(d / HOUR)} h ago`;
  return `${Math.floor(d / DAY)} d ago`;
};

/** "in 2d 4h", "in 3h 12m", "in 8m". */
const until = (t: number, now: number) => {
  const d = Math.max(0, t - now);
  if (d >= DAY) return `in ${Math.floor(d / DAY)}d ${Math.floor((d % DAY) / HOUR)}h`;
  if (d >= HOUR) return `in ${Math.floor(d / HOUR)}h ${Math.floor((d % HOUR) / MIN)}m`;
  return `in ${Math.ceil(d / MIN)}m`;
};

const isFailing = (s: StatusRow) => !!s.failures || (!!s.last_error_at && s.last_error_at > (s.last_ok ?? 0));

const jobCard = (j: JobRow, now: number, size: "lg" | "sm") => {
  const fresh = now - j.first_seen < DAY;
  const gone = now - j.last_seen > GONE_AFTER;
  return `<article class="job ${size}${gone ? " gone" : ""}">
  <div class="job-main">
    <div class="job-top">
      <span class="tag ${j.category}">${j.category === "ff" ? "FF Recruit" : "EMT"}</span>
      ${fresh && !gone ? `<span class="new">New</span>` : ""}
      ${gone ? `<span class="closed">No longer listed</span>` : ""}
    </div>
    <h3><a href="${esc(j.url)}" target="_blank" rel="noopener">${esc(j.title)}</a></h3>
    <p class="who">${esc([j.employer, j.location !== j.employer && j.location].filter(Boolean).join(" · "))}</p>
    <p class="meta">${esc([j.detail, `found ${ago(j.first_seen, now)}`, `via ${j.source}`].filter(Boolean).join("  ·  "))}</p>
  </div>
  ${gone ? "" : `<a class="apply" href="${esc(j.url)}" target="_blank" rel="noopener">Apply<span aria-hidden="true"> ↗</span></a>`}
</article>`;
};

const announcementCard = (a: AnnouncementRow, env: WorkerEnv, now: number) => {
  const watching = a.status === "watching";
  const next = watching ? remindersFor(env, a).find((r) => r.at > now) : undefined;
  const state = watching ? "Watching" : a.status === "confirmed" ? "Posting found" : "Expired";
  const kind = a.category === "ff" ? "Fire Recruit" : "Single-role EMT";
  return `<article class="ann ${a.status}">
  <div class="ann-when">
    ${
      a.open_at && watching && a.open_at > now
        ? `<span class="count">${until(a.open_at, now)}</span><span class="sub">opens ${esc(fmtPT(a.open_at))}</span>`
        : `<span class="count">${a.open_at ? esc(fmtPT(a.open_at)) : "Date TBA"}</span><span class="sub">${a.open_at ? "opening" : "watching boards"}</span>`
    }
  </div>
  <div class="ann-body">
    <div class="job-top"><span class="tag ${a.category}">${kind}</span><span class="state ${a.status}">${state}</span></div>
    <h3>${esc(a.announcer)}</h3>
    <p class="who">${esc(a.subject)}</p>
    <p class="meta">received ${esc(ago(a.received_at, now))}${next ? `  ·  next reminder ${esc(fmtPT(next.at))}` : ""}</p>
  </div>
</article>`;
};

const section = (title: string, kicker: string, jobs: JobRow[], now: number, size: "lg" | "sm", empty: string) =>
  `<section>
  <div class="sec-head"><h2>${title}</h2><span class="kicker">${kicker}</span></div>
  ${jobs.length ? `<div class="list">${jobs.map((j) => jobCard(j, now, size)).join("")}</div>` : `<p class="empty">${empty}</p>`}
</section>`;

export async function dashboard(env: WorkerEnv) {
  const now = Date.now();
  const since = now - 30 * DAY;
  const [{ results: jobs }, { results: status }, { results: announcements }] = await Promise.all([
    env.DB.prepare(`SELECT * FROM jobs WHERE last_seen > ? ORDER BY first_seen DESC LIMIT 200`)
      .bind(since)
      .all<JobRow>(),
    env.DB.prepare(`SELECT * FROM source_status`).all<StatusRow>(),
    env.DB.prepare(
      `SELECT * FROM announcements WHERE status = 'watching' OR received_at > ? ORDER BY received_at DESC LIMIT 10`,
    )
      .bind(since)
      .all<AnnouncementRow>(),
  ]);

  const open = jobs.filter((j) => now - j.last_seen <= GONE_AFTER);
  const gone = jobs.filter((j) => now - j.last_seen > GONE_AFTER);
  const emt = open.filter((j) => j.category !== "ff");
  const ff = open.filter((j) => j.category === "ff");
  const newToday = open.filter((j) => now - j.first_seen < DAY).length;
  const watching = announcements.filter((a) => a.status === "watching");

  // Boards in config order, so the grid matches src/config.ts.
  const byName = new Map(status.map((s) => [s.source, s]));
  const boards = SOURCES.map((s) => ({ name: s.name, s: byName.get(s.name) }));
  const failing = boards.filter((b) => b.s && isFailing(b.s));
  const lastCheck = Math.max(0, ...status.map((s) => Math.max(s.last_ok ?? 0, s.last_error_at ?? 0)));

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>EMT Job Watch</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,650&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
<style>
:root{--paper:#f6f1e7;--card:#fffdf8;--ink:#1b1a17;--muted:#6f6a60;--line:#e2d9c8;--red:#d62d20;--red-soft:#d62d2014;--ok:#2f7d4f;--ff:#b5651d;--ff-soft:#b5651d18;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--paper:#14130f;--card:#1c1b16;--ink:#ece6d8;--muted:#9d968a;--line:#2e2c25;--red:#ff5a4c;--red-soft:#ff5a4c1c;--ok:#5cc98a;--ff:#e39a52;--ff-soft:#e39a5222;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit}
.wrap{max-width:880px;margin:0 auto;padding:28px 16px 64px}
.mono,.kicker,.tag,.new,.closed,.state,.meta,.stat .label,.pill,.sub{font-family:"JetBrains Mono",ui-monospace,monospace}
header{position:relative;padding-bottom:18px;margin-bottom:22px;border-bottom:1px solid var(--line)}
.eyebrow{font:500 11px/1 "JetBrains Mono",monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
h1{font:650 clamp(34px,7vw,52px)/1.02 Fraunces,Georgia,serif;letter-spacing:-.02em;margin:10px 0 6px}
h1 em{font-style:normal;color:var(--red)}
.lede{color:var(--muted);margin:0 0 14px;max-width:56ch}
.ekg{display:block;width:100%;height:36px;margin:4px 0 12px}
.ekg path{fill:none;stroke:var(--red);stroke-width:2;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:1;stroke-dashoffset:1;animation:trace 2.4s ease-out forwards}
@keyframes trace{to{stroke-dashoffset:0}}
@media (prefers-reduced-motion:reduce){.ekg path{animation:none;stroke-dashoffset:0}}
.pill{display:inline-flex;align-items:center;gap:8px;font-size:12px;padding:6px 12px;border:1px solid var(--line);border-radius:999px;background:var(--card)}
.dot{width:8px;height:8px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 0 var(--ok);animation:pulse 2s infinite}
.pill.bad .dot{background:var(--red);box-shadow:0 0 0 0 var(--red)}
@keyframes pulse{70%{box-shadow:0 0 0 7px transparent}100%{box-shadow:0 0 0 0 transparent}}
@media (prefers-reduced-motion:reduce){.dot{animation:none}}
/* Stats: a ruled row of figures, no boxes. */
.stats{display:grid;grid-template-columns:repeat(4,1fr);margin:0 0 36px;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.stat{padding:14px 16px 12px;border-left:1px solid var(--line)}
.stat:first-child{border-left:0;padding-left:0}
.stat .num{font:600 34px/1 Fraunces,Georgia,serif;letter-spacing:-.02em}
.stat.primary .num{color:var(--red)}
.stat .label{display:block;margin-top:8px;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
/* Sections: a heavy rule under the heading, hairlines between rows. */
section{margin:0 0 40px}
.sec-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;border-bottom:2px solid var(--ink);padding-bottom:8px}
h2{font:600 26px/1.1 Fraunces,Georgia,serif;margin:0;letter-spacing:-.015em}
.kicker{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
.list{display:block}
.job,.ann{display:flex;gap:20px;align-items:baseline;padding:16px 0;border-bottom:1px solid var(--line)}
.job.lg{padding:20px 0}
.job.gone,.ann.expired{opacity:.5}
.job-main,.ann-body{flex:1;min-width:0}
.job-top{display:flex;gap:12px;align-items:center;margin-bottom:5px}
.tag,.new,.closed,.state{font-size:10px;letter-spacing:.12em;text-transform:uppercase}
.tag.emt{color:var(--red)}
.tag.ff{color:var(--ff)}
.new{color:var(--red);display:inline-flex;align-items:center;gap:5px}
.new::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--red)}
.closed,.state{color:var(--muted)}
.state.watching{color:var(--red)}
.state.confirmed{color:var(--ok)}
h3{font:600 16px/1.35 Inter,system-ui,sans-serif;margin:0 0 3px}
.job.lg h3{font:600 20px/1.25 Fraunces,Georgia,serif;letter-spacing:-.005em}
h3 a{text-decoration:none}
h3 a:hover{text-decoration:underline;text-decoration-thickness:1px;text-decoration-color:var(--red);text-underline-offset:4px}
.who{margin:0;color:var(--ink);overflow-wrap:anywhere}
.meta{margin:5px 0 0;font-size:11px;color:var(--muted);white-space:pre-wrap;overflow-wrap:anywhere}
.apply{flex:none;font:500 11px "JetBrains Mono",monospace;letter-spacing:.12em;text-transform:uppercase;text-decoration:none;color:var(--ink);border-bottom:1px solid var(--ink);padding-bottom:2px}
.job.lg .apply{color:var(--red);border-color:var(--red)}
.apply:hover{color:var(--red);border-color:var(--red)}
.ann-when{flex:none;width:140px}
.ann-when .count{display:block;font:600 22px/1.1 Fraunces,Georgia,serif;color:var(--red)}
.ann.confirmed .ann-when .count{color:var(--ok)}
.sub{display:block;font-size:10.5px;color:var(--muted);margin-top:4px}
.empty{padding:18px 0;margin:0;color:var(--muted);border-bottom:1px solid var(--line);font-style:italic;font-family:Fraunces,Georgia,serif;font-size:16px}
details{margin:-24px 0 40px}
summary{cursor:pointer;padding:12px 0;font:500 11px "JetBrains Mono",monospace;color:var(--muted);letter-spacing:.1em;text-transform:uppercase}
details .list{border-top:1px solid var(--line)}
/* Boards: a plain two-column index, a dot per board. */
.boards{display:grid;grid-template-columns:repeat(2,1fr);column-gap:32px}
.board{display:flex;justify-content:space-between;gap:12px;align-items:baseline;padding:9px 0;border-bottom:1px solid var(--line);font-size:13.5px}
.board .name{display:flex;align-items:center;gap:8px;font-weight:500}
.board .dot{animation:none;width:6px;height:6px;flex:none}
.board.bad .dot{background:var(--red)}
.board.unknown .dot{background:var(--muted)}
.board .meta{margin:0;text-align:right}
.board .err{color:var(--red)}
footer{margin-top:40px;font-size:11px;color:var(--muted);font-family:"JetBrains Mono",monospace;letter-spacing:.04em}
@media (max-width:640px){
  .stats{grid-template-columns:repeat(2,1fr)}
  .stat:nth-child(3){border-left:0;padding-left:0}
  .stat:nth-child(n+3){border-top:1px solid var(--line)}
  .sec-head .kicker{display:none}
  .job,.ann{flex-direction:column;align-items:stretch;gap:10px}
  .apply{align-self:flex-start}
  .boards{grid-template-columns:1fr}
}
</style>
</head>
<body>
<div class="wrap">
<header>
  <span class="eyebrow">Job Watch · ${esc(HOME.label)} · ${HOME.radiusMiles} mi</span>
  <h1>EMT <em>Job</em> Watch</h1>
  <p class="lede">911 EMT-B positions first, then firefighter trainee and recruit openings. Checked every minute; you get a push the moment one posts.</p>
  <svg class="ekg" viewBox="0 0 880 36" preserveAspectRatio="none" aria-hidden="true"><path pathLength="1" d="M0 22 H300 L318 22 L330 6 L344 34 L356 14 L366 22 H560 L572 22 L582 10 L594 30 L604 22 H880"/></svg>
  <span class="pill${failing.length ? " bad" : ""}"><span class="dot"></span>${
    failing.length ? `${failing.length} of ${boards.length} boards failing` : `${boards.length} boards healthy`
  } · checked ${esc(ago(lastCheck || null, now))}</span>
</header>

<div class="stats">
  <div class="stat primary"><div class="num">${emt.length}</div><span class="label">Open EMT jobs</span></div>
  <div class="stat"><div class="num">${ff.length}</div><span class="label">FF recruit openings</span></div>
  <div class="stat"><div class="num">${newToday}</div><span class="label">New in 24h</span></div>
  <div class="stat"><div class="num">${watching.length}</div><span class="label">Announcements</span></div>
</div>

${
  announcements.length
    ? `<section><div class="sec-head"><h2>Announcements</h2><span class="kicker">From agency interest lists</span></div><div class="list">${announcements.map((a) => announcementCard(a, env, now)).join("")}</div></section>`
    : ""
}

${section("EMT positions", "Priority", emt, now, "lg", "No open EMT positions right now. You'll get a push the moment one posts.")}

${section("Firefighter recruit", "Department runs the academy", ff, now, "sm", "No trainee or recruit openings right now.")}

${
  gone.length
    ? `<details><summary>No longer listed (${gone.length}, last 30 days)</summary><div class="list">${gone
        .toSorted((a, b) => (a.category === b.category ? 0 : a.category === "ff" ? 1 : -1))
        .map((j) => jobCard(j, now, "sm"))
        .join("")}</div></details>`
    : ""
}

<section>
  <div class="sec-head"><h2>Boards</h2><span class="kicker">${boards.length} sources</span></div>
  <div class="boards">${boards
    .map(({ name, s }) => {
      const bad = s && isFailing(s);
      const state = !s ? "unknown" : bad ? "bad" : "ok";
      const meta = !s
        ? "not checked yet"
        : bad
          ? `<span class="err">${esc((s.last_error ?? "failing").slice(0, 80))}</span>${s.next_attempt && s.next_attempt > now ? ` · retry ${until(s.next_attempt, now)}` : ""}`
          : `${s.last_count ?? 0} listings · ok ${ago(s.last_ok, now)}`;
      return `<div class="board ${state}"><div class="name"><span class="dot"></span>${esc(name)}</div><div class="meta">${meta}</div></div>`;
    })
    .join("")}</div>
</section>

<footer>Updated ${esc(fmtPT(now))} PT · refreshes every minute</footer>
</div>
</body>
</html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
