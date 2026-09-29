// Reminders Jarvis sets (`set_reminder`), kept by jarvis-web (/web/reminders)
// so they survive the page. The HUD holding the mic checks every 15 s and
// speaks what is due; anything that came due with no HUD open is spoken at
// the next unlock, after the greeting.

import { web, webGet } from "../api";

const TZ = "America/Los_Angeles";

export interface Reminder {
  id: number;
  text: string;
  due_at: string;
  due: boolean;
}

/** Now as Calabasas wall time with its offset, e.g. `2026-09-28T15:04:00-07:00`. */
export function laNow(now = new Date()): string {
  return laIso(now);
}

/** An instant as Calabasas wall time with its offset. */
export function laIso(d: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
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
 * time (`2026-09-29T09:00`) read as Calabasas time.
 */
export function resolveAt(args: { at?: unknown; in_minutes?: unknown }, now = new Date()): string | null {
  if (typeof args.in_minutes === "number" && args.in_minutes > 0) {
    return laIso(new Date(now.getTime() + args.in_minutes * 60_000));
  }
  if (typeof args.at !== "string" || !args.at.trim()) return null;
  const at = args.at.trim();
  if (/([+-]\d\d:\d\d|Z)$/.test(at)) return Number.isNaN(Date.parse(at)) ? null : at;
  const m = /^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)(?::(\d\d))?$/.exec(at);
  if (!m) return null;
  // Try both Pacific offsets; the right one reads back as the same wall time.
  for (const off of ["-07:00", "-08:00"]) {
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? "00"}${off}`;
    const t = Date.parse(iso);
    if (!Number.isNaN(t) && laIso(new Date(t)) === iso) return iso;
  }
  return null;
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
