import { describe, expect, it } from "vitest";
import { briefingLines, type Briefing } from "./briefing";
import { defensesLine } from "./greeting";

describe("defensesLine", () => {
  const since = "2026-10-07T12:00:00Z";
  const at = (iso: string) => Date.parse(iso) / 1000;

  it("counts only bans since the last visit", () => {
    const bans = [
      { ip: "198.51.100.1", at: at("2026-10-07T13:00:00Z") },
      { ip: "198.51.100.2", at: at("2026-10-07T14:00:00Z") },
      { ip: "198.51.100.3", at: at("2026-10-06T09:00:00Z") },
    ];
    expect(defensesLine(bans, since)).toBe(
      "The honeypot has banned two addresses since your last visit; they're under Systems, Defenses.",
    );
    expect(defensesLine(bans.slice(0, 1), since)).toContain("one address");
  });

  it("says nothing with no new bans or no previous visit", () => {
    expect(defensesLine([{ ip: "x", at: at("2026-10-06T00:00:00Z") }], since)).toBeNull();
    expect(defensesLine([{ ip: "x", at: at("2026-10-07T13:00:00Z") }], null)).toBeNull();
  });
});

describe("a malformed briefing", () => {
  it("yields no lines instead of throwing", () => {
    expect(briefingLines({ data: [] } as unknown as Briefing)).toEqual([]);
  });
});
