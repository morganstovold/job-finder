// Everything you'd want to tweak lives here: where you are, how far you'll
// drive, which titles count as an EMT-B job, and which boards to watch.

export const HOME = {
  label: "Benicia, CA",
  lat: 38.0494,
  lng: -122.1586,
  /** Jobs farther than this (straight-line miles) are ignored when a source gives coordinates. */
  radiusMiles: 60,
};

/** A title must match one of these to count as an EMT-B job. */
export const TITLE_INCLUDE: RegExp[] = [
  /\bE\.?M\.?T\b/i,
  /emergency medical tech/i,
  /\bH-?0{0,2}3\b/i, // SFFD H-3 (also "H003") "EMT & Paramedic" class
  /\bEMS\b.*trainee|emergency medical services trainee/i, // Sac Fire's internal single-role title
  /ambulance (attendant|operator)/i,
];

/** …and must not match any of these. */
export const TITLE_EXCLUDE: RegExp[] = [
  /instructor|faculty|professor|teacher|educat|coordinator|manager|director|supervisor|scheduler/i,
  /\bA-?EMT\b|advanced emt|emt-?a\b|emt-?p\b|emt-?i\b/i, // AEMT / paramedic-level
  /intern\b|internship|skillbridge|volunteer/i,
  /\bevent\b/i, // event standby (e.g. CrowdRx), not 911
];

/**
 * 911 only: you already work IFT. Catches IFT postings at 911 companies (e.g. AMR "EMT - IFT"),
 * except 911/IFT hybrids - a title that also says 911 still counts.
 */
export const IFT_EXCLUDE = /\bIFT\b|inter-?facility|non-?emergency|wheelchair|gurney/i;

/** Firefighter/EMT titles only count as EMT jobs if they match this, e.g. "EMT (Non-Safety)". */
export const FIREFIGHTER_OK = /single[- ]role|non[- ]safety/i;

/**
 * Entry-level firefighter jobs where the department runs its own academy ("ff" category). You're on
 * FCTC's Statewide Eligibility List (written + CPAT) but not an academy graduate or a paramedic.
 * H-2 is SFFD's entry-level Firefighter class (SFFD runs the academy).
 *
 * Plain "Firefighter" or "Firefighter/EMT" with no trainee/recruit wording is deliberately NOT
 * included: those usually require a completed academy (Firefighter I).
 */
