import { describe, expect, it } from "vitest";
import { briefingLines, calendarLine, mailLine, spokenTime, type Briefing } from "./briefing";
import { laIso, reminderLine, resolveAt } from "./reminders";

// 2026-09-28 08:30 in Calabasas (PDT).
const MORNING = new Date("2026-09-28T15:30:00Z");

const briefing = (since: string | null): Briefing => ({
  generated_at: "2026-09-28T15:30:00Z",
  since,
  sources: [
    { id: "weather", name: "Weather", state: "ok", headline: "", detail: { place: "Calabasas", temperature_f: 67, conditions: "clear", high_f: 81, rain_chance_pct: 0 } },
    { id: "calendar", name: "Calendar", state: "ok", headline: "", detail: { events: [
      { title: "Early call", start: "2026-09-28T07:00:00-07:00", all_day: false },
      { title: "Standup", start: "2026-09-28T09:00:00-07:00", all_day: false },
      { title: "Design review", start: "2026-09-28T14:30:00-07:00", all_day: false },
    ] } },
    { id: "gmail", name: "Gmail", state: "ok", headline: "", detail: { unread: 8, new_since: 2, recent: [{ from: "Acme" }, { from: "Josh" }] } },
    { id: "youtube", name: "YouTube", state: "ok", headline: "", detail: { change_pct: 68 } },
    { id: "whoop", name: "WHOOP", state: "down", headline: "not connected", detail: { error: "not connected" } },
    { id: "buffer", name: "Buffer", state: "warn", headline: "queue empty", detail: { queued: 0 } },
  ],
});

describe("the briefing", () => {
  it("says only what is worth saying, in order", () => {
    expect(briefingLines(briefing("2026-09-27T20:00:00Z"), MORNING)).toEqual([
      "It's 67 degrees and clear in Calabasas, heading for 81.",
      "You have two events left today; the first is Standup at 9 AM.",
      "Two new emails since you were last here, from Acme and Josh.",
      "YouTube views are up 68 percent on the week before.",
      "The Buffer queue is empty; nothing is scheduled to post.",
    ]);
  });

  it("falls back to the unread count on a first visit", () => {
    expect(mailLine({ unread: 8, recent: [] }, false)).toBe("You have eight unread emails.");
    expect(mailLine({ unread: 0 }, false)).toBeNull();
    expect(mailLine({ unread: 8, new_since: 0 }, true)).toBeNull();
  });

  it("speaks times the way people say them", () => {
    expect(spokenTime("2026-09-28T14:30:00-07:00")).toBe("2:30 PM");
    expect(spokenTime("2026-09-28T16:00:00Z")).toBe("9 AM");
    expect(calendarLine({ events: [] }, MORNING)).toBeNull();
  });
});

describe("reminders", () => {
  it("reads times as Calabasas time", () => {
    expect(laIso(MORNING)).toBe("2026-09-28T08:30:00-07:00");
    expect(laIso(new Date("2026-12-01T20:00:00Z"))).toBe("2026-12-01T12:00:00-08:00");
    expect(resolveAt({ at: "2026-09-29T09:00" }, MORNING)).toBe("2026-09-29T09:00:00-07:00");
    expect(resolveAt({ at: "2026-12-01T09:00" }, MORNING)).toBe("2026-12-01T09:00:00-08:00");
    expect(resolveAt({ at: "2026-09-29T09:00:00Z" }, MORNING)).toBe("2026-09-29T09:00:00Z");
    expect(resolveAt({ in_minutes: 90 }, MORNING)).toBe("2026-09-28T10:00:00-07:00");
    expect(resolveAt({ at: "tomorrow at 9" }, MORNING)).toBeNull();
    expect(resolveAt({}, MORNING)).toBeNull();
  });

  it("are spoken plainly", () => {
    expect(reminderLine({ id: 1, text: "call Josh.", due_at: "", due: true })).toBe("Sir, a reminder: call Josh.");
  });
});
