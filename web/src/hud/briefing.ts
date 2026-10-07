// The briefing: `/v1/briefing` (weather, calendar, Gmail, YouTube, WHOOP,
// Buffer) turned into the spoken lines of the greeting. A template, not a
// model: only the lines worth saying today, instant, and never an invented
// number. A source that is down or not connected is simply left out.

export interface SourceRow {
  id: string;
  name: string;
  state: string;
  headline: string;
  detail?: Record<string, unknown> | null;
}

export interface Briefing {
  generated_at: string;
  since: string | null;
  sources: SourceRow[];
}

const TZ = "America/Los_Angeles";
const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const say = (n: number) => WORDS[n] ?? String(n);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** "9 AM", "2:30 PM" in Calabasas. */
export function spokenTime(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(
    new Date(iso),
  );
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const minute = get("minute");
  return `${get("hour")}${minute === "00" ? "" : `:${minute}`} ${get("dayPeriod").toUpperCase()}`;
}

function hourIn(now: Date): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hour12: false }).format(now)) % 24;
}

/** The rows, or none when the API answered something else. */
const rowsOf = (b: Briefing): SourceRow[] => (Array.isArray(b?.sources) ? b.sources : []);

/** The detail of a source that answered. */
function detail(b: Briefing, id: string): Record<string, unknown> | null {
  const row = rowsOf(b).find((s) => s.id === id);
  return row && row.state !== "down" && row.detail ? row.detail : null;
}

export function weatherLine(d: Record<string, unknown>): string | null {
  const t = num(d.temperature_f);
  if (t === null) return null;
  let line = `It's ${t} degrees and ${str(d.conditions) ?? "fair"} in ${str(d.place) ?? "Calabasas"}`;
  const high = num(d.high_f);
  if (high !== null && high > t) line += `, heading for ${high}`;
  const rain = num(d.rain_chance_pct);
  if (rain !== null && rain >= 30) line += `, with a ${rain} percent chance of rain`;
  return `${line}.`;
}

export function calendarLine(d: Record<string, unknown>, now: Date): string | null {
  const events = (Array.isArray(d.events) ? d.events : []) as { title?: string; start?: string; all_day?: boolean }[];
  const upcoming = events.filter((e) => !e.all_day && e.start && Date.parse(e.start) > now.getTime());
  if (!upcoming.length) return null;
  const next = upcoming[0];
  const title = next.title || "an untitled event";
  if (upcoming.length === 1) return `You have ${title} at ${spokenTime(next.start as string)}.`;
  return `You have ${say(upcoming.length)} events left today; the first is ${title} at ${spokenTime(next.start as string)}.`;
}

export function mailLine(d: Record<string, unknown>, sinceKnown: boolean): string | null {
  const recent = (Array.isArray(d.recent) ? d.recent : []) as { from?: string }[];
  const fresh = num(d.new_since);
  const unread = num(d.unread) ?? 0;
  if (sinceKnown && fresh !== null) {
    if (!fresh) return null;
    const who = fresh <= 2 ? recent.slice(0, fresh).map((m) => m.from).filter(Boolean) : [];
    const noun = fresh === 1 ? "email" : "emails";
    const from = who.length ? `, from ${who.join(" and ")}` : "";
    return `${say(fresh).replace(/^./, (c) => c.toUpperCase())} new ${noun} since you were last here${from}.`;
  }
  if (!unread) return null;
  return `You have ${say(unread)} unread ${unread === 1 ? "email" : "emails"}.`;
}

export function youtubeLine(d: Record<string, unknown>): string | null {
  const pct = num(d.change_pct);
  if (pct === null || Math.abs(pct) < 10) return null;
  return `YouTube views are ${pct > 0 ? "up" : "down"} ${Math.abs(pct)} percent on the week before.`;
}

export function whoopLine(d: Record<string, unknown>, morning: boolean): string | null {
  const rec = num(d.recovery_pct);
  if (rec === null) return null;
  const band = str(d.band);
  if (band === "red") return `Recovery is only ${rec} percent; I'd take it easy today.`;
  if (band === "yellow") return `Recovery is ${rec} percent, middling.`;
  return morning ? `Recovery is ${rec} percent, in the green.` : null;
}

export function bufferLine(d: Record<string, unknown>): string | null {
  return num(d.queued) === 0 ? "The Buffer queue is empty; nothing is scheduled to post." : null;
}

/** The lines worth saying, in order. `now` for tests. */
export function briefingLines(b: Briefing, now = new Date()): string[] {
  const morning = hourIn(now) < 12;
  const lines = [
    detail(b, "weather") && weatherLine(detail(b, "weather") as Record<string, unknown>),
    detail(b, "calendar") && calendarLine(detail(b, "calendar") as Record<string, unknown>, now),
    detail(b, "gmail") && mailLine(detail(b, "gmail") as Record<string, unknown>, !!b.since),
    detail(b, "youtube") && youtubeLine(detail(b, "youtube") as Record<string, unknown>),
    detail(b, "whoop") && whoopLine(detail(b, "whoop") as Record<string, unknown>, morning),
    detail(b, "buffer") && bufferLine(detail(b, "buffer") as Record<string, unknown>),
  ];
  return lines.filter((l): l is string => !!l);
}

/** Compact, for Jarvis's `briefing` tool: rows with their detail. */
export function compactBriefing(b: Briefing): unknown {
  return {
    since: b.since,
    sources: rowsOf(b).map((s) => ({ source: s.id, state: s.state, headline: s.headline, detail: s.detail ?? undefined })),
  };
}
