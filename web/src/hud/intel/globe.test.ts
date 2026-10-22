import { geoOrthographic } from "d3-geo";
import { describe, expect, it } from "vitest";
import { orthographic, zoomCentre } from "./globe";

describe("orthographic", () => {
  it("matches d3's projection on the near side and hides the far side", () => {
    const [lat0, lon0, scale, cx, cy] = [38, -98, 300, 400, 300];
    const d3 = geoOrthographic().rotate([-lon0, -lat0, 0]).scale(scale).translate([cx, cy]);
    for (const [lat, lon] of [[34, -118], [40.7, -74], [51.5, -0.1], [19.4, -99.1], [61, -150]]) {
      const ours = orthographic(lat, lon, lat0, lon0, scale, cx, cy);
      const theirs = d3([lon, lat]);
      expect(ours).not.toBeNull();
      expect(ours![0]).toBeCloseTo(theirs![0], 6);
      expect(ours![1]).toBeCloseTo(theirs![1], 6);
    }
    expect(orthographic(-38, 82, lat0, lon0, scale, cx, cy)).toBeNull();
  });
});

describe("zoomCentre", () => {
  it("moves the centre toward the cursor by the share of view the zoom removes", () => {
    const [lon, lat] = zoomCentre([0, 0], [10, 0], 1, 2);
    expect(lon).toBeCloseTo(5, 6);
    expect(lat).toBeCloseTo(0, 6);
    expect(zoomCentre([0, 0], [10, 0], 3, 3)).toEqual([0, 0]);
    // Zooming out never moves it.
    expect(zoomCentre([0, 0], [10, 0], 2, 1)).toEqual([0, 0]);
  });
});
