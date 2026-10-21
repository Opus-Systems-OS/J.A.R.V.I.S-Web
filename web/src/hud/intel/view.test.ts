import { describe, expect, it } from "vitest";
import { toStory, type RawItem } from "./model";
import { layerMarks } from "./layers";
import { eventPrompt, leadLine, region, regionPrompt, searchPrompt } from "./view";

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

describe("region", () => {
  const at = { generated_at: new Date().toISOString() };
  const malibu = toStory({ id: "m", kind: "fire", title: "Brush fire in Malibu", summary: "", source: "CAL FIRE", url: "", feed: "x", lat: 34.03, lon: -118.78 } as RawItem);
  const kyiv = toStory({ id: "k", kind: "news", title: "Strikes on Kyiv", summary: "", source: "BBC", url: "", feed: "x", lat: 50.45, lon: 30.52 } as RawItem);

  it("keeps what is within the radius and names the notable marks", () => {
    const things = [
      ...layerMarks("conflict", { ...at, items: [["9", "Shooting in Van Nuys", "Van Nuys, California", 34.19, -118.45, null, null, null, 19, "https://e.com/x"]] }).things.values(),
      ...layerMarks("air", { ...at, items: [["a", "AQI 160", "70", 34.2, -118.6, null, null, null, 160], ["b", "AQI 30", "5", 34.0, -118.0, null, null, null, 30]] }).things.values(),
      ...layerMarks("military", { ...at, items: [["ae1", "RCH123", "C-17", 52.0, 13.0, 9000, 220, 90, null]] }).things.values(),
    ];
    const r = region(34.1, -118.5, 300, [malibu, kyiv], things);
    expect(r.stories.map((s) => s.id)).toEqual(["m"]);
    expect(r.categories).toEqual([["fire", 1]]);
    expect(r.marks).toEqual([["Fighting", 1]]);
    expect(r.notable.map((t) => t.title)).toEqual(["Shooting in Van Nuys"]);
    expect(r.worstAqi).toBe(160);
    const p = regionPrompt(r);
    expect(p).toContain("within 300 km of 34.1°N 118.5°W");
    expect(p).toContain("Brush fire in Malibu");
    expect(p).toContain("https://e.com/x");
    expect(p).toContain("Worst US AQI in view: 160");
    expect(p).not.toContain("Kyiv");
  });
});
