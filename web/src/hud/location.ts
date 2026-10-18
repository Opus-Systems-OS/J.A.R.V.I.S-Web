// Where he is, so Jarvis isn't stuck in Calabasas. On unlock the HUD asks
// the browser for its position (the browser prompts the first time), or he
// names a place to Jarvis (`set_location`); `/web/local` turns either into a
// place name, that place's time zone and the weather there. Kept in this
// browser, so the next unlock already knows. Everything that tells time —
// the clock, the greeting, reminders — reads the zone from here: his
// place's, else this device's.

import { webGet } from "../api";

export interface Here {
  place: string | null;
  region: string | null;
  country: string | null;
  lat: number;
  lon: number;
  time_zone: string | null;
  /** The briefing's weather detail, as of `weather_at`. */
  weather: Record<string, unknown> | null;
  weather_at: number;
  /** "device": the browser's position; "named": he said where he is. */
  source: "device" | "named";
  at: number;
}

const KEY = "jarvis.location";
/** A place he named holds this long against what the device says. */
const NAMED_HOLDS_MS = 6 * 60 * 60 * 1000;

function load(): Here | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Here | null;
    return v && Number.isFinite(v.lat) && Number.isFinite(v.lon) ? v : null;
  } catch {
    return null;
  }
}

let current: Here | null = load();
const listeners = new Set<(h: Here | null) => void>();

function set(h: Here | null) {
  current = h;
  try {
    if (h) localStorage.setItem(KEY, JSON.stringify(h));
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode: known until the page closes */
  }
  listeners.forEach((f) => f(h));
}

export function here(): Here | null {
  return current;
}

export function onChange(f: (h: Here | null) => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

/** For tests. */
export function setHere(h: Here | null) {
  set(h);
}

/** This device's zone, if the browser says one. */
export function deviceZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** The zone times are told in: his place's, else this device's. */
export function localZone(): string {
  return current?.time_zone || deviceZone();
}

/** "Austin, Texas", "London, England", "Tokyo, JP" — or null. */
export function placeName(h: Here | null = current): string | null {
  if (!h?.place) return null;
  const tail = h.region && h.region !== h.place ? h.region : h.country;
  return tail ? `${h.place}, ${tail}` : h.place;
}

/** The sentence that tells Jarvis where he is. */
export function whereLine(h: Here | null = current): string {
  const zone = h?.time_zone || deviceZone();
  const name = placeName(h);
  if (h && name) return `He is in ${name}; use ${zone} for times and dates.`;
  if (h) return `He is near ${h.lat.toFixed(2)}, ${h.lon.toFixed(2)}; use ${zone} for times and dates.`;
  return `Where he is isn't known yet: use ${zone} for times and dates, and if it matters, ask him and call set_location.`;
}

interface Local {
  place: string | null;
  region: string | null;
  country: string | null;
  lat: number;
  lon: number;
  time_zone: string | null;
  weather: Record<string, unknown> | null;
}

const toHere = (l: Local, source: Here["source"]): Here => ({
  place: l.place,
  region: l.region,
  country: l.country,
  lat: l.lat,
  lon: l.lon,
  time_zone: l.time_zone,
  weather: l.weather,
  weather_at: Date.now(),
  source,
  at: Date.now(),
});

export type DeviceResult = "located" | "denied" | "unavailable";

/** The browser's position, asking for permission if it hasn't been given. */
function position(timeoutMs: number): Promise<GeolocationPosition | "denied" | "unavailable"> {
  if (!("geolocation" in navigator)) return Promise.resolve("unavailable");
  return new Promise((resolve) =>
    navigator.geolocation.getCurrentPosition(
      resolve,
      (e) => resolve(e.code === e.PERMISSION_DENIED ? "denied" : "unavailable"),
      { enableHighAccuracy: false, timeout: timeoutMs, maximumAge: 10 * 60 * 1000 },
    ),
  );
}

/**
 * Ask the device where it is and look the place up. A place he named in the
 * last few hours stands (a laptop's guess shouldn't overrule him); its
 * weather is refreshed instead.
 */
export async function locateDevice(timeoutMs = 15_000, force = false): Promise<DeviceResult> {
  if (!force && current?.source === "named" && Date.now() - current.at < NAMED_HOLDS_MS) {
    await refresh();
    return "located";
  }
  const pos = await position(timeoutMs);
  if (typeof pos === "string") return pos;
  const { latitude, longitude } = pos.coords;
  const l = await webGet<Local>(`local?lat=${latitude.toFixed(4)}&lon=${longitude.toFixed(4)}`);
  set(toHere(l, "device"));
  return "located";
}

/** He said where he is: "Austin, TX". Throws if no such place. */
export async function locateNamed(q: string): Promise<Here> {
  const l = await webGet<Local>(`local?q=${encodeURIComponent(q.trim())}`);
  const h = toHere(l, "named");
  set(h);
  return h;
}

/** Fresh weather (and zone) for where he already is. */
export async function refresh(): Promise<Here | null> {
  const h = current;
  if (!h) return null;
  const l = await webGet<Local>(`local?lat=${h.lat}&lon=${h.lon}`);
  const next: Here = {
    ...h,
    time_zone: h.time_zone || l.time_zone,
    weather: l.weather ? { ...l.weather, place: h.place ?? l.place } : h.weather,
    weather_at: l.weather ? Date.now() : h.weather_at,
  };
  set(next);
  return next;
}

/** His weather, if it is fresh enough to speak (half an hour). */
export function freshWeather(h: Here | null = current, now = Date.now()): Record<string, unknown> | null {
  return h?.weather && now - (h.weather_at ?? 0) < 30 * 60 * 1000 ? h.weather : null;
}
