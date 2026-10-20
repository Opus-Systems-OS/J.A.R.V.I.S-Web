// The globe's live layers (`/web/intel/layer/{id}`): what each row means,
// how it is drawn, where it is now (aircraft and ships dead-reckoned from
// their last report, satellites propagated from their orbits), and what
// the dossier and Jarvis are told when one is clicked.

import { degreesLat, degreesLong, eciToGeodetic, gstime, propagate, twoline2satrec } from "satellite.js";
import type { GlobeNode } from "./globe";

export type LayerId = "flights" | "military" | "ships" | "satellites" | "climate" | "bases";

export const LAYERS: { id: LayerId; label: string; color: string; refreshMs: number }[] = [
  { id: "flights", label: "Flights", color: "#9fd3ff", refreshMs: 15 * 60_000 },
  { id: "military", label: "Military air", color: "#ff4d6d", refreshMs: 2 * 60_000 },
  { id: "ships", label: "Ships", color: "#4fd1c5", refreshMs: 10 * 60_000 },
  { id: "satellites", label: "Satellites", color: "#e9e4ff", refreshMs: 6 * 3600_000 },
  { id: "climate", label: "Temperature", color: "#ffd23f", refreshMs: 30 * 60_000 },
  { id: "bases", label: "Bases", color: "#c084fc", refreshMs: 24 * 3600_000 },
];

/** Base markers by service (the row's detail starts with one of these). */
export const BRANCHES: Record<string, { label: string; color: string }> = {
  air: { label: "Air force", color: "#7fb2ff" },
  navy: { label: "Navy & marines", color: "#4fd1c5" },
  army: { label: "Army & joint", color: "#b5e86b" },
  space: { label: "Space", color: "#c084fc" },
};

export interface LayerData {
  generated_at: string;
  items: unknown[];
  error?: string;
}

/** `[id, label, detail, lat, lon, alt_m, speed_ms, track_deg, value]`. */
type Row = [string, string, string, number, number, number | null, number | null, number | null, number | null];
/** `[norad id, name, group, line1, line2]`. */
type Sat = [string, string, string, string, string];

/** What the dossier shows for a clicked mark. */
export interface Thing {
  layer: LayerId;
  kind: string;
  title: string;
  fields: [string, string][];
  pos(now: number): [number, number] | null;
}

// Cargo airlines by ICAO callsign prefix: the "trade" in the flight layer.
const CARGO = new Set(
  "FDX UPS GTI CLX ABW CKS BCS DHK DAE BOX GEC CAO CKK PAC ATN SOO NCA MPH AJT ABX KYE CSB TAY SQC QAC ETC CXK".split(" "),
);
const CARGO_COLOR = "#ffb25c";

const SHIP_KINDS: [number, number, string, string][] = [
  [30, 30, "Fishing", "#7ee081"],
  [35, 35, "Military", "#ff4d6d"],
  [55, 55, "Law enforcement", "#ff4d6d"],
  [60, 69, "Passenger", "#9fd3ff"],
  [70, 79, "Cargo", "#ffb25c"],
  [80, 89, "Tanker", "#ff7a1a"],
  [31, 32, "Towing", "#4fd1c5"],
  [52, 52, "Tug", "#4fd1c5"],
  [36, 37, "Pleasure craft", "#4fd1c5"],
];

const EARTH_M = 6_371_000;
/** How far ahead of a report a position is extrapolated before it stops. */
const MAX_DEAD_RECKON_MS = 15 * 60_000;

/** Where something heading `track` at `speed` m/s is after `ms`. */
export function deadReckon(lat: number, lon: number, track: number, speed: number, ms: number): [number, number] {
  const d = (speed * Math.min(ms, MAX_DEAD_RECKON_MS)) / 1000 / EARTH_M;
  const [p1, l1, t] = [(lat * Math.PI) / 180, (lon * Math.PI) / 180, (track * Math.PI) / 180];
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t));
  const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [(p2 * 180) / Math.PI, ((((l2 * 180) / Math.PI + 540) % 360) - 180)];
}

