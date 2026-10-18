import { describe, expect, it } from "vitest";
import { briefingLines, calendarLine, mailLine, spokenTime, weatherLine, withLocalWeather, type Briefing } from "./briefing";
import { localIso, reminderLine, resolveAt } from "./reminders";

const LA = "America/Los_Angeles";
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
    expect(briefingLines(briefing("2026-09-27T20:00:00Z"), MORNING, LA)).toEqual([
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
    expect(spokenTime("2026-09-28T14:30:00-07:00", LA)).toBe("2:30 PM");
    expect(spokenTime("2026-09-28T16:00:00Z", LA)).toBe("9 AM");
    expect(spokenTime("2026-09-28T16:00:00Z", "America/Chicago")).toBe("11 AM");
    expect(calendarLine({ events: [] }, MORNING, LA)).toBeNull();
  });

  it("gives the weather where he is, not the API's fixed place", () => {
    const austin = { place: "Austin", temperature_f: 88, conditions: "partly cloudy", high_f: 95, rain_chance_pct: 40 };
    const b = withLocalWeather(briefing(null), austin);
    expect(b.sources.filter((s) => s.id === "weather")).toHaveLength(1);
    expect(briefingLines(b, MORNING, LA)[0]).toBe("It's 88 degrees and partly cloudy in Austin, heading for 95, with a 40 percent chance of rain.");
  });

  it("says no weather rather than guess where he is", () => {
    const b = withLocalWeather(briefing(null), null);
    expect(b.sources.some((s) => s.id === "weather")).toBe(false);
    expect(briefingLines(b, MORNING, LA)[0]).toMatch(/^You have/);
    expect(weatherLine({ temperature_f: 60, conditions: "foggy" })).toBe("It's 60 degrees and foggy outside.");
  });
});

describe("reminders", () => {
  it("reads times as his local time", () => {
    expect(localIso(MORNING, LA)).toBe("2026-09-28T08:30:00-07:00");
    expect(localIso(new Date("2026-12-01T20:00:00Z"), LA)).toBe("2026-12-01T12:00:00-08:00");
    expect(resolveAt({ at: "2026-09-29T09:00" }, MORNING, LA)).toBe("2026-09-29T09:00:00-07:00");
    expect(resolveAt({ at: "2026-12-01T09:00" }, MORNING, LA)).toBe("2026-12-01T09:00:00-08:00");
    expect(resolveAt({ at: "2026-09-29T09:00:00Z" }, MORNING, LA)).toBe("2026-09-29T09:00:00Z");
    expect(resolveAt({ in_minutes: 90 }, MORNING, LA)).toBe("2026-09-28T10:00:00-07:00");
    expect(resolveAt({ at: "tomorrow at 9" }, MORNING, LA)).toBeNull();
    expect(resolveAt({}, MORNING, LA)).toBeNull();
  });

  it("follow him to other zones", () => {
    expect(resolveAt({ at: "2026-09-29T09:00" }, MORNING, "America/Chicago")).toBe("2026-09-29T09:00:00-05:00");
    expect(resolveAt({ at: "2026-12-01T09:00" }, MORNING, "Europe/London")).toBe("2026-12-01T09:00:00+00:00");
    expect(resolveAt({ at: "2026-09-29T09:00" }, MORNING, "Asia/Kolkata")).toBe("2026-09-29T09:00:00+05:30");
    expect(resolveAt({ at: "2026-11-01T01:30" }, MORNING, "America/New_York")).toMatch(/^2026-11-01T01:30:00-0[45]:00$/);
    // A wall time that never happens (spring forward) is refused.
    expect(resolveAt({ at: "2026-03-08T02:30" }, MORNING, LA)).toBeNull();
  });

  it("are spoken plainly", () => {
    expect(reminderLine({ id: 1, text: "call Josh.", due_at: "", due: true })).toBe("Sir, a reminder: call Josh.");
  });
});
