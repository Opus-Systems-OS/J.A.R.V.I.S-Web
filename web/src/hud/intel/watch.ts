// The Intel watchlist, kept per profile by jarvis-web (/web/watches): a word
// ("fire", "Ukraine"), a place and radius ("within 50 mi of Calabasas"), or
// both. The HUD holding the mic checks the feed every 5 min and speaks what
// is new; `seen` marks it on the server first, so two HUDs never both say
// it and the next unlock picks up what came in while none was open.
//
// Nothing here imports the feed model or gazetteer statically: they load
// with the first check, like the Intel tab itself.

import { web, webGet } from "../../api";
import { here, placeName } from "../location";
import type { Feed, Story } from "./model";

export interface Watch {
  id: number;
  term: string | null;
  place: string | null;
  lat: number | null;
  lon: number | null;
  radius_km: number | null;
  /** Unix seconds. */
  created_at: number;
}

const CHECK_MS = 5 * 60_000;
/** Older stories are not news to announce, whenever the watch was made. */
const FRESH_MS = 24 * 3600_000;
export const KM_PER_MI = 1.609344;
/** The server marks at most this many per check (`watches.rs`). */
const MAX_MARK = 300;

export async function list(): Promise<Watch[]> {
  return (await webGet<{ watches: Watch[] }>("watches")).watches;
}

export async function add(w: NewWatch): Promise<Watch> {
  return web<Watch>("watches", w);
}

export async function remove(id: number): Promise<void> {
  await web(`watches/${id}/remove`, {});
}

export type NewWatch = { term?: string; place?: string; lat?: number; lon?: number; radius_km?: number };

/** A term, a place to watch near ("me": where he is, else one the Intel
 * gazetteer knows) and miles (50 if not said) → a new watch, or what is
 * wrong with them. */
export async function resolve(args: { term?: unknown; near?: unknown; radius_mi?: unknown }): Promise<NewWatch | string> {
  const term = typeof args.term === "string" ? args.term.trim() : "";
  const near = typeof args.near === "string" ? args.near.trim() : "";
  if (!term && !near) return "give a term, a place to watch near, or both";
  if (!near) return { term };
  const miles = typeof args.radius_mi === "number" && args.radius_mi > 0 ? args.radius_mi : 50;
  let at: { lat: number; lon: number; name: string } | null;
  if (/^(me|here|my location|where i am)$/i.test(near)) {
    const h = here();
    if (!h) return "I don't know where he is yet: ask him, then set_location";
    at = { lat: h.lat, lon: h.lon, name: placeName(h) ?? "your location" };
  } else {
    const { locate } = await import("./geo");
    at = locate(near);
    if (!at) return `the Intel map doesn't know ${near}; try the nearest city, or a state`;
  }
  return { ...(term ? { term } : {}), place: at.name, lat: at.lat, lon: at.lon, radius_km: Math.round(miles * KM_PER_MI) };
}

/** "fire within 50 mi of Calabasas", "Ukraine", "anything within 25 mi of Austin, TX". */
export function describe(w: Watch): string {
  const near = w.place && w.radius_km ? `within ${Math.round(w.radius_km / KM_PER_MI)} mi of ${w.place}` : "";
  if (w.term && near) return `${w.term} ${near}`;
  return w.term ?? `anything ${near}`;
}

export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether `s` is something `w` watches for. A term matches a whole word of
 * the headline, summary or place, or the story's category ("fire"). A place
 * matches a story placed within the radius at city level or finer: a story
 * only placed at "California" is not near Calabasas. */
export function matches(w: Watch, s: Story): boolean {
  if (w.term) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escape(w.term)}($|[^\\p{L}\\p{N}])`, "iu");
    const hit = re.test(s.title) || re.test(s.summary) || (s.where ? re.test(s.where.name) : false) || s.category === w.term.toLowerCase();
    if (!hit) return false;
  }
  if (w.lat !== null && w.lon !== null && w.radius_km) {
    if (!s.where || s.where.level < 3) return false;
    if (distanceKm(s.where, { lat: w.lat, lon: w.lon }) > w.radius_km) return false;
  }
  return true;
}

/** The new stories each watch caught: published since it was made, and in the last day. */
export function hits(watches: Watch[], stories: Story[], now = Date.now()): { story: Story; watch: Watch }[] {
  const out: { story: Story; watch: Watch }[] = [];
  for (const story of stories) {
    const t = story.published ? Date.parse(story.published) : NaN;
    if (!Number.isFinite(t) || now - t > FRESH_MS) continue;
    const watch = watches.find((w) => t >= w.created_at * 1000 && matches(w, story));
    if (watch) out.push({ story, watch });
  }
  return out;
}

/** "Sir, on your watchlist: …". One story is read in full; more are counted. */
export function alertLine(found: { story: Story; watch: Watch }[]): string {
  const head = (s: Story) => s.title.trim().replace(/[.!]+$/, "");
  if (found.length === 1) return `Sir, on your watchlist, ${describe(found[0].watch)}: ${head(found[0].story)}.`;
  const shown = found.slice(0, 2).map((f) => head(f.story));
  const more = found.length - shown.length;
  return `Sir, ${found.length} new items on your watchlist. ${shown.join(". ")}.${more ? ` And ${more} more on the Intel tab.` : ""}`;
}

/** Speaks new watchlist hits while this HUD holds the mic. */
export class WatchAlerts {
  private timer = 0;
  private busy = false;

  constructor(
    private readonly on: {
      speaks(): boolean;
      announce(line: string): void;
    },
  ) {}

  start() {
    this.timer = window.setInterval(() => void this.check(), CHECK_MS);
  }

  stop() {
    window.clearInterval(this.timer);
  }

  async check() {
    if (this.busy || !this.on.speaks()) return;
    this.busy = true;
    try {
      const watches = await list();
      if (!watches.length) return;
      const [{ toStory }, feed] = await Promise.all([import("./model"), webGet<Feed>("intel/feed")]);
      const found = hits(watches, feed.items.map(toStory)).slice(0, MAX_MARK);
      if (!found.length) return;
      // Mark first: only what the server hadn't seen is said.
      const { new: fresh } = await web<{ new: string[] }>("watches/seen", { items: found.map((f) => f.story.id) });
      const said = found.filter((f) => fresh.includes(f.story.id));
      if (said.length) this.on.announce(alertLine(said));
    } catch {
      /* next tick */
    } finally {
      this.busy = false;
    }
  }
}
