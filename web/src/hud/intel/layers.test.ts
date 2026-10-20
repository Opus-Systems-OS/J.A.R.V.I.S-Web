import { describe, expect, it } from "vitest";
import { deadReckon, layerMarks, tempColor, thingPrompt } from "./layers";

const now = new Date().toISOString();

describe("deadReckon", () => {
  it("moves along the heading and stops extrapolating after 15 minutes", () => {
    // Due east on the equator at 250 m/s for 10 min = 150 km ≈ 1.349°.
    const [lat, lon] = deadReckon(0, 10, 90, 250, 10 * 60_000);
    expect(lat).toBeCloseTo(0, 6);
    expect(lon).toBeCloseTo(11.349, 3);
    expect(deadReckon(0, 10, 90, 250, 60 * 60_000)).toEqual(deadReckon(0, 10, 90, 250, 15 * 60_000));
    expect(deadReckon(10, 179.9, 90, 250, 10 * 60_000)[1]).toBeLessThan(-178); // wraps the date line
  });
});

describe("layerMarks", () => {
  it("draws flights as darts and picks out cargo airlines", () => {
    const data = { generated_at: now, items: [["a1", "FDX123", "United States", 34, -118, 10000, 230, 90, null], ["b2", "UAL9", "United States", 40, -100, 11000, 240, 270, null]] };
    const { marks, things } = layerMarks("flights", data);
    expect(marks.map((m) => m.shape)).toEqual(["plane", "plane"]);
    expect(things.get("flights:a1")?.kind).toBe("Cargo flight");
    expect(things.get("flights:b2")?.kind).toBe("Flight");
    expect(thingPrompt(things.get("flights:a1")!)).toContain('"FDX123"');
  });

  it("names ship types and flags military vessels", () => {
    const data = { generated_at: now, items: [["366", "EVER GIVEN", "70", 30, 32, null, 5, 180, null], ["367", "USNS X", "35", 36, -76, null, 0, null, null]] };
    const { things } = layerMarks("ships", data);
    expect(things.get("ships:366")?.kind).toBe("Cargo vessel");
    expect(things.get("ships:367")?.kind).toBe("Military vessel");
  });

  it("propagates a satellite from its TLE", () => {
    const iss = [
      "25544",
      "ISS (ZARYA)",
      "station",
      "1 25544U 98067A   26293.50000000  .00016717  00000-0  10270-3 0  9005",
      "2 25544  51.6400 208.9163 0006317  69.9862  25.2906 15.49560066 12345",
    ];
    const { marks, things } = layerMarks("satellites", { generated_at: now, items: [iss] });
    expect(marks).toHaveLength(1);
    expect(Math.abs(marks[0].lat)).toBeLessThanOrEqual(52);
    expect(things.get("satellites:25544")?.kind).toBe("Space station");
  });

  it("colours bases by service and briefs on the installation", () => {
    const data = { generated_at: now, items: [["Q509549", "Fort George G. Meade", "army|military base|United States|United States Army", 39.107, -76.743, null, null, null, null], ["Q1", "Ramstein Air Base", "air|airbase|Germany|", 49.44, 7.6, null, null, null, null]] };
    const { marks, things } = layerMarks("bases", data);
    expect(marks.every((m) => m.shape === "base" && !m.pos)).toBe(true);
    expect(things.get("bases:Q1")?.kind).toBe("Air force installation");
    expect(things.get("bases:Q1")?.fields).toContainEqual(["Operator", "not recorded"]);
    expect(thingPrompt(things.get("bases:Q509549")!)).toContain("military installation");
  });

  it("colours temperature cells cold to hot", () => {
    expect(tempColor(-30)).toContain("hsl(240");
    expect(tempColor(40)).toContain("hsl(0");
  });
});
