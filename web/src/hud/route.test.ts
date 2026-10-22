import { describe, expect, it } from "vitest";
import { appleMapsUrl, miles, minutes, shortName, stepDistance, type Route } from "./route";

const r: Route = {
  from: { name: "your location", lat: 34.161, lon: -118.639 },
  to: { name: "Los Angeles International Airport, World Way, Los Angeles, California", lat: 33.9422, lon: -118.4214 },
  distance_m: 45652,
  duration_s: 2233,
  line: [[-118.639, 34.161], [-118.4214, 33.9422]],
  steps: [],
};

describe("route", () => {
  it("hands Apple Maps a driving route between the two points", () => {
    const u = new URL(appleMapsUrl(r));
    expect(u.origin).toBe("https://maps.apple.com");
    expect(u.searchParams.get("saddr")).toBe("34.161,-118.639");
    expect(u.searchParams.get("daddr")).toBe("33.9422,-118.4214");
    expect(u.searchParams.get("dirflg")).toBe("d");
  });

  it("speaks in miles, minutes and short names", () => {
    expect(shortName(r)).toBe("Los Angeles International Airport");
    expect(miles(45652)).toBe("28 mi");
    expect(miles(4000)).toBe("2.5 mi");
    expect(minutes(2233)).toBe("37 min");
    expect(minutes(5400)).toBe("1 h 30 min");
    expect(stepDistance(120)).toBe("390 ft");
  });
});
