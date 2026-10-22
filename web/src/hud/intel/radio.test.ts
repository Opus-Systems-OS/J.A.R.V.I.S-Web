import { describe, expect, it } from "vitest";
import { bars } from "./radio";

describe("ATC equalizer bars", () => {
  it("is flat for silence and fills from the loudest bin in each band", () => {
    expect(bars(new Uint8Array(256), 8)).toEqual(new Array(8).fill(0));
    const f = new Uint8Array(256);
    f[3] = 255; // a low voice band
    const b = bars(f, 8);
    expect(b).toHaveLength(8);
    expect(Math.max(...b)).toBe(1);
    expect(b.filter((x) => x > 0)).toHaveLength(1);
    // Every bar has its own bins: one loud bin lights one bar of forty.
    const one = new Uint8Array(256);
    one[2] = 255;
    expect(bars(one, 40).filter((x) => x > 0)).toHaveLength(1);
    // Only the lower half of the spectrum is drawn.
    const hiss = new Uint8Array(256);
    hiss.fill(255, 200);
    expect(bars(hiss, 8).every((x) => x === 0)).toBe(true);
  });
});
