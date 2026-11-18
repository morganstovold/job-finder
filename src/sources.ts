import { HOME, type SourceConfig } from "./config.ts";
import { isNearbyText } from "./nearby.ts";
import type { Job } from "./types.ts";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

/** Sent with every request; per-call headers override them (the JSON APIs pass Accept: application/json). */
const DEFAULT_HEADERS = {
  "User-Agent": UA,
  Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

const get = async (url: string, headers: Record<string, string> = {}) => {
  // Time out so a hung board can't stall a run into the next minute's tick.
  const res = await fetch(url, { headers: { ...DEFAULT_HEADERS, ...headers }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${url}`);
  return res;
};

const decode = (s: string) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const dedupe = (jobs: Job[]) => [...new Map(jobs.map((j) => [j.id, j])).values()];

// ── AMR / Global Medical Response (iCIMS + Jibe) ───────────────────────────
// careers.gmr.net/api/jobs is the JSON feed behind the public search page.
async function gmr(src: Extract<SourceConfig, { kind: "gmr" }>): Promise<Job[]> {
  const jobs: Job[] = [];
  for (let page = 1; page <= 3; page++) {
    const q = new URLSearchParams({
      location: HOME.label,
      stretch: String(HOME.radiusMiles),
      stretchUnit: "MILES",
      page: String(page),
      limit: "100",
      sortBy: "posted_date",
      descending: "true",
    });
    const body = (await (
      await get(`https://careers.gmr.net/api/jobs?${q}`, { Accept: "application/json" })
    ).json()) as {
      totalCount: number;
      jobs: { data: Record<string, any> }[];
    };
    for (const { data: d } of body.jobs) {
      const brand: string = d.tags2?.[0] ?? "GMR";
      if (src.brands && !src.brands.includes(brand)) continue;
      const lat = d.latitude != null ? Number(d.latitude) : undefined;
      const lng = d.longitude != null ? Number(d.longitude) : undefined;
      // Nationwide "float" jobs have no coordinates - keep only ones whose city is nearby.
      if (lat == null && !isNearbyText(d.city, d.state)) continue;
      jobs.push({
        id: `gmr:${d.req_id}`,
        source: src.name,
        title: d.title,
        employer: brand,
        location: [d.city, d.state].filter(Boolean).join(", "),
        url: `https://careers.gmr.net/jobs/${d.slug ?? d.req_id}`,
        postedAt: d.posted_date,
        lat,
        lng,
        detail: [d.tags1?.[0], d.employment_type].filter(Boolean).join(" · ") || undefined,
      });
    }
    if (page * 100 >= body.totalCount) break;
  }
  return jobs;
}

// ── Falck (OnShift Employ) ─────────────────────────────────────────────────
async function onshift(src: Extract<SourceConfig, { kind: "onshift" }>): Promise<Job[]> {
  const base = `https://${src.tenant}.employ.onshift.com`;
  const rows = (await (await get(`${base}/api/v1/external/openings`, { Accept: "application/json" })).json()) as any[];
  return rows
    .map((o) => ({
      id: `onshift:${src.tenant}:${o.id}`,
      source: src.name,
      title: o.title,
      employer: o.company?.company_short ?? src.name,
      location: o.location?.location_name ?? "",
      url: `${base}/job_positions/view/${o.id}`,
      postedAt: o.date_open ? new Date(o.date_open.replace(" ", "T") + "Z").toISOString() : undefined,
      detail:
        o.job_position_shifts
          ?.map((s: any) => s.shift?.name)
          .filter(Boolean)
          .join(", ") || undefined,
    }))
    .filter((j) => isNearbyText(j.location));
}

// ── governmentjobs.com (NEOGOV) ────────────────────────────────────────────
// The search page returns an HTML fragment whose <li> carries data-job-* attrs.
async function neogov(src: Extract<SourceConfig, { kind: "neogov" }>): Promise<Job[]> {
  const jobs: Job[] = [];
  for (const keyword of src.keywords) {
    for (let page = 1; page <= 3; page++) {
      const q = new URLSearchParams({
        keyword,
        location: HOME.label,
        distance: String(src.distanceMiles),
        page: String(page),
      });
      const html = await (
        await get(`https://www.governmentjobs.com/jobs?${q}`, { "X-Requested-With": "XMLHttpRequest" })
      ).text();
      const items = [...html.matchAll(/<li class="job-item"([^>]*)>([\s\S]*?)<\/li>/g)];
      for (const [, attrs, inner] of items) {
        const a = Object.fromEntries(
          [...attrs.matchAll(/data-job-([a-z]+)="([^"]*)"/g)].map(([, k, v]) => [k, decode(v)]),
        );
        const href = inner.match(/href="(\/jobs\/[^"]+)"/)?.[1];
        const info = inner.match(/<div class="primaryInfo">\s*([^<]*\|[^<]*)<\/div>/)?.[1];
        if (!a.id || !href) continue;
        jobs.push({
          id: `neogov:${a.id.replace(/-0$/, "")}`,
          source: src.name,
          title: a.title,
          employer: a.employer,
          location: a.location,
          url: `https://www.governmentjobs.com${href}`,
          detail: info ? decode(info) : a.type,
        });
      }
      if (items.length < 10 || !html.includes(`page=${page + 1}`)) break;
    }
  }
  return dedupe(jobs);
}

