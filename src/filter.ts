import { FIREFIGHTER_OK, HOME, IFT_EXCLUDE, TITLE_EXCLUDE, TITLE_INCLUDE } from "./config.ts";
import type { Job } from "./types.ts";

export const isEmtTitle = (title: string) => {
  if (!TITLE_INCLUDE.some((r) => r.test(title))) return false;
  if (TITLE_EXCLUDE.some((r) => r.test(title))) return false;
  if (IFT_EXCLUDE.test(title) && !/\b911\b/.test(title)) return false;
  // Firefighter/EMT needs an academy - skip unless it says single-role / non-safety.
  if (/fire ?fighter/i.test(title) && !FIREFIGHTER_OK.test(title)) return false;
  return true;
};

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

export const isMatch = (job: Job) => isEmtTitle(job.title) && isInRange(job);
