import { describe, expect, it } from "vitest";
import { Segmenter, concat, encodeWav, resample } from "./ears";

const RATE = 48_000;
const FRAME = RATE / 50; // 20 ms
const frame = (amp: number) => {
  const f = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i++) f[i] = amp * Math.sin((2 * Math.PI * 220 * i) / RATE);
  return f;
};
const quiet = () => frame(0.002);
const loud = () => frame(0.2);

function feed(seg: Segmenter, frames: Float32Array[]) {
  const out: Float32Array[][] = [];
  for (const f of frames) {
    const u = seg.push(f);
    if (u) out.push(u);
  }
  return out;
}
const many = (n: number, f: () => Float32Array) => Array.from({ length: n }, f);

describe("encodeWav", () => {
  it("writes a 16-bit mono PCM header Fish can read", () => {
    const wav = new DataView(encodeWav(new Float32Array([0, 1, -1, 0.5]), 16_000));
    const tag = (o: number) => String.fromCharCode(...[0, 1, 2, 3].map((i) => wav.getUint8(o + i)));
    expect(tag(0)).toBe("RIFF");
    expect(tag(8)).toBe("WAVE");
    expect(tag(36)).toBe("data");
    expect(wav.getUint16(20, true)).toBe(1); // PCM
    expect(wav.getUint16(22, true)).toBe(1); // mono
    expect(wav.getUint32(24, true)).toBe(16_000);
    expect(wav.getUint16(34, true)).toBe(16);
    expect(wav.getUint32(40, true)).toBe(8);
    expect(wav.getInt16(46, true)).toBe(32767);
    expect(wav.getInt16(48, true)).toBe(-32768);
  });
});

describe("resample", () => {
  it("48 kHz → 16 kHz keeps duration", () => {
    const out = resample(new Float32Array(48_000), 48_000, 16_000);
    expect(out.length).toBe(16_000);
  });
  it("same rate is a no-op", () => {
    const x = new Float32Array([1, 2, 3]);
    expect(resample(x, 16_000, 16_000)).toBe(x);
  });
});

describe("Segmenter", () => {
  it("returns a spoken utterance with its pre-roll once silence follows", () => {
    const seg = new Segmenter();
    const got = feed(seg, [...many(50, quiet), ...many(50, loud), ...many(50, quiet)]);
    expect(got).toHaveLength(1);
    const ms = concat(got[0]).length / (RATE / 1000);
    // ~300 ms pre-roll + 1 s speech + 750 ms hangover.
    expect(ms).toBeGreaterThan(1_300);
    expect(ms).toBeLessThan(2_200);
  });

  it("ignores a short noise and a cough", () => {
    const seg = new Segmenter();
    expect(feed(seg, [...many(50, quiet), ...many(3, loud), ...many(60, quiet)])).toHaveLength(0); // 60 ms: never starts
    expect(feed(seg, [...many(10, loud), ...many(60, quiet)])).toHaveLength(0); // 200 ms: under minMs
  });

  it("cuts a very long utterance at the maximum", () => {
    const seg = new Segmenter({ maxMs: 2_000 });
    const got = feed(seg, [...many(20, quiet), ...many(200, loud)]);
    expect(got.length).toBeGreaterThanOrEqual(1);
    expect(concat(got[0]).length / (RATE / 1000)).toBeLessThanOrEqual(2_000);
  });

  it("stays quiet in a steady noisy room", () => {
    const seg = new Segmenter();
    // A constant hum above the absolute floor becomes the room's floor.
    expect(feed(seg, many(500, () => frame(0.01)))).toHaveLength(0);
  });
});
