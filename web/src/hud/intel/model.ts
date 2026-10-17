// The Intel feed as the page uses it: each item sorted into a category by
// its words, placed (by the feed, its state, or the gazetteer), and stories
// at the same place gathered into one node for the globe.

import { locate, stateByCode, type Place } from "./geo";

/** What `/web/intel/feed` and `/web/intel/search` hand over per story. */
export interface RawItem {
  id: string;
  kind: "news" | "quake" | "fire" | "storm" | "volcano" | "alert";
  title: string;
  summary: string;
  source: string;
  url: string;
  published?: string;
  lat?: number;
  lon?: number;
  place?: string;
  region?: string;
  severity?: number;
  feed: string;
}

export interface SourceStatus {
  name: string;
  ok: boolean;
  count: number;
  error?: string;
}

export interface Feed {
  generated_at: string;
  items: RawItem[];
  sources: SourceStatus[];
}

export interface Entry {
  title: string;
  description: string;
  extract: string;
  url: string;
}

export interface SearchResult {
  query: string;
  articles: RawItem[];
  entries: Entry[];
  errors?: string[];
}

export type Category =
  | "fire"
  | "violence"
  | "conflict"
  | "unrest"
  | "disaster"
  | "weather"
  | "politics"
  | "health"
  | "economy"
  | "other";

export const CATEGORIES: { id: Category; label: string; color: string }[] = [
  { id: "fire", label: "Fire", color: "#ff5a1f" },
  { id: "violence", label: "Violence & crime", color: "#ff2d55" },
  { id: "conflict", label: "Conflict", color: "#e040fb" },
  { id: "unrest", label: "Unrest", color: "#ffd23f" },
  { id: "disaster", label: "Disaster", color: "#ff9f1c" },
  { id: "weather", label: "Weather", color: "#4fd1c5" },
  { id: "politics", label: "Politics", color: "#ffe6cc" },
  { id: "health", label: "Health", color: "#7ee081" },
  { id: "economy", label: "Economy & tech", color: "#7fb2ff" },
  { id: "other", label: "Other", color: "#b88a5c" },
];
export const COLOR = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.color])) as Record<Category, string>;

// First match wins, so the more urgent categories come first.
const RULES: [Category, RegExp][] = [
  ["fire", /\b(wild ?fires?|fires?|blaze|burn(?:ing|ed)?|brush ?fire|red flag|evacuat\w*|arson|acres|containment|smoke)\b/i],
  [
    "violence",
    /\b(shoot\w*|shot|gunm[ae]n|gunfire|stabb\w*|murder\w*|homicide|kill(?:ed|ing|s)?|slay\w*|dead|deaths?|police|cops?|arrest\w*|suspect|charged|crime|kidnap\w*|hostage|assault\w*|robbery|manhunt|sheriff|fbi|bomb threat|lockdown)\b/i,
  ],
  [
    "conflict",
    /\b(war|wars|military|troops|missiles?|drones?|air ?strikes?|strikes? on|airstrike|invasion|ceasefire|cease-fire|shelling|artillery|hamas|hezbollah|houthis?|idf|nato|pentagon|army|navy|insurgen\w*|militants?|rebels?|terror\w*)\b/i,
  ],
  ["unrest", /\b(protests?|protesters?|demonstrat\w*|riots?|rally|rallies|march(?:es|ed)?|strike|walkout|unrest|clash(?:es)?|curfew|uprising|coup)\b/i],
  [
    "disaster",
    /\b(earthquakes?|quakes?|tsunami|volcan\w*|eruption|landslide|mudslide|floods?|flooding|explosion|blast|collapse\w*|derail\w*|crash(?:es|ed)?|plane|spill|disaster|emergency)\b/i,
  ],
  ["weather", /\b(hurricane|tropical|storms?|tornado\w*|blizzard|snow|heat ?wave|heat|freeze|frost|winds?|rain|weather|cyclone|typhoon|drought)\b/i],
  ["health", /\b(outbreak|virus|covid|flu|measles|vaccin\w*|disease|health|hospital\w*|cdc|fda|pandemic|overdose|cancer|bird flu|h5n1)\b/i],
  [
    "politics",
    /\b(trump|biden|harris|vance|congress|senate|house|republicans?|democrats?|gop|governor|mayor|election\w*|vote\w*|ballot|campaign|president|white house|supreme court|lawmakers?|legislat\w*|bill|policy|administration|minister|parliament|sanctions?|tariffs?|diplomat\w*|summit|court|judge|ruling|lawsuit)\b/i,
  ],
  [
    "economy",
    /\b(stocks?|markets?|economy|economic|inflation|fed|rates?|jobs|layoffs?|earnings|prices?|dollar|oil|bank\w*|trade|recession|ai|tech|apple|google|microsoft|nvidia|tesla|openai|crypto|bitcoin)\b/i,
  ],
];

