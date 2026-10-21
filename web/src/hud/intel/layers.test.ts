import { describe, expect, it } from "vitest";
import { aqiBand, deadReckon, layerMarks, tempColor, thingPrompt } from "./layers";

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

  it("dates and extrapolates a ship from its own fix, not the snapshot", () => {
    const data = { generated_at: now, items: [["368", "SLOW BOAT", "", 0, 10, null, 10, 90, 600]] };
    const ship = layerMarks("ships", data).things.get("ships:368")!;
    expect(ship.fields).toContainEqual(["Reported", "10 min ago (position extrapolated since)"]);
    // Due east at 10 m/s for 10 min = 6 km ≈ 0.054°.
    const [lat, lon] = ship.pos(Date.parse(now))!;
    expect(lat).toBeCloseTo(0, 6);
    expect(lon).toBeCloseTo(10.054, 3);
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

  it("puts airports on the globe with a LiveATC link", () => {
    const data = { generated_at: now, items: [["KLAX", "LAX", "Los Angeles International Airport", "Los Angeles", "US", 33.943, -118.408, 125]] };
    const { marks, things } = layerMarks("atc", data);
    expect(marks[0]).toMatchObject({ lat: 33.943, lon: -118.408, shape: "sat", track: null });
    expect(things.get("atc:KLAX")?.links).toEqual([["Listen to ATC live (LiveATC)", "https://www.liveatc.net/search/?icao=KLAX"]]);
    expect(thingPrompt(things.get("atc:KLAX")!)).toContain("airport");
  });

  it("colours temperature cells cold to hot", () => {
    expect(tempColor(-30)).toContain("hsl(240");
    expect(tempColor(40)).toContain("hsl(0");
  });
});

describe("air and conflict layers", () => {
  const at = { generated_at: "2026-10-21T05:00:00Z" };
  it("colours air by the EPA band and keeps cells still", () => {
    expect(aqiBand(42)[1]).toBe("Good");
    expect(aqiBand(151)[1]).toBe("Unhealthy");
    expect(aqiBand(900)[1]).toBe("Hazardous");
    const { marks, things } = layerMarks("air", { ...at, items: [["34.2,-118.6", "AQI 159", "61.2", 34.2, -118.6, null, null, null, 159]] });
    expect(marks[0].color).toBe("#ff0000");
    expect(marks[0].pos).toBeUndefined();
    expect(things.get("air:34.2,-118.6")?.fields[1]).toEqual(["PM2.5", "61.2 µg/m³"]);
  });

  it("links a conflict event to its report and asks Jarvis to check it", () => {
    const url = "https://example.com/manipur-violence-escalates";
    const { marks, things } = layerMarks("conflict", { ...at, items: [["9", "Manipur violence escalates", "Imphal, Manipur, India", 24.8, 93.9, null, null, null, 19, url]] });
    expect(marks[0].shape).toBe("dot");
    const t = things.get("conflict:9")!;
    expect(t.kind).toBe("Fighting");
    expect(t.links).toEqual([["Read the report", url]]);
    expect(thingPrompt(t)).toContain(url);
  });
});

describe("cameras layer", () => {
  const at = { generated_at: "2026-10-21T05:00:00Z" };
  it("reads live and still from the row and stays put", () => {
    const { marks, things } = layerMarks("cams", {
      ...at,
      items: [
        ["ca:7-1", "I-110 : Avenue 26", "I-110, Cypress Park · Caltrans", 34.08, -118.22, null, null, null, 3],
        ["md:abc", "MD 295 at MD 197", "MD 295 · Maryland CHART", 39.05, -76.83, null, null, null, 1],
        ["nyc:x", "8 Ave @ 34 St", "Manhattan · NYC DOT", 40.75, -73.99, null, null, null, 2],
      ],
    });
    expect(marks.map((m) => m.shape)).toEqual(["dot", "dot", "dot"]);
    expect(marks.every((m) => m.pos === undefined)).toBe(true);
    expect(things.get("cams:ca:7-1")?.camera).toEqual({ id: "ca:7-1", live: true, still: true });
    expect(things.get("cams:md:abc")?.camera).toEqual({ id: "md:abc", live: true, still: false });
    const nyc = things.get("cams:nyc:x")!;
    expect(nyc.camera).toEqual({ id: "nyc:x", live: false, still: true });
    expect(nyc.kind).toBe("Traffic camera");
    expect(nyc.fields[1]).toEqual(["Agency", "NYC DOT"]);
    expect(thingPrompt(nyc)).toContain("traffic here right now");
  });
});
