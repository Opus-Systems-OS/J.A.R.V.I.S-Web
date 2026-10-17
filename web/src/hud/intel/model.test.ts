import { describe, expect, it } from "vitest";
import { locate, stateByCode } from "./geo";
import { classify, cluster, toStory, type RawItem } from "./model";

const news = (title: string, summary = ""): RawItem => ({ id: title, kind: "news", title, summary, source: "x", url: "", feed: "x" });

describe("locate", () => {
  it("prefers the city over the state it is in", () => {
    expect(locate("Wildfire near Malibu forces evacuations across Southern California")?.name).toBe("Malibu, CA");
    expect(locate("Oregon shooting: teacher battled Bend school shooter")?.name).toBe("Bend, OR");
  });

  it("matches the longest name and whole words only", () => {
    expect(locate("Floods hit West Virginia")?.name).toBe("West Virginia");
    expect(locate("Storm in Papua New Guinea")?.name).toBe("Papua New Guinea");
    expect(locate("Nigerian army says")?.name).toBe("Nigeria");
    expect(locate("Ohioans brace for snow")).toBeNull();
  });

  it("skips a place that is a person's surname", () => {
    expect(locate("Michael Jordan opens a restaurant")).toBeNull();
    expect(locate("Protests in Jordan over prices")?.name).toBe("Jordan");
    expect(locate("Denzel Washington wins award")).toBeNull();
    expect(locate("Strikes reported in Kyiv")?.name).toBe("Kyiv, Ukraine");
  });

  it("does not take a newspaper's name for the place", () => {
    expect(locate("Report from the New York Times on Gaza")?.name).toBe("Gaza");
  });

  it("knows bare New York is the city and Washington the capital", () => {
    expect(locate("Subway delays in New York")?.name).toBe("New York City, NY");
    expect(locate("Washington weighs new sanctions")?.name).toBe("Washington, D.C.");
    expect(locate("Rain soaks Washington state")?.name).toBe("Washington State");
  });

  it("finds states by postal code", () => {
    expect(stateByCode("ia")?.name).toBe("Iowa");
    expect(stateByCode("ZZ")).toBeNull();
  });
});

describe("classify", () => {
  it("reads human events from the headline", () => {
    expect(classify(news("Three killed in school shooting"))).toBe("violence");
    expect(classify(news("Brush fire burns 200 acres"))).toBe("fire");
    expect(classify(news("Missile strikes hit Kharkiv"))).toBe("conflict");
    expect(classify(news("Thousands protest in Paris"))).toBe("unrest");
    expect(classify(news("Senate passes funding bill"))).toBe("politics");
    expect(classify(news("Nothing here", "Measles outbreak spreads"))).toBe("health");
    expect(classify(news("A quiet day"))).toBe("other");
  });

  it("trusts a hazard's kind", () => {
    expect(classify({ kind: "quake", title: "M 4.1", summary: "" })).toBe("disaster");
    expect(classify({ kind: "alert", title: "Flood Warning", summary: "" })).toBe("disaster");
    expect(classify({ kind: "alert", title: "Freeze Warning", summary: "" })).toBe("weather");
  });
});

describe("cluster", () => {
  it("gathers stories at one place into one node", () => {
    const stories = [news("Fire in Malibu"), news("Malibu evacuations"), news("Gaza ceasefire talks"), news("No place")].map(toStory);
    const nodes = cluster(stories);
    expect(nodes).toHaveLength(2);
    const malibu = nodes.find((n) => n.name === "Malibu, CA");
    expect(malibu?.stories).toHaveLength(2);
    expect(malibu?.category).toBe("fire");
  });

  it("keeps placed hazards where the feed put them", () => {
    const quake: RawItem = { ...news("M 3.0 - 5 km N of Ridgecrest"), kind: "quake", lat: 35.7, lon: -117.6, severity: 0.5 };
    const [n] = cluster([toStory(quake)]);
    expect(n.lat).toBe(35.7);
    expect(n.weight).toBe(0.5);
  });
});
