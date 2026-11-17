export interface Job {
  /** Stable id, unique across sources: `${sourceName}:${nativeId}`. */
  id: string;
  source: string;
  title: string;
  employer: string;
  location: string;
  url: string;
  /** ISO date if the board provides one. */
  postedAt?: string;
  lat?: number;
  lng?: number;
  /** Extra detail shown in the alert (pay, shift type…). */
  detail?: string;
  /** Set by the filter, not the scrapers: EMT-B job or firefighter trainee/recruit. */
  category?: "emt" | "ff";
}