// ── SmartRecruiters (City & County of SF → SFFD H-3) ───────────────────────
async function smartrecruiters(src: Extract<SourceConfig, { kind: "smartrecruiters" }>): Promise<Job[]> {
  const content: any[] = [];
  for (const query of src.queries) {
    const q = new URLSearchParams({ q: query, limit: "100" });
    const body = (await (
      await get(`https://api.smartrecruiters.com/v1/companies/${src.company}/postings?${q}`, {
        Accept: "application/json",
      })
    ).json()) as { content: any[] };
    content.push(...body.content);
  }
  const jobs = content
    .map((p) => ({
      id: `sr:${p.id}`,
      source: src.name,
      title: p.name,
      employer: p.company?.name ?? src.name,
      location: [p.location?.city, p.location?.region].filter(Boolean).join(", "),
      url: `https://jobs.smartrecruiters.com/${src.company}/${p.id}`,
      postedAt: p.releasedDate,
      detail: p.typeOfEmployment?.label,
    }))
    .filter((j) => isNearbyText(j.location, j.employer));
  return dedupe(jobs); // a posting can match several queries
}

// ── CalOpps (small CA cities & fire districts) ─────────────────────────────
async function calopps(src: Extract<SourceConfig, { kind: "calopps" }>): Promise<Job[]> {
  const jobs: Job[] = [];
  for (const keyword of src.keywords) {
    const html = await (await get(`https://www.calopps.org/job-search/${encodeURIComponent(keyword)}`)).text();
    const re =
      /<h3 class="media-heading">\s*<a href="(https:\/\/www\.calopps\.org\/([^/]+)\/job-(\d+))">([^<]+)<\/a>[\s\S]*?<div class="meta-info">([^<]+)<\/div>/g;
    for (const [, url, agencySlug, id, rawTitle, agency] of html.matchAll(re)) {
      const title = decode(rawTitle).replace(/\s*\(\d+\)\s*$/, "");
      const employer = decode(agency);
      if (!isNearbyText(agencySlug.replace(/-/g, " "), employer)) continue;
      jobs.push({ id: `calopps:${id}`, source: src.name, title, employer, location: "", url });
    }
  }
  return dedupe(jobs);
}

// ── A single agency's governmentjobs.com page (newest first) ───────────────
// Faster than the site-wide search, which can lag - matters when a posting closes in 14 minutes.
async function neogovAgency(src: Extract<SourceConfig, { kind: "neogovAgency" }>): Promise<Job[]> {
  const q = new URLSearchParams({ agency: src.agency, sort: "PostingDate", isDescendingSort: "true" });
  const res = await get(`https://www.governmentjobs.com/careers/home/index?${q}`, {
    "X-Requested-With": "XMLHttpRequest",
  });
  // An unknown agency slug redirects to the generic site instead of erroring.
  if (res.redirected) throw new Error(`unknown agency ${src.agency}`);
  const html = await res.text();
  const jobs: Job[] = [];
  for (const [, id, inner] of html.matchAll(/<li class="list-item" data-job-id="(\d+)">([\s\S]*?)<\/ul>/g)) {
    const link = inner.match(/class="item-details-link"[^>]*href="([^"]+)"[^>]*>([^<]+)</);
    if (!link) continue;
    const meta = [...inner.matchAll(/<li>([^<]*)<\/li>/g)].map((m) => decode(m[1])).filter(Boolean);
    jobs.push({
      id: `neogov:${id}`,
      source: src.name,
      title: decode(link[2]),
      employer: src.name,
      location: "",
      url: `https://www.governmentjobs.com${decode(link[1])}`,
      detail: meta.slice(1).join(" · ") || undefined,
    });
  }
  return jobs;
}

// ── FCTC "Now Hiring" (fire departments recruiting off the Statewide Eligibility List) ──
// A hand-edited table: each cell is "<Department><br><Position>", sometimes linked.
async function fctc(src: Extract<SourceConfig, { kind: "fctc" }>): Promise<Job[]> {
  const page = "https://www.fctconline.org/find-a-job/now-hiring/";
  const html = await (await get(page)).text();
  const jobs: Job[] = [];
  for (const [, cell] of html.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)) {
    if (/<h3/i.test(cell)) continue; // section headers ("FILING DEADLINES", "CONTINUOUS"…)
    const href = cell.match(/<a[^>]+href="([^"]+)"/)?.[1];
    const lines = cell
      .split(/<br\s*\/?>/i)
      .map((l) => decode(l.replace(/<[^>]+>/g, "")))
      .filter(Boolean);
    if (lines.length < 2) continue;
    const [employer, ...rest] = lines;
    const title = rest.join(" ");
    if (!isNearbyText(employer)) continue;
    const url = href ? new URL(decode(href), page).toString() : page;
    jobs.push({
      // The link makes next year's recruitment (same department + title, new flyer) a new job.
      id: `fctc:${employer}:${title}:${href ? url : ""}`.toLowerCase(),
      source: src.name,
      title,
      employer,
      location: "",
      url,
    });
  }
  return dedupe(jobs);
}

export const fetchSource = (src: SourceConfig): Promise<Job[]> => {
  switch (src.kind) {
    case "gmr":
      return gmr(src);
    case "onshift":
      return onshift(src);
    case "neogov":
      return neogov(src);
    case "smartrecruiters":
      return smartrecruiters(src);
    case "calopps":
      return calopps(src);
    case "neogovAgency":
      return neogovAgency(src);
    case "fctc":
      return fctc(src);
  }
};
