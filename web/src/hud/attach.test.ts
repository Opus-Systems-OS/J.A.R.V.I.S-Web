import { describe, expect, it } from "vitest";
import { humanSize, MAX_BYTES, MAX_FILES, refusal, splitAttached } from "./attach";

describe("attachments", () => {
  it("refuses empty, oversized and one-too-many files", () => {
    expect(refusal({ name: "a.png", size: 10 }, 0)).toBeNull();
    expect(refusal({ name: "a.png", size: 0 }, 0)).toMatch(/empty/);
    expect(refusal({ name: "big.mov", size: MAX_BYTES + 1 }, 0)).toMatch(/over 32 MB/);
    expect(refusal({ name: "a.png", size: 10 }, MAX_FILES)).toMatch(/at most 10/);
  });

  it("sizes read like the control plane's", () => {
    expect(humanSize(500)).toBe("500 B");
    expect(humanSize(2048)).toBe("2 KB");
    expect(humanSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("splits a message into what was said and the attached files", () => {
    // The two text blocks arrive joined, with no separator.
    const text =
      "What is in this?" +
      "Attached files (read-only copies in your sandbox):\n" +
      "- /mnt/session/uploads/shot.png (image/png, 240 KB; file_id file_011A)\n" +
      "- /mnt/session/uploads/rows-2.csv (text/csv, 500 bytes; file_id file_011B)";
    const { said, files } = splitAttached(text);
    expect(said).toBe("What is in this?");
    expect(files).toEqual([
      { path: "/mnt/session/uploads/shot.png", name: "shot.png", mime: "image/png", size: "240 KB" },
      { path: "/mnt/session/uploads/rows-2.csv", name: "rows-2.csv", mime: "text/csv", size: "500 bytes" },
    ]);
    expect(splitAttached("just words")).toEqual({ said: "just words", files: [] });
  });
});
