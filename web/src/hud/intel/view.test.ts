import { describe, expect, it } from "vitest";
import { toStory, type RawItem } from "./model";
import { eventPrompt, leadLine, searchPrompt } from "./view";

const story = (title: string): ReturnType<typeof toStory> =>
  toStory({ id: title, kind: "news", title, summary: "", source: "NPR", url: "https://example.com/a", feed: "NPR", published: "2026-10-16T22:00:00Z" } as RawItem);

describe("leadLine", () => {
  it("speaks the brief's first plain sentence", () => {
    const brief = "# Situation\n\nA **wildfire** near Malibu has burned 2,000 acres. Crews are on scene.\n\n- Evacuations ordered";
    expect(leadLine(brief)).toBe("A wildfire near Malibu has burned 2,000 acres.");
  });

  it("is empty when the brief is only headings and bullets", () => {
    expect(leadLine("# Situation\n- one\n- two")).toBe("");
  });
});

describe("prompts", () => {
  it("hands Jarvis the place and the reports, marked for the Intel panel", () => {
    const p = eventPrompt("Malibu, CA", 34.03, -118.78, [story("Fire near Malibu")]);
    expect(p.startsWith("[intel]")).toBe(true);
    expect(p).toContain("Location: Malibu, CA (34.030, -118.780)");
    expect(p).toContain("1. Fire near Malibu (NPR, 2026-10-16T22:00:00Z) https://example.com/a");
  });

  it("keeps a person search to the public record", () => {
    const p = searchPrompt("Jane Doe", [{ title: "Jane Doe (author)", description: "American author", extract: "", url: "https://en.wikipedia.org/?curid=1" }], []);
    expect(p).toContain("several notable people share that name");
    expect(p).toContain("never include home addresses, phone numbers");
    expect(p).toContain("1. Jane Doe (author) (American author)");
    expect(p).toContain("No recent news coverage was found.");
  });
});