/** Blue (−30 °C) through cyan and yellow to red (40 °C). */
export function tempColor(c: number): string {
  const hue = 240 - (Math.max(-30, Math.min(40, c)) + 30) * (240 / 70);
  return `hsl(${hue.toFixed(0)} 90% 55% / 0.13)`;
}

const fmt = (n: number | null | undefined, unit: string, digits = 0) => (n === null || n === undefined ? "—" : `${n.toLocaleString("en-US", { maximumFractionDigits: digits })} ${unit}`);

/** A layer's rows as globe marks (grouped by colour) and their dossiers. */
export function layerMarks(id: LayerId, data: LayerData): { marks: GlobeNode[]; things: Map<string, Thing> } {
  const t0 = Date.parse(data.generated_at) || Date.now();
  const marks: GlobeNode[] = [];
  const things = new Map<string, Thing>();
  for (const item of data.items) {
    const key = `${id}:${(item as unknown[])[0]}`;
    const thing = id === "satellites" ? satellite(item as Sat) : fromRow(id, item as Row, t0);
    if (!thing) continue;
    const at = thing.pos(Date.now());
    if (!at) continue;
    const r = item as Row;
    marks.push({
      key,
      lat: at[0],
      lon: at[1],
      color: thing.color,
      weight: 0,
      label: thing.label,
      count: 1,
      shape: id === "flights" || id === "military" ? "plane" : id === "ships" ? "ship" : id === "satellites" ? "sat" : id === "bases" ? "base" : "cell",
      track: id === "satellites" ? null : r[7],
      pos: id === "climate" || id === "bases" ? undefined : thing.pos,
    });
    things.set(key, thing);
  }
  marks.sort((a, b) => a.color.localeCompare(b.color));
  return { marks, things };
}

function fromRow(id: LayerId, r: Row, t0: number): (Thing & { color: string; label: string }) | null {
  const [rid, label, detail, lat, lon, alt, speed, track, value] = r;
  const moving = speed !== null && track !== null && speed > 0.5;
  const pos = (now: number): [number, number] => (moving ? deadReckon(lat, lon, track, speed, now - t0) : [lat, lon]);
  const reported = `${Math.max(0, Math.round((Date.now() - t0) / 60_000))} min ago`;
  if (id === "bases") {
    const [branch, kinds, country, operators] = detail.split("|");
    const b = BRANCHES[branch] ?? BRANCHES.army;
    return {
      layer: id,
      kind: `${b.label} installation`,
      title: label,
      fields: [
        ["Service", b.label],
        ["Type", kinds || "—"],
        ["Country", country || "—"],
        ["Operator", operators || "not recorded"],
        ["Source", `Wikidata ${rid}`],
      ],
      pos,
      color: b.color,
      label: `${label} · ${b.label}`,
    };
  }
  if (id === "climate") {
    return {
      layer: id,
      kind: "Current conditions",
      title: `${value?.toFixed(0)}°C at ${lat.toFixed(0)}°, ${lon.toFixed(0)}°`,
      fields: [
        ["Temperature", fmt(value, "°C", 1)],
        ["Wind", `${fmt(speed, "m/s", 1)} from ${track ?? "—"}°`],
        ["Source", "Open-Meteo, 10° grid"],
      ],
      pos,
      color: tempColor(value ?? 0),
      label: `${label} · wind ${fmt(speed, "m/s")}`,
    };
  }
  if (id === "ships") {
    const code = Number(detail);
    const kind = SHIP_KINDS.find(([lo, hi]) => code >= lo && code <= hi);
    return {
      layer: id,
      kind: kind ? `${kind[2]} vessel` : "Vessel",
      title: label,
      fields: [
        ["MMSI", rid],
        ["Type", kind ? `${kind[2]} (AIS ${code})` : detail ? `AIS type ${detail}` : "not reported yet"],
        ["Speed", fmt(speed === null ? null : speed / 0.514444, "kn", 1)],
        ["Course", fmt(track, "°")],
        ["Reported", `${reported} (position extrapolated since)`],
      ],
      pos,
      color: kind?.[3] ?? "#4fd1c5",
      label: `${label}${kind ? ` · ${kind[2]}` : ""}`,
    };
  }
  const military = id === "military";
  const cargo = !military && CARGO.has(label.slice(0, 3));
  return {
    layer: id,
    kind: military ? "Military aircraft" : cargo ? "Cargo flight" : "Flight",
    title: label || rid,
    fields: [
      [military ? "Type · registration" : "Origin country", detail || "—"],
      ["ICAO 24-bit", rid],
      ["Altitude", fmt(alt === null ? null : alt / 0.3048, "ft")],
      ["Ground speed", fmt(speed === null ? null : speed / 0.514444, "kn")],
      ["Heading", fmt(track, "°")],
      ["Reported", `${reported} (position extrapolated since)`],
      ["Source", military ? "adsb.lol (public ADS-B)" : "OpenSky Network"],
    ],
    pos,
    color: military ? "#ff4d6d" : cargo ? CARGO_COLOR : "#9fd3ff",
    label: `${label || rid}${alt !== null ? ` · ${Math.round(alt / 0.3048).toLocaleString("en-US")} ft` : ""}`,
  };
}

