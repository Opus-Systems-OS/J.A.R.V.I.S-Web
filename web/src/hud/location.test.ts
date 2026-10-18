import { afterEach, describe, expect, it } from "vitest";
import { systemSuffix } from "./jarvis";
import { freshWeather, localZone, placeName, setHere, whereLine, type Here } from "./location";

const austin: Here = {
  place: "Austin",
  region: "Texas",
  country: "US",
  lat: 30.27,
  lon: -97.74,
  time_zone: "America/Chicago",
  weather: { place: "Austin", temperature_f: 88 },
  weather_at: 1_000_000,
  source: "named",
  at: 1_000_000,
};

afterEach(() => setHere(null));

describe("where he is", () => {
  it("names the place and its zone", () => {
    expect(placeName(austin)).toBe("Austin, Texas");
    expect(placeName({ ...austin, place: "Tokyo", region: null, country: "JP" })).toBe("Tokyo, JP");
    expect(placeName({ ...austin, place: null })).toBeNull();
    expect(whereLine(austin)).toBe("He is in Austin, Texas; use America/Chicago for times and dates.");
  });

  it("asks rather than assume Calabasas when it isn't known", () => {
    const line = whereLine(null);
    expect(line).not.toMatch(/Calabasas/);
    expect(line).toMatch(/ask him and call set_location/);
  });

  it("tells time in his zone once known", () => {
    setHere(austin);
    expect(localZone()).toBe("America/Chicago");
    setHere(null);
    expect(localZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it("speaks only fresh weather", () => {
    expect(freshWeather(austin, austin.weather_at + 60_000)).toEqual(austin.weather);
    expect(freshWeather(austin, austin.weather_at + 31 * 60_000)).toBeNull();
  });

  it("puts it in Jarvis's prompt", () => {
    const profile = { id: "walker", name: "Mr. Walker", full: true, agent: "jarvis" } as Parameters<typeof systemSuffix>[0];
    const suffix = systemSuffix(profile, whereLine(austin));
    expect(suffix).toContain("He is in Austin, Texas; use America/Chicago");
    expect(suffix).toContain("set_location");
    expect(suffix).not.toMatch(/Calabasas|Los_Angeles/);
  });
});