export const FF_TRAINEE_INCLUDE =
  /fire ?fighter[\s/-]*(trainee|recruit)|fire recruit|recruit fire ?fighter|fire ?fighter[\s(-]*(entry[- ]level)|probationary fire ?fighter|\bH-?0{0,2}2\b/i;

/** …minus these. Paramedic-only titles are handled in filter.ts (paramedic without EMT = skip). */
export const FF_TRAINEE_EXCLUDE =
  /lateral|engineer|captain|apparatus|chief|inspector|marshal|reserve|volunteer|seasonal|instructor/i;

export type SourceConfig = {
  name: string;
  /**
   * The board always has listings, so 0 after a non-zero count means the parser broke. Counts as a
   * failure for the "board broken" alert, but without backoff (an empty board can be real).
   */
  expectNonEmpty?: boolean;
  /**
   * Minimum minutes between checks (default 1 = every cron tick). Postings can close within
   * 15-45 min of going up, so keep this low; boards that rate-limit get a little more room.
   */
  everyMinutes?: number;
} & (
  | { kind: "gmr"; name: string; brands?: string[] }
  | { kind: "onshift"; name: string; tenant: string }
  | { kind: "neogov"; name: string; keywords: string[]; distanceMiles: number }
  | { kind: "smartrecruiters"; name: string; company: string; queries: string[] }
  | { kind: "calopps"; name: string; keywords: string[] }
  | { kind: "neogovAgency"; name: string; agency: string }
  | { kind: "fctc"; name: string }
);

/**
 * Fire agencies with single-role EMT programs, watched on their own governmentjobs.com page
 * (newest first). The site-wide search can lag behind; Sac City Fire's single-role EMT posting
 * closed 14 minutes after opening. The slug is the part after /careers/ in the agency's job links.
 */
const FIRE_AGENCIES: Record<string, { name: string; expectNonEmpty?: boolean }> = {
  // City-wide boards always list something; an empty one means the parser broke.
  saccity: { name: "Sac City Fire", expectNonEmpty: true },
  // The rest can legitimately drop to zero (some list only one or two postings), so no empty check.
  smfd: { name: "Sac Metro Fire" },
  srvfire: { name: "San Ramon Valley Fire" },
  mofd: { name: "Moraga-Orinda Fire" },
  paloaltoca: { name: "Palo Alto Fire" },
  folsom: { name: "Folsom Fire" },
  // No single-role EMT program, but they hire firefighter recruits/trainees.
  confire: { name: "ConFire" },
  cosumnescsd: { name: "Cosumnes Fire" },
};

// 911 employers only. IFT-focused companies (Royal, Falcon, ProTransport-1, Bay Medic, NorCal,
// LIFEwest, AlphaOne, West Coast Medical) are left out on purpose.
// King-American (SF 911) has no public feed - its Paycom board needs a session token - so use the
// "Create Job Alerts" button on its board instead.
export const SOURCES: SourceConfig[] = [
  // AMR + sister brands - iCIMS JSON API, has coordinates. AMR postings have closed in ~45 min.
  { kind: "gmr", name: "AMR / GMR", expectNonEmpty: true },
  // Falck Northern California (Alameda County 911). Falck runs a separate OnShift
  // tenant per region - add more here (find the slug from an apply link).
  // Occasionally rate-limits (403) - the worker backs off automatically.
  { kind: "onshift", name: "Falck NorCal", tenant: "falcknc", everyMinutes: 5 },
  // Most Bay Area / Sacramento fire districts & cities post on governmentjobs.com.
  {
    kind: "neogov",
    name: "GovernmentJobs",
    // The agency pages below are the fast path; this search is the wide net, so every 5 min.
    keywords: ["EMT", "emergency medical technician", "firefighter trainee", "fire recruit", "firefighter recruit"],
    distanceMiles: 75,
    everyMinutes: 5,
  },
  // SFFD posts H-3 EMT/Paramedic through the City of SF's SmartRecruiters.
  {
    kind: "smartrecruiters",
    name: "City of SF",
    company: "CityAndCountyOfSanFrancisco1",
    // "Firefighter" catches SFFD's H-2 entry-level class.
    queries: ["EMT", "Firefighter"],
  },
  // Smaller agencies (Benicia, Moraga-Orinda, Pacifica, San Bruno…) use CalOpps.
  // Also rate-limits occasionally. One keyword: CalOpps' "EMT" search also matches the spelled-out title.
  { kind: "calopps", name: "CalOpps", keywords: ["EMT", "firefighter"], everyMinutes: 5 },
  ...Object.entries(FIRE_AGENCIES).map(([agency, { name, expectNonEmpty }]) => ({
    kind: "neogovAgency" as const,
    name,
    agency,
    expectNonEmpty,
  })),
  // Fire departments recruiting off FCTC's Statewide Eligibility List (you're on it). Mostly
  // "Firefighter Trainee/Recruit" rows; paramedic-only rows are dropped by the filter. Recruitments
  // stay open for days and the agency page / GovernmentJobs usually alert first.
  { kind: "fctc", name: "FCTC", everyMinutes: 5 },
];

/**
 * Agencies whose interest-list emails are forwarded to announce@morgannstovold.com. An announcement from one
 * of these is stored and watched: reminders before it opens, and an "OPEN NOW" emergency push when
 * one of its `sources` (SOURCES names) shows the posting. Adding another agency's list = one entry.
 */
export interface Announcer {
  name: string;
  /** Matched against the sender address. */
  from: RegExp;
  /** Senders from this agency that never send announcements (e.g. form-submission copies). */
  notFrom?: RegExp;
  sources: string[];
}

/**
 * Reminders before an announced opening, in minutes (24h, 3h, 10m). Ones within an hour of opening
 * push at priority 2 (repeat until acknowledged). REMINDER_OFFSETS_MIN in .env overrides the list.
 */
export const REMINDERS_MIN = [1440, 180, 10];
export const EMERGENCY_WITHIN_MIN = 60;

/**
 * Push priority by job type. 911 EMT positions are the goal: emergency (2, repeats every 30s until you
 * acknowledge it). Firefighter trainee/recruit openings are nice-to-haves: normal (0, a regular
 * notification that respects your Pushover quiet hours). 1 = high (sounds through quiet hours).
 */
export const PRIORITY = { emt: 2, ff: 0 } as const;

export const ANNOUNCERS: Announcer[] = [
  {
    name: "Sac City Fire",
    // TODO: check against a real Sac Fire email and tighten.
    from: /@cityofsacramento\.(org|gov)$|sacfire/i,
    // forms@cityofsacramento.org sends copies of form submissions, like your notification signup.
    notFrom: /^forms@/i,
    sources: ["Sac City Fire"],
  },
];