export function classify(item: Pick<RawItem, "kind" | "title" | "summary">): Category {
  switch (item.kind) {
    case "fire":
      return "fire";
    case "quake":
    case "volcano":
      return "disaster";
    case "storm":
      return "weather";
    case "alert":
      return /flood|surge|tsunami|dam\b/i.test(item.title) ? "disaster" : "weather";
  }
  // The headline decides; the summary only when the headline says nothing.
  for (const text of [item.title, item.summary]) {
    for (const [cat, re] of RULES) if (re.test(text)) return cat;
  }
  return "other";
}

export interface Story extends RawItem {
  category: Category;
  where: Place | null;
}

export function toStory(item: RawItem): Story {
  let where: Place | null = null;
  if (typeof item.lat === "number" && typeof item.lon === "number") {
    where = { lat: item.lat, lon: item.lon, name: item.place || item.title, level: 4 };
  } else if (item.region) {
    const s = stateByCode(item.region);
    // Spread one state's alerts a little so they don't stack on one pixel.
    if (s) where = { ...s, lat: s.lat + jitter(item.id, 0), lon: s.lon + jitter(item.id, 1), name: item.place ? `${item.place} · ${s.name}` : s.name };
  } else {
    where = locate(item.title) ?? (item.summary ? locate(item.summary) : null);
  }
  return { ...item, category: classify(item), where };
}

function jitter(id: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (((h >>> 0) % 1000) / 1000 - 0.5) * 1.6;
}

export interface IntelNode {
  key: string;
  name: string;
  lat: number;
  lon: number;
  stories: Story[];
  category: Category;
  /** 0–1: how loud the node is (story count and hazard severity). */
  weight: number;
}

const URGENCY: Category[] = ["violence", "fire", "conflict", "disaster", "unrest", "weather", "health", "politics", "economy", "other"];

/** Stories at one place make one node; hazards keep their own spot. */
export function cluster(stories: Story[]): IntelNode[] {
  const nodes = new Map<string, IntelNode>();
  for (const s of stories) {
    if (!s.where) continue;
    const key = s.where.level === 4 ? `${s.kind}:${s.where.lat.toFixed(2)},${s.where.lon.toFixed(2)}` : `place:${s.where.name}`;
    const n = nodes.get(key);
    if (n) n.stories.push(s);
    else nodes.set(key, { key, name: s.where.name, lat: s.where.lat, lon: s.where.lon, stories: [s], category: s.category, weight: 0 });
  }
  for (const n of nodes.values()) {
    const counts = new Map<Category, number>();
    for (const s of n.stories) counts.set(s.category, (counts.get(s.category) ?? 0) + 1);
    n.category = [...counts.entries()].sort((a, b) => b[1] - a[1] || URGENCY.indexOf(a[0]) - URGENCY.indexOf(b[0]))[0][0];
    const severity = Math.max(0, ...n.stories.map((s) => s.severity ?? 0));
    n.weight = Math.min(1, Math.max(severity, Math.sqrt(n.stories.length) / 4));
    n.stories.sort((a, b) => (b.published ?? "").localeCompare(a.published ?? ""));
  }
  return [...nodes.values()].sort((a, b) => b.weight - a.weight);
}

/** "3 h ago", "just now". */
export function ago(iso?: string, now = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const m = Math.round((now - t) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}
