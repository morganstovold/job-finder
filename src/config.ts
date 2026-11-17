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
  /\bH-?0?03\b/i, // SFFD H-3 "EMT & Paramedic" class
  /ambulance (attendant|operator)/i,
];

/** …and must not match any of these. */
export const TITLE_EXCLUDE: RegExp[] = [
  /instructor|faculty|professor|teacher|educat|coordinator|manager|director|supervisor|scheduler/i,
  /\bA-?EMT\b|advanced emt|emt-?a\b|emt-?p\b|emt-?i\b/i, // AEMT / paramedic-level
  /intern\b|internship|skillbridge|volunteer/i,
];

/** Firefighter/EMT titles are skipped unless they match this, e.g. "EMT (Non-Safety)". */
export const FIREFIGHTER_OK = /single[- ]role|non[- ]safety/i;

export type SourceConfig =
  | { kind: "gmr"; name: string; brands?: string[] }
  | { kind: "onshift"; name: string; tenant: string }
  | { kind: "neogov"; name: string; keywords: string[]; distanceMiles: number }
  | { kind: "smartrecruiters"; name: string; company: string; query: string }
  | { kind: "calopps"; name: string; keywords: string[] };

export const SOURCES: SourceConfig[] = [
  // AMR + sister brands (CrowdRx event EMT, etc.) - iCIMS JSON API, has coordinates.
  { kind: "gmr", name: "AMR / GMR" },
  // Falck Northern California (Alameda County 911). Falck runs a separate OnShift
  // tenant per region - add more here (find the slug from an apply link).
  // Occasionally rate-limits (403) - the worker backs off automatically.
  { kind: "onshift", name: "Falck NorCal", tenant: "falcknc" },
  // Most Bay Area / Sacramento fire districts & cities post on governmentjobs.com.
  {
    kind: "neogov",
    name: "GovernmentJobs",
    keywords: ["EMT", "emergency medical technician", "single role"],
    distanceMiles: 75,
  },
  // SFFD posts H-3 EMT/Paramedic through the City of SF's SmartRecruiters.
  {
    kind: "smartrecruiters",
    name: "City of SF",
    company: "CityAndCountyOfSanFrancisco1",
    query: "EMT",
  },
  // Smaller agencies (Benicia, Moraga-Orinda, Pacifica, San Bruno…) use CalOpps.
  // Also rate-limits occasionally. One keyword: CalOpps' "EMT" search also matches the spelled-out title.
  { kind: "calopps", name: "CalOpps", keywords: ["EMT"] },
];