function satellite([id, name, group, l1, l2]: Sat): (Thing & { color: string; label: string }) | null {
  let rec;
  try {
    rec = twoline2satrec(l1, l2);
  } catch {
    return null;
  }
  const where = (now: number) => {
    const date = new Date(now);
    const pv = propagate(rec, date);
    if (!pv || typeof pv.position !== "object") return null;
    const g = eciToGeodetic(pv.position, gstime(date));
    return { lat: degreesLat(g.latitude), lon: degreesLong(g.longitude), km: g.height };
  };
  const meanMotion = Number(l2.slice(52, 63));
  const military = group === "military";
  return {
    layer: "satellites",
    kind: military ? "Military satellite" : group === "station" ? "Space station" : "Satellite",
    title: name,
    get fields(): [string, string][] {
      const now = where(Date.now());
      return [
        ["NORAD ID", id],
        ["Altitude", fmt(now?.km, "km")],
        ["Inclination", `${Number(l2.slice(8, 16)).toFixed(1)}°`],
        ["Orbital period", meanMotion ? `${(1440 / meanMotion).toFixed(0)} min` : "—"],
        ["Elements", `CelesTrak, epoch ${l1.slice(18, 32).trim()}`],
      ];
    },
    pos: (now) => {
      const p = where(now);
      return p ? [p.lat, p.lon] : null;
    },
    color: military ? "#ff4d6d" : group === "station" ? "#ffffff" : "#e9e4ff",
    label: name,
  };
}

/** What Jarvis is asked about a clicked aircraft, ship, satellite or cell. */
export function thingPrompt(t: Thing, now = Date.now()): string {
  const at = t.pos(now);
  const facts = [...t.fields, ...(at ? [["Position now", `${at[0].toFixed(3)}, ${at[1].toFixed(3)}`] as [string, string]] : [])]
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");
  const ask =
    t.layer === "bases"
      ? "Brief me on this military installation: who operates it, the units, aircraft, ships or submarines based there, its role, and recent public news about it."
      : t.layer === "climate"
      ? "Brief me on current weather and climate conditions here: how this compares with normal for the season, any extremes, warnings or longer-term trends."
      : "Identify it (operator, type, purpose, and route or destination where public), say where it is heading and whether anything about it is unusual, and give any recent news involving it.";
  return [
    `[intel] ${ask} This is a ${t.kind.toLowerCase()} tracked on the Intel globe: "${t.title}".`,
    "Your reply is shown on screen, not spoken, so ignore the short spoken-reply rules: plain markdown (# headings, - bullets, no tables),",
    "beginning with one plain sentence that sums it up (read aloud). Research it with your web search and fetch tools first",
    "(public flight and ship trackers, registries, satellite catalogs), keep to public information, and say what you could not confirm.",
    "Tracked data:",
    facts,
  ].join("\n");
}
