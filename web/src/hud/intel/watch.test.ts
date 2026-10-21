import { describe, expect, it } from "vitest";
import { toStory, type RawItem } from "./model";
import { alertLine, describe as describeWatch, hits, matches, type Watch } from "./watch";

const NOW = Date.parse("2026-10-20T18:00:00Z");
const w = (over: Partial<Watch>): Watch => ({ id: 1, term: null, place: null, lat: null, lon: null, radius_km: null, created_at: NOW / 1000 - 3600, ...over });
const story = (over: Partial<RawItem>) =>
  toStory({ id: "x", kind: "news", title: "", summary: "", source: "AP", url: "https://e.x", feed: "t", published: "2026-10-20T17:30:00Z", ...over });
const calabasas = { place: "Calabasas, CA", lat: 34.16, lon: -118.64, radius_km: 80 };

describe("watchlist", () => {
  it("matches whole words and categories", () => {
    expect(matches(w({ term: "Ukraine" }), story({ title: "Talks on Ukraine stall" }))).toBe(true);
    expect(matches(w({ term: "Ukraine" }), story({ title: "Ukrainewide outage" }))).toBe(false);
    expect(matches(w({ term: "fire" }), story({ kind: "fire", title: "Blaze grows" }))).toBe(true);
  });

  it("matches places within the radius, at city level or finer", () => {
    const near = w(calabasas);
    expect(matches(near, story({ kind: "fire", title: "Palisades blaze", lat: 34.05, lon: -118.53 }))).toBe(true);
    expect(matches(near, story({ kind: "fire", title: "Blaze", lat: 37.77, lon: -122.42 }))).toBe(false);
    expect(matches(near, story({ title: "Drought worsens across California" }))).toBe(false);
    const fireNear = w({ term: "fire", ...calabasas });
    expect(matches(fireNear, story({ kind: "quake", title: "Quake", lat: 34.05, lon: -118.53 }))).toBe(false);
  });

  it("only announces stories since the watch was made, from the last day", () => {
    const watch = w({ term: "Ukraine" });
    const found = hits(
      [watch],
      [
        story({ id: "new", title: "Ukraine talks" }),
        story({ id: "before", title: "Ukraine earlier", published: "2026-10-20T16:00:00Z" }),
        story({ id: "undated", title: "Ukraine", published: undefined }),
      ],
      NOW,
    );
    expect(found.map((f) => f.story.id)).toEqual(["new"]);
  });

  it("says one story in full and counts the rest", () => {
    const watch = w({ term: "fire", ...calabasas });
    expect(describeWatch(watch)).toBe("fire within 50 mi of Calabasas, CA");
    const one = [{ watch, story: story({ title: "Brush fire in Malibu." }) }];
    expect(alertLine(one)).toBe("Sir, on your watchlist, fire within 50 mi of Calabasas, CA: Brush fire in Malibu.");
    const many = ["A", "B", "C"].map((t) => ({ watch, story: story({ title: t }) }));
    expect(alertLine(many)).toBe("Sir, 3 new items on your watchlist. A. B. And 1 more on the Intel tab.");
  });
});
