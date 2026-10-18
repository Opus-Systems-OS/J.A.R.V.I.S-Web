import { describe, expect, it } from "vitest";
import { isAppleTouch, silentWav } from "./speaker";

describe("isAppleTouch", () => {
  const nav = (userAgent: string, platform: string, maxTouchPoints: number) => ({ userAgent, platform, maxTouchPoints });

  it("knows iPhones and iPads, including an iPad that says it is a Mac", () => {
    expect(isAppleTouch(nav("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", "iPhone", 5))).toBe(true);
    expect(isAppleTouch(nav("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "MacIntel", 5))).toBe(true);
  });

  it("leaves desktops and Android alone", () => {
    expect(isAppleTouch(nav("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "MacIntel", 0))).toBe(false);
    expect(isAppleTouch(nav("Mozilla/5.0 (Linux; Android 15)", "Linux armv8l", 5))).toBe(false);
  });
});

describe("silentWav", () => {
  it("is a tenth of a second of 8 kHz 16-bit mono PCM", async () => {
    const blob = silentWav();
    expect(blob.type).toBe("audio/wav");
    expect(blob.size).toBe(44 + 1600);
    const v = new DataView(await blob.arrayBuffer());
    expect(String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3))).toBe("RIFF");
    expect(v.getUint32(24, true)).toBe(8000);
    expect(v.getInt16(100, true)).toBe(0);
  });
});
