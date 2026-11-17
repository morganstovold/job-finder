import {
  FF_TRAINEE_EXCLUDE,
  FF_TRAINEE_INCLUDE,
  FIREFIGHTER_OK,
  HOME,
  IFT_EXCLUDE,
  TITLE_EXCLUDE,
  TITLE_INCLUDE,
} from "./config.ts";
import type { Job } from "./types.ts";

export type Category = "emt" | "ff";

const isEmtTitle = (title: string) => {
  if (!TITLE_INCLUDE.some((r) => r.test(title))) return false;
  if (TITLE_EXCLUDE.some((r) => r.test(title))) return false;
  if (IFT_EXCLUDE.test(title) && !/\b911\b/.test(title)) return false;
  // Firefighter jobs aren't EMT jobs unless they say single-role / non-safety.
  if (/fire ?fighter|fire recruit/i.test(title) && !FIREFIGHTER_OK.test(title)) return false;
  return true;
};

const isFfTraineeTitle = (title: string) =>
  FF_TRAINEE_INCLUDE.test(title) &&
  !FF_TRAINEE_EXCLUDE.test(title) &&
  // Paramedic-only (needs a paramedic license): "Fire Recruit (EMT/Paramedic)" passes, "Firefighter Recruit - Paramedic" doesn't.
  !(/paramedic/i.test(title) && !/\bEMT\b/i.test(title));

/** "emt" for EMT-B jobs (incl. single-role fire EMT), "ff" for firefighter trainee/recruit, else null. EMT rules first. */
export const classifyTitle = (title: string): Category | null =>
  isEmtTitle(title) ? "emt" : isFfTraineeTitle(title) ? "ff" : null;

const toRad = (d: number) => (d * Math.PI) / 180;

export const milesFromHome = (lat: number, lng: number) => {
  const dLat = toRad(lat - HOME.lat);
  const dLng = toRad(lng - HOME.lng);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(HOME.lat)) * Math.cos(toRad(lat)) * Math.sin(dLng / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(a));
};

/** Jobs with coordinates must be inside the radius; jobs without were already location-filtered by their source. */
export const isInRange = (job: Job) =>
  job.lat == null || job.lng == null || milesFromHome(job.lat, job.lng) <= HOME.radiusMiles;

export const isMatch = (job: Job) => classifyTitle(job.title) !== null && isInRange(job);

/** The job tagged with its category, or null if it's not a match. */
export const categorize = (job: Job): (Job & { category: Category }) | null => {
  const category = classifyTitle(job.title);
  return category && isInRange(job) ? { ...job, category } : null;
};
