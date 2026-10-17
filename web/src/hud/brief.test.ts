import { describe, expect, it } from "vitest";
import { leadLine } from "./brief";

describe("leadLine", () => {
  it("skips fenced code to find the first plain sentence", () => {
    const report = "```\nrea inspect-artifact /tmp/x\n```\nIt is an **Electron** app built with Vite. More follows.";
    expect(leadLine(report)).toBe("It is an Electron app built with Vite.");
  });

  it("drops inline code markers", () => {
    expect(leadLine("Search runs in `search.worker.js` off the main thread.")).toBe("Search runs in search.worker.js off the main thread.");
  });
});
