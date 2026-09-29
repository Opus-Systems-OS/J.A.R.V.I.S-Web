// What Jarvis says the moment you unlock. A template over live data, not a
// model call: instant, free (bar the voice's characters), and it never
// invents a number. The briefing (weather, calendar, mail, YouTube, WHOOP,
// Buffer — only what's worth saying), then the systems, then any low
// balance. Each unlock is recorded as a visit, so "new since you were last
// here" means since the last unlock on any device.

import { get, web, webGet } from "../api";
import { briefingLines, type Briefing } from "./briefing";
import { creditLine, type Credits } from "./credits";
import { compactOps } from "./tools";

const TZ = "America/Los_Angeles";

export function salutation(now = new Date()): string {
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hour12: false }).format(now));
  if (hour < 5) return "Burning the midnight oil, Mr. Walker";
  if (hour < 12) return "Good morning, Mr. Walker";
  if (hour < 18) return "Good afternoon, Mr. Walker";
  return "Good evening, Mr. Walker";
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

export async function greeting(): Promise<string> {
  const visit = await web<{ previous: string | null }>("visit", {}).catch(() => ({ previous: null }));
  const since = visit.previous ? `?since=${encodeURIComponent(visit.previous)}` : "";
  const [ops, rig, credits, briefing] = await Promise.allSettled([
    get<Record<string, unknown>>("ops"),
    get<{ online?: boolean }>("rig"),
    webGet<Credits>("credits"),
    get<Briefing>(`briefing${since}`),
  ]);
  const parts = [`${salutation()}.`];
  // No briefing (the key lacks sources:read, or the API is older): the
  // greeting is the systems report it always was.
  if (briefing.status === "fulfilled") parts.push(...briefingLines(briefing.value));
  parts.push(ops.status === "fulfilled" ? systemsLine(compactOps(ops.value)) : "I can't reach the operations feed at the moment.");
  if (rig.status === "fulfilled" && rig.value.online) parts.push("The rig is up, if you need local models.");
  const warning = credits.status === "fulfilled" ? creditLine(credits.value) : null;
  if (warning) parts.push(warning);
  return parts.join(" ");
}
