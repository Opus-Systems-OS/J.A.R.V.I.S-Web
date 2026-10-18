// Reminders Jarvis sets (`set_reminder`), kept by jarvis-web (/web/reminders)
// so they survive the page. The HUD holding the mic checks every 15 s and
// speaks what is due; anything that came due with no HUD open is spoken at
// the next unlock, after the greeting.

import { web, webGet } from "../api";
import { localZone } from "./location";

export interface Reminder {
  id: number;
  text: string;
  due_at: string;
  due: boolean;
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

/** "Sir, a reminder: call Josh." */
export function reminderLine(r: Reminder): string {
  const text = r.text.trim().replace(/[.!]+$/, "");
  return `Sir, a reminder: ${text}.`;
}

export async function pending(): Promise<Reminder[]> {
  return (await webGet<{ reminders: Reminder[] }>("reminders")).reminders;
}

export async function create(text: string, at: string): Promise<Reminder> {
  return web<Reminder>("reminders", { text, at });
}

export async function cancel(id: number): Promise<void> {
  await web(`reminders/${id}/cancel`, {});
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
    if (this.busy || !this.on.speaks()) return;
    this.busy = true;
    try {
      for (const r of (await pending()).filter((r) => r.due)) {
        // Mark first: two HUDs racing for the lease must not both say it.
        const ok = await web(`reminders/${r.id}/delivered`, {})
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
