// Reminders Jarvis sets (`set_reminder`), kept by jarvis-web (/web/reminders)
// so they survive the page. The HUD holding the mic checks every 15 s and
// speaks what is due; anything that came due with no HUD open is spoken at
// the next unlock, after the greeting. Nothing is spoken in quiet hours
// (midnight to 5 am his time): it waits for 5 am, or the next unlock after.
// The server keeps a recurring reminder's rule; the HUD, which has the time
// zones, works out its next time when it is spoken. Notes and tasks are kept
// beside them (/web/notes), without a time.

import { web, webGet } from "../api";
import { localZone } from "./location";

export interface Reminder {
  id: number;
  text: string;
  due_at: string;
  due: boolean;
  /** `daily`, `weekdays`, `weekly:1,3,5` (0 = Sunday) or `every:N` days. */
  repeat?: string | null;
  /** A recurring reminder's wall time, `HH:MM`. */
  wall?: string | null;
}

export interface Note {
  id: number;
  kind: "note" | "task";
  text: string;
  created_at: string;
}

/** Now as his wall time with its offset, e.g. `2026-09-28T15:04:00-07:00`. */
export function localNow(now = new Date(), tz = localZone()): string {
  return localIso(now, tz);
}

/** An instant as wall time in `tz` (his, by default) with its offset. */
export function localIso(d: Date, tz = localZone()): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const offMin = Math.round((wall - Math.floor(d.getTime() / 1000) * 1000) / 60_000);
  const sign = offMin < 0 ? "-" : "+";
  const abs = Math.abs(offMin);
  const off = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${off}`;
}

/**
 * What `set_reminder` was given → an RFC 3339 time with an offset:
 * `in_minutes` from now, or `at` — with an offset as is, or a bare wall
 * time (`2026-09-29T09:00`) read as his time.
 */
export function resolveAt(args: { at?: unknown; in_minutes?: unknown }, now = new Date(), tz = localZone()): string | null {
  if (typeof args.in_minutes === "number" && args.in_minutes > 0) {
    return localIso(new Date(now.getTime() + args.in_minutes * 60_000), tz);
  }
  if (typeof args.at !== "string" || !args.at.trim()) return null;
  const at = args.at.trim();
  if (/([+-]\d\d:\d\d|Z)$/.test(at)) return Number.isNaN(Date.parse(at)) ? null : at;
  const m = /^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)(?::(\d\d))?$/.exec(at);
  if (!m) return null;
  // Read the wall time as UTC, then shift by the zone's offset there (twice,
  // in case the shift crosses a DST change); the right instant reads back as
  // the same wall time. None does in a spring-forward gap.
  const wall = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? "00"}`;
  const asUtc = Date.parse(`${wall}Z`);
  if (Number.isNaN(asUtc)) return null;
  const offsetMs = (t: number) => {
    const iso = localIso(new Date(t), tz);
    return Date.parse(`${iso.slice(0, 19)}Z`) - t;
  };
  let t = asUtc - offsetMs(asUtc);
  t = asUtc - offsetMs(t);
  const iso = localIso(new Date(t), tz);
  return iso.startsWith(wall) ? iso : null;
}

const DAY_MS = 86_400_000;

/**
 * A recurring reminder's next time after `after`, at its wall time in `tz`:
 * the first one only, so a missed reminder fires late once and the schedule
 * resumes. `every:N` counts on from its own last day; the others from today.
 */
export function nextDue(r: Pick<Reminder, "due_at" | "repeat" | "wall">, after = new Date(), tz = localZone()): string | null {
  if (!r.repeat || !r.wall) return null;
  const [rule, arg = ""] = r.repeat.split(":");
  const every = rule === "every" ? Number(arg) : 1;
  if (!(every >= 1)) return null;
  const days = rule === "weekly" ? arg.split(",").map(Number) : rule === "weekdays" ? [1, 2, 3, 4, 5] : null;
  const day = (d: Date) => Date.parse(`${localIso(d, tz).slice(0, 10)}T00:00Z`);
  const today = day(after);
  const start = rule === "every" ? day(new Date(r.due_at)) : today;
  const skip = Math.max(0, Math.floor((today - start) / DAY_MS / every) - 1) * every;
  // A wall time lost to spring forward is said an hour later.
  const later = `${String(Number(r.wall.slice(0, 2)) + 1).padStart(2, "0")}${r.wall.slice(2)}`;
  for (let i = skip; i <= skip + 8 * every; i += every) {
    const d = new Date(start + i * DAY_MS);
    if (days && !days.includes(d.getUTCDay())) continue;
    const date = d.toISOString().slice(0, 10);
    const at = resolveAt({ at: `${date}T${r.wall}` }, after, tz) ?? resolveAt({ at: `${date}T${later}` }, after, tz);
    if (at && Date.parse(at) > after.getTime()) return at;
  }
  return null;
}

/** Midnight to 5 am his time: reminders wait. */
export function quiet(now = new Date(), tz = localZone()): boolean {
  return Number(localIso(now, tz).slice(11, 13)) < 5;
}

/** "Sir, a reminder: call Josh." */
export function reminderLine(r: Reminder): string {
  const text = r.text.trim().replace(/[.!]+$/, "");
  return `Sir, a reminder: ${text}.`;
}

export async function pending(): Promise<Reminder[]> {
  return (await webGet<{ reminders: Reminder[] }>("reminders")).reminders;
}

export async function create(text: string, at: string, repeat?: string): Promise<Reminder> {
  return web<Reminder>("reminders", { text, at, repeat });
}

export async function cancel(id: number): Promise<void> {
  await web(`reminders/${id}/cancel`, {});
}

/** Again in `minutes` (10 by default): reminder `id`, or the one spoken last. */
export async function snooze(id?: number, minutes?: number): Promise<Reminder> {
  return web<Reminder>("reminders/snooze", { id, minutes });
}

export async function notes(): Promise<Note[]> {
  return (await webGet<{ notes: Note[] }>("notes")).notes;
}

export async function addNote(text: string, kind: Note["kind"] = "note"): Promise<Note> {
  return web<Note>("notes", { text, kind });
}

export async function closeNote(id: number): Promise<void> {
  await web(`notes/${id}/close`, {});
}

/** Speaks due reminders while this HUD holds the mic. */
export class ReminderWatch {
  private timer = 0;
  private busy = false;

  constructor(
    private readonly on: {
      /** True while this HUD is the one that speaks. */
      speaks(): boolean;
      announce(line: string): void;
    },
  ) {}

  start() {
    this.timer = window.setInterval(() => void this.check(), 15_000);
  }

  stop() {
    window.clearInterval(this.timer);
  }

  async check() {
    if (this.busy || !this.on.speaks() || quiet()) return;
    this.busy = true;
    try {
      for (const r of (await pending()).filter((r) => r.due)) {
        // Mark first: two HUDs racing for the lease must not both say it.
        // A recurring one moves on to its next time instead of closing.
        const ok = await web(`reminders/${r.id}/delivered`, r.repeat ? { next_at: nextDue(r) } : {})
          .then(() => true)
          .catch(() => false);
        if (ok) this.on.announce(reminderLine(r));
      }
    } catch {
      /* next tick */
    } finally {
      this.busy = false;
    }
  }
}
