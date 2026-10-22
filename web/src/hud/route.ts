// Driving directions from `/web/route` (Nominatim + OSRM, `route.rs`): what
// Jarvis's `directions` tool says, and the Apple Maps hand-off. Opening the
// route "here" draws it on the Intel globe (`intel/view.ts`).

export interface RoutePlace {
  name: string;
  lat: number;
  lon: number;
}

export interface Route {
  from: RoutePlace;
  to: RoutePlace;
  distance_m: number;
  duration_s: number;
  /** `[lon, lat]` pairs. */
  line: [number, number][];
  steps: { text: string; distance_m: number }[];
}

const MI = 1609.344;

/** Apple Maps directions from the start to the destination (driving). On
 * an iPhone or Mac the link opens the Maps app. */
export function appleMapsUrl(r: Route): string {
  const p = new URLSearchParams({
    saddr: `${r.from.lat},${r.from.lon}`,
    daddr: `${r.to.lat},${r.to.lon}`,
    dirflg: "d",
  });
  return `https://maps.apple.com/?${p}`;
}

/** "LAX" from "Los Angeles International Airport, World Way, Los Angeles, …". */
export const shortName = (r: Route) => r.to.name.split(",")[0].trim() || r.to.name;

export const miles = (m: number) => `${(m / MI).toFixed(m < 16_000 ? 1 : 0)} mi`;

export function minutes(s: number): string {
  const m = Math.max(1, Math.round(s / 60));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** A step's distance, in feet when short. */
export const stepDistance = (m: number) => (m < 300 ? `${Math.round(m / 0.3048 / 10) * 10} ft` : miles(m));
