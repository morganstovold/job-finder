import { HOME, type SourceConfig } from "./config.ts";
import { isNearbyText } from "./nearby.ts";
import type { Job } from "./types.ts";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

const get = async (url: string, headers: Record<string, string> = {}) => {
  const res = await fetch(url, { headers: { "User-Agent": UA, ...headers } });
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
    const body = (await (await get(`https://careers.gmr.net/api/jobs?${q}`)).json()) as {
      totalCount: number;
      jobs: { data: Record<string, any> }[];
    };
    for (const { data: d } of body.jobs) {
      const brand: string = d.tags2?.[0] ?? "GMR";
      if (src.brands && !src.brands.includes(brand)) continue;
      const lat = d.latitude != null ? Number(d.latitude) : undefined;
      const lng = d.longitude != null ? Number(d.longitude) : undefined;
      // Nationwide "float" jobs have no coordinates - keep only California ones.
      if (lat == null && d.state !== "California") continue;
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
          id: `neogov:${a.id}`,
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
  const q = new URLSearchParams({ q: src.query, limit: "100" });
  const body = (await (
    await get(`https://api.smartrecruiters.com/v1/companies/${src.company}/postings?${q}`)
  ).json()) as { content: any[] };
  return body.content
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
  }
};
