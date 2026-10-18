// What Jarvis says the moment you unlock. A template over live data, not a
// model call: instant, free (bar the voice's characters), and it never
// invents a number. The briefing (weather, calendar, mail, YouTube, WHOOP,
// Buffer — only what's worth saying), then the systems, then any low
// balance. Each unlock is recorded as a visit, so "new since you were last
// here" means since the last unlock on any device. Anyone but the owner is
// greeted by name and nothing else: the day and the systems are his. Any
// address the honeypot banned since the last visit is mentioned last.

import { get, web, webGet, type Profile } from "../api";
import { briefingLines, withLocalWeather, type Briefing } from "./briefing";
import { creditLine, type Credits } from "./credits";
import { freshWeather, here, localZone } from "./location";
import { compactOps } from "./tools";

export function salutation(now = new Date(), name = "Mr. Walker", tz = localZone()): string {
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(now));
  if (hour < 5) return `Burning the midnight oil, ${name}`;
  if (hour < 12) return `Good morning, ${name}`;
  if (hour < 18) return `Good afternoon, ${name}`;
  return `Good evening, ${name}`;
}

const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const say = (n: number) => WORDS[n] ?? String(n);

/** "All six systems are online." / "Five of six systems are online; Tailscale is reporting a warning." */
export function systemsLine(rows: { service: string; state: string; headline: string }[]): string {
  if (!rows.length) return "I can't reach the operations feed at the moment.";
  const ok = rows.filter((r) => r.state === "ok").length;
  const trouble = rows.filter((r) => r.state !== "ok");
  if (!trouble.length) return rows.length === 2 ? "Both systems are online." : `All ${say(rows.length)} systems are online.`;
  const names = trouble.map((r) => `${r.service} ${r.state === "down" ? "is down" : "is reporting a warning"}`);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const cap = (w: string) => `${w[0].toUpperCase()}${w.slice(1)}`;
  const lead = ok
    ? `${cap(say(ok))} of ${say(rows.length)} systems ${ok === 1 ? "is" : "are"} online`
    : "None of the systems are responding";
  return `${lead}; ${list}.`;
}

/** A ban the honeypot made (`/web/security`, unix seconds). */
export interface BanRow {
  ip: string;
  at: number;
}

/** "The honeypot has banned two addresses since your last visit." — or
 * nothing, when it banned none (or this is the first visit). */
export function defensesLine(bans: BanRow[], since: string | null): string | null {
  const from = since ? Date.parse(since) : NaN;
  if (!Number.isFinite(from)) return null;
  const fresh = bans.filter((b) => b.at * 1000 > from).length;
  if (!fresh) return null;
  return `The honeypot has banned ${say(fresh)} ${fresh === 1 ? "address" : "addresses"} since your last visit; they're under Systems, Defenses.`;
}

/** When where he is isn't known: ask, once a greeting. */
export const ASK_WHERE = "I don't know where you are yet; tell me your city, or allow location in the browser, and I'll keep the weather and times local.";

/** `located`: the unlock's location lookup, settled (or given up on) first. */
export async function greeting(profile: Profile, located: Promise<unknown> = Promise.resolve()): Promise<string> {
  const [visit] = await Promise.all([
    web<{ previous: string | null }>("visit", {}).catch(() => ({ previous: null })),
    located.catch(() => undefined),
  ]);
  const ask = here() ? [] : [ASK_WHERE];
  if (!profile.full) return [`${salutation(new Date(), profile.name)}.`, ...ask, "What can I do for you?"].join(" ");
  const since = visit.previous ? `?since=${encodeURIComponent(visit.previous)}` : "";
  const [ops, rig, credits, briefing, security] = await Promise.allSettled([
    get<Record<string, unknown>>("ops"),
    get<{ online?: boolean }>("rig"),
    webGet<Credits>("credits"),
    get<Briefing>(`briefing${since}`),
    webGet<{ bans: BanRow[] }>("security"),
  ]);
  const parts = [`${salutation()}.`];
  // No briefing (the key lacks sources:read, or the API is older): the
  // greeting is the weather where he is and the systems report.
  const day: Briefing = briefing.status === "fulfilled" ? briefing.value : { generated_at: "", since: null, sources: [] };
  parts.push(...briefingLines(withLocalWeather(day, freshWeather())));
  parts.push(...ask);
  parts.push(ops.status === "fulfilled" ? systemsLine(compactOps(ops.value)) : "I can't reach the operations feed at the moment.");
  if (rig.status === "fulfilled" && rig.value.online) parts.push("The rig is up, if you need local models.");
  const warning = credits.status === "fulfilled" ? creditLine(credits.value) : null;
  if (warning) parts.push(warning);
  const defenses = security.status === "fulfilled" ? defensesLine(security.value.bans ?? [], visit.previous) : null;
  if (defenses) parts.push(defenses);
  return parts.join(" ");
}
