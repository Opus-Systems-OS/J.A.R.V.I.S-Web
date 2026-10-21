// The Intel tab: the live feed on the left, the globe in the middle, the
// dossier on the right. Click a node (or a story) and the dossier shows
// what is known there; Analyze hands it to Jarvis, who researches it and
// writes a brief that renders here (and says its first line aloud).
// Search finds news coverage of anything and the Wikipedia entries that
// match it (several people who share a name each appear), and puts the
// coverage it can place on the globe. Layer toggles add live aircraft
// (with military and cargo picked out), ships, satellites and temperature;
// click one and Jarvis can identify it.
//
// Everything from the feeds goes in with textContent; the skeleton is the
// only markup, and it goes through `html`.

import { ApiError, webGet } from "../../api";
import { html, setHtml } from "../../html";
import { leadLine, link, renderBrief } from "../brief";
import { localZone } from "../location";
import { Globe, type GlobeNode } from "./globe";
import * as watch from "./watch";
import { LAYERS, layerMarks, thingPrompt, type LayerData, type LayerId, type Thing } from "./layers";
import { ago, CATEGORIES, cluster, COLOR, toStory, type Category, type Entry, type Feed, type IntelNode, type SearchResult, type Story } from "./model";

export { leadLine, renderBrief };

const REFRESH_MS = 5 * 60_000;
const MAX_ROWS = 160;
const BRIEF_TIMEOUT_MS = 6 * 60_000;
const LAYERS_KEY = "jarvis.intel.layers";

export interface IntelHost {
  /** Ask Jarvis on the conversation, silently; resolves with his reply. */
  analyze(prompt: string): Promise<string>;
  /** Say a line aloud (only the HUD with the mic speaks). */
  speak(text: string): void;
}

const SKELETON = html`
  <div class="intel">
    <section class="panel intel-feed">
      <header class="panel-head"><span class="panel-title">Live feed</span><span class="panel-tag" id="intel-count">acquiring</span></header>
      <div class="intel-chips" id="intel-chips" role="group" aria-label="Categories"></div>
      <ul class="intel-list" id="intel-list"><li class="panel-empty">Acquiring feeds…</li></ul>
      <footer class="intel-health" id="intel-health"></footer>
    </section>
    <section class="intel-stage">
      <canvas class="intel-globe" id="intel-globe" aria-label="Globe of current events"></canvas>
      <div class="intel-overlay intel-overlay-top">
        <span class="intel-heading">Global situation</span>
        <span class="intel-ticker" id="intel-ticker"></span>
      </div>
      <div class="intel-overlay intel-controls">
        <button class="btn-ghost" id="intel-us" title="Centre on the United States">U.S.</button>
        <button class="btn-ghost" id="intel-world" title="Show the whole world">World</button>
        <button class="btn-ghost" id="intel-refresh" title="Fetch the feeds again">Refresh</button>
      </div>
      <div class="intel-overlay intel-layers" id="intel-layers" role="group" aria-label="Layers"></div>
      <div class="intel-search-banner" id="intel-search-banner" hidden>
        <span id="intel-search-label"></span>
        <button class="btn-ghost" id="intel-search-clear">Clear search</button>
      </div>
    </section>
    <section class="panel intel-side">
      <form class="intel-search" id="intel-search" role="search">
        <input id="intel-q" autocomplete="off" spellcheck="false" maxlength="80" placeholder="Search a name, place or event" aria-label="Search" />
        <button class="btn-primary btn-small" type="submit">Search</button>
      </form>
      <section class="intel-watch" aria-label="Watchlist">
        <div class="intel-watch-list" id="intel-watch-list"></div>
        <form class="intel-watch-add" id="intel-watch-add">
          <input id="intel-watch-term" autocomplete="off" spellcheck="false" maxlength="80" placeholder="Watch a word" aria-label="Watch a word or category" />
          <input id="intel-watch-near" autocomplete="off" spellcheck="false" maxlength="80" placeholder="near (place, or me)" aria-label="Within 50 miles of" />
          <button class="btn-ghost btn-small" type="submit">Watch</button>
        </form>
      </section>
      <div class="intel-dossier" id="intel-dossier"></div>
    </section>
  </div>`;

/** The brief Jarvis is asked for about a place and its stories. */
export function eventPrompt(name: string, lat: number | null, lon: number | null, stories: Story[]): string {
  const reports = stories
    .slice(0, 12)
    .map((s, i) => `${i + 1}. ${s.title} (${s.source}${s.published ? `, ${s.published}` : ""})${s.summary ? ` ${s.summary}` : ""}${s.url ? ` ${s.url}` : ""}`)
    .join("\n");
  return [
    "[intel] Analyze this for the Intel panel. Your reply is shown on screen, not spoken, so ignore the short spoken-reply rules:",
    "write a thorough brief in plain markdown (# headings, - bullets, no tables).",
    "Begin with one plain sentence summarizing it (that line alone is read aloud), then these sections: Situation, Location and scope,",
    "Who is involved, Timeline, Impact (casualties, damage, evacuations or disruption, as applies), Response, What to watch next, Sources.",
    "Check the latest reporting with your web search and fetch tools first. Say what is confirmed and what is not, give times in Pacific time,",
    "and if you cannot browse, say so and work from the reports below.",
    `Location: ${name}${lat !== null && lon !== null ? ` (${lat.toFixed(3)}, ${lon.toFixed(3)})` : ""}`,
    "Reports:",
    reports,
  ].join("\n");
}

/** The brief Jarvis is asked for about a search (a name, a place, an event). */
export function searchPrompt(query: string, entries: Entry[], articles: Story[]): string {
  const matches = entries.slice(0, 8).map((e, i) => `${i + 1}. ${e.title}${e.description ? ` (${e.description})` : ""} ${e.url}`).join("\n");
  const coverage = articles.slice(0, 10).map((s, i) => `${i + 1}. ${s.title} (${s.source}${s.published ? `, ${s.published}` : ""})`).join("\n");
  return [
    `[intel] Brief the user on the search "${query}" for the Intel panel. Your reply is shown on screen, not spoken, so ignore the short`,
    "spoken-reply rules: plain markdown (# headings, - bullets, no tables), beginning with one plain sentence that sums it up (read aloud).",
    "If it names a person and several notable people share that name, give each a short section: who they are, why they are notable, and their",
    "recent news coverage. For an event, place or organization, cover what it is, what is happening now and why it matters.",
    "Research it with your web search and fetch tools first.",
    "Keep to public role and the public record: never include home addresses, phone numbers, personal email, relatives' details or other",
    "private information about anyone, even if you come across it, and if the name seems to belong only to a private individual, say so",
    "and summarize only the news coverage below.",
    matches ? `Matching encyclopedia entries:\n${matches}` : "No encyclopedia entries matched.",
    coverage ? `Recent coverage:\n${coverage}` : "No recent news coverage was found.",
  ].join("\n");
}

const el = <T extends HTMLElement>(tag: string, cls?: string, text?: string): T => {
  const e = document.createElement(tag) as T;
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export class IntelView {
  private readonly globe: Globe;
  private readonly $: <T extends HTMLElement>(sel: string) => T;
  private stories: Story[] = [];
  private nodes: IntelNode[] = [];
  private search: { result: SearchResult; stories: Story[]; nodes: IntelNode[] } | null = null;
  private readonly active = new Set<Category>(CATEGORIES.map((c) => c.id));
  private loadedAt = 0;
  private loading = false;
  private visible = false;
  private timer = 0;
  private selectedKey: string | null = null;
  private readonly briefs = new Map<string, string>();
  private briefing: string | null = null;
  private feed: Feed | null = null;
  private readonly layerOn = new Set<LayerId>(savedLayers());
  /** When each layer last loaded, and what it said (a count or a problem). */
  private readonly layerAt = new Map<LayerId, number>();
  private readonly layerNote = new Map<LayerId, string>();
  private readonly things = new Map<string, Thing>();
  private layerTimer = 0;
  private watches: watch.Watch[] = [];

  constructor(
    root: HTMLElement,
    private readonly host: IntelHost,
  ) {
    setHtml(root, SKELETON);
    this.$ = <T extends HTMLElement>(sel: string) => {
      const found = root.querySelector(sel);
      if (!found) throw new Error(`missing ${sel}`);
      return found as T;
    };
    this.globe = new Globe(this.$<HTMLCanvasElement>("#intel-globe"), { onSelect: (k) => this.selectNode(k, false) });
    this.$<HTMLButtonElement>("#intel-us").onclick = () => this.globe.home(false);
    this.$<HTMLButtonElement>("#intel-world").onclick = () => this.globe.home(true);
    this.$<HTMLButtonElement>("#intel-refresh").onclick = () => void this.load(true);
    this.$<HTMLButtonElement>("#intel-search-clear").onclick = () => this.clearSearch();
    this.$<HTMLFormElement>("#intel-search").onsubmit = (e) => {
      e.preventDefault();
      const q = this.$<HTMLInputElement>("#intel-q").value.trim();
      if (q) void this.runSearch(q);
    };
    this.$<HTMLFormElement>("#intel-watch-add").onsubmit = (e) => {
      e.preventDefault();
      void this.addWatch();
    };
    this.renderChips();
    this.renderLayers();
    this.renderIdle();
    void this.loadWatches();
  }

  show() {
    this.visible = true;
    this.globe.start();
    void this.loadWatches(); // Jarvis may have changed it by voice
    if (Date.now() - this.loadedAt > REFRESH_MS) void this.load();
    window.clearInterval(this.timer);
    this.timer = window.setInterval(() => void this.load(), REFRESH_MS);
    const due = () => this.layerOn.forEach((id) => Date.now() - (this.layerAt.get(id) ?? 0) > refreshOf(id) && void this.loadLayer(id));
    due();
    window.clearInterval(this.layerTimer);
    this.layerTimer = window.setInterval(due, 60_000);
  }

  hide() {
    this.visible = false;
    this.globe.stop();
    window.clearInterval(this.timer);
    window.clearInterval(this.layerTimer);
  }

  dispose() {
    this.hide();
    this.globe.dispose();
  }

  /** For Jarvis's `intel_feed` tool: the freshest feed (loaded if need be). */
  async current(): Promise<Story[]> {
    if (!this.feed || Date.now() - this.loadedAt > REFRESH_MS) await this.load();
    return this.stories;
  }

  // ---- feed ------------------------------------------------------------------

  private async load(force = false) {
    if (this.loading) return;
    if (!force && Date.now() - this.loadedAt < 30_000) return;
    this.loading = true;
    this.$("#intel-count").textContent = "acquiring";
    try {
      const feed = await webGet<Feed>("intel/feed");
      this.feed = feed;
      this.stories = feed.items.map(toStory);
      this.loadedAt = Date.now();
      this.rebuild();
      this.renderHealth();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "cannot reach the tower";
      const list = this.$<HTMLUListElement>("#intel-list");
      if (!this.stories.length) list.replaceChildren(el("li", "panel-empty", `Feeds unavailable: ${msg}`));
      this.$("#intel-count").textContent = "offline";
    } finally {
      this.loading = false;
    }
  }

  private filtered(): Story[] {
    return this.stories.filter((s) => this.active.has(s.category));
  }

  private rebuild() {
    const shown = this.filtered();
    this.nodes = cluster(shown);
    if (!this.search) {
      this.globe.setNodes(this.nodes.map(toGlobe));
      if (this.selectedKey) this.globe.select(this.selectedKey, false);
    }
    this.renderChips();
    this.renderList(shown);
    this.renderTicker();
    if (!this.selectedKey && !this.search) this.renderIdle();
  }

  private renderChips() {
    const counts = new Map<Category, number>();
    for (const s of this.stories) counts.set(s.category, (counts.get(s.category) ?? 0) + 1);
    const chips = this.$("#intel-chips");
    chips.replaceChildren(
      ...CATEGORIES.filter((c) => !this.stories.length || counts.get(c.id)).map((c) => {
        const b = el<HTMLButtonElement>("button", "intel-chip");
        b.type = "button";
        b.style.setProperty("--chip", c.color);
        b.setAttribute("aria-pressed", String(this.active.has(c.id)));
        b.append(el("span", "intel-chip-dot"), el("span", "", c.label), el("span", "intel-chip-n", String(counts.get(c.id) ?? "")));
        b.onclick = (e) => {
          // Click: toggle. Option-click: this category alone (again: all).
          if (e.altKey) {
            const alone = this.active.size === 1 && this.active.has(c.id);
            this.active.clear();
            for (const x of CATEGORIES) if (alone || x.id === c.id) this.active.add(x.id);
          } else if (this.active.has(c.id)) this.active.delete(c.id);
          else this.active.add(c.id);
          this.rebuild();
        };
        b.title = "Click to show or hide; option-click to show only this";
        return b;
      }),
    );
  }

  private renderList(shown: Story[]) {
    const list = this.$<HTMLUListElement>("#intel-list");
    this.$("#intel-count").textContent = `${shown.length} stories`;
    if (!shown.length) {
      list.replaceChildren(el("li", "panel-empty", this.stories.length ? "Nothing in the selected categories" : "No stories yet"));
      return;
    }
    list.replaceChildren(...shown.slice(0, MAX_ROWS).map((s) => this.storyRow(s)));
  }

  private storyRow(s: Story): HTMLLIElement {
    const li = el<HTMLLIElement>("li", "intel-row");
    li.style.setProperty("--cat", COLOR[s.category]);
    li.tabIndex = 0;
    li.dataset.located = String(!!s.where);
    if (this.watches.some((w) => watch.matches(w, s))) li.dataset.watched = "true";
    const title = el("span", "intel-row-title", s.title);
    const meta = el("span", "intel-row-meta", [s.source, s.where?.name, ago(s.published)].filter(Boolean).join(" · "));
    li.append(el("span", "intel-row-dot"), title, meta);
    const open = () => this.openStory(s);
    li.onclick = open;
    li.onkeydown = (e) => {
      if (e.key === "Enter") open();
    };
    return li;
  }

  // ---- watchlist ---------------------------------------------------------------

  private async loadWatches() {
    try {
      this.watches = await watch.list();
    } catch {
      /* shown empty; the next add retries */
    }
    this.renderWatches();
  }

  private renderWatches() {
    const box = this.$("#intel-watch-list");
    if (!this.watches.length) {
      box.replaceChildren(el("span", "intel-watch-empty", "Watchlist empty · Jarvis says when a new story matches"));
    } else {
      box.replaceChildren(
        ...this.watches.map((w) => {
          const b = el<HTMLButtonElement>("button", "intel-watch-chip", watch.describe(w));
          b.type = "button";
          b.title = "Stop watching";
          b.onclick = async () => {
            try {
              await watch.remove(w.id);
            } catch {
              /* gone already */
            }
            await this.loadWatches();
          };
          return b;
        }),
      );
    }
    if (this.stories.length) this.rebuild();
  }

  private async addWatch() {
    const term = this.$<HTMLInputElement>("#intel-watch-term");
    const near = this.$<HTMLInputElement>("#intel-watch-near");
    const w = await watch.resolve({ term: term.value, near: near.value });
    if (typeof w === "string") {
      near.setCustomValidity(w.replace(/^I don't know where he is yet.*/, "Jarvis doesn't know where you are yet"));
      near.reportValidity();
      near.oninput = () => near.setCustomValidity("");
      return;
    }
    try {
      await watch.add(w);
      term.value = near.value = "";
    } catch (e) {
      term.setCustomValidity(e instanceof ApiError ? e.message : "Couldn't save that watch");
      term.reportValidity();
      term.oninput = () => term.setCustomValidity("");
    }
    await this.loadWatches();
  }

  private renderTicker() {
    const located = this.nodes.reduce((n, x) => n + x.stories.length, 0);
    const ok = this.feed?.sources.filter((s) => s.ok).length ?? 0;
    const total = this.feed?.sources.length ?? 0;
    const at = this.feed ? new Date(this.feed.generated_at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: localZone() }) : "—";
    this.$("#intel-ticker").textContent = `${this.stories.length} stories · ${this.nodes.length} places · ${located} on map · ${ok}/${total} sources · ${at} PT`;
  }

  private renderHealth() {
    const box = this.$("#intel-health");
    const sources = this.feed?.sources ?? [];
    const down = sources.filter((s) => !s.ok);
    const summary = el("span", "intel-source", `${sources.length - down.length}/${sources.length} sources live`);
    summary.dataset.ok = "true";
    summary.title = sources.map((s) => `${s.name}: ${s.ok ? `${s.count} items` : `down (${s.error ?? "unavailable"})`}`).join("\n");
    box.replaceChildren(
      summary,
      ...down.map((s) => {
        const span = el("span", "intel-source", s.name);
        span.dataset.ok = "false";
        span.title = `down: ${s.error ?? "unavailable"}`;
        return span;
      }),
    );
  }

  // ---- live layers -----------------------------------------------------------

  private renderLayers() {
    this.$("#intel-layers").replaceChildren(
      ...LAYERS.map((l) => {
        const b = el<HTMLButtonElement>("button", "intel-chip intel-layer");
        b.type = "button";
        b.style.setProperty("--chip", l.color);
        b.setAttribute("aria-pressed", String(this.layerOn.has(l.id)));
        const note = this.layerOn.has(l.id) ? (this.layerNote.get(l.id) ?? "…") : "";
        b.append(el("span", "intel-chip-dot"), el("span", "", l.label), el("span", "intel-chip-n", note));
        b.title = note || `Show ${l.label.toLowerCase()}`;
        b.onclick = () => {
          if (this.layerOn.delete(l.id)) {
            this.globe.setLayer(l.id, null);
            for (const k of this.things.keys()) if (k.startsWith(`${l.id}:`)) this.things.delete(k);
            this.layerAt.delete(l.id);
          } else {
            this.layerOn.add(l.id);
            void this.loadLayer(l.id);
          }
          saveLayers(this.layerOn);
          this.renderLayers();
        };
        return b;
      }),
    );
  }

  private async loadLayer(id: LayerId) {
    this.layerAt.set(id, Date.now());
    try {
      const data = await webGet<LayerData>(`intel/layer/${id}`);
      if (!this.layerOn.has(id)) return; // switched off while loading
      const { marks, things } = layerMarks(id, data);
      this.globe.setLayer(id, marks);
      for (const k of this.things.keys()) if (k.startsWith(`${id}:`)) this.things.delete(k);
      things.forEach((t, k) => this.things.set(k, t));
      this.layerNote.set(id, data.error && !marks.length ? data.error : marks.length.toLocaleString("en-US"));
    } catch (e) {
      this.layerNote.set(id, e instanceof ApiError ? e.message : "unavailable");
    }
    this.renderLayers();
  }

  private renderThing(key: string, t: Thing) {
    const d = this.dossier();
    d.replaceChildren();
    d.style.removeProperty("--cat");
    const at = t.pos(Date.now());
    const head = el("header", "intel-dossier-head");
    head.append(
      el("span", "intel-kicker", t.kind),
      el("h3", "intel-dossier-title", t.title),
      el("span", "intel-coords", at ? `${Math.abs(at[0]).toFixed(3)}°${at[0] >= 0 ? "N" : "S"} ${Math.abs(at[1]).toFixed(3)}°${at[1] >= 0 ? "E" : "W"}` : "position unknown"),
    );
    d.append(head);
    const dl = el("dl", "intel-facts");
    for (const [k, v] of t.fields) dl.append(el("dt", "", k), el("dd", "", v));
    d.append(dl);
    if (t.url) d.append(link(t.url, "Read the report"));
    d.append(this.briefBlock(key, "Analyze with Jarvis", () => thingPrompt(t)));
  }

  // ---- selection and the dossier ---------------------------------------------

  private currentNodes(): IntelNode[] {
    return this.search ? this.search.nodes : this.nodes;
  }

  private selectNode(key: string | null, fly = true) {
    this.selectedKey = key;
    this.globe.select(key, fly);
    const thing = key ? this.things.get(key) : undefined;
    if (key && thing) {
      this.renderThing(key, thing);
      return;
    }
    const node = key ? this.currentNodes().find((n) => n.key === key) : null;
    if (!node) {
      if (this.search) this.renderSearch();
      else this.renderIdle();
      return;
    }
    this.renderNode(node.key, node.name, node.lat, node.lon, node.stories, node.category);
  }

  private openStory(s: Story) {
    const node = s.where ? this.currentNodes().find((n) => n.stories.includes(s)) : null;
    if (node) {
      this.selectNode(node.key);
      return;
    }
    this.selectedKey = null;
    this.globe.select(null);
    this.renderNode(`story:${s.id}`, s.where?.name ?? "Unplaced report", null, null, [s], s.category);
  }

  private dossier(): HTMLElement {
    return this.$("#intel-dossier");
  }

  private renderIdle() {
    const d = this.dossier();
    d.replaceChildren();
    const intro = el("div", "intel-intro");
    intro.append(
      el("h3", "intel-dossier-title", "Dossier"),
      el("p", "intel-hint", "Select a node on the globe or a story in the feed and Jarvis will brief you on it. Search a name, place or event for coverage and matching public records."),
    );
    d.append(intro);
    const hot = this.nodes.slice(0, 8);
    if (!hot.length) return;
    d.append(el("h4", "intel-section", "Loudest right now"));
    const ul = el("ul", "intel-hot");
    for (const n of hot) {
      const li = el<HTMLLIElement>("li", "intel-hot-row");
      li.style.setProperty("--cat", COLOR[n.category]);
      li.tabIndex = 0;
      li.append(el("span", "intel-row-dot"), el("span", "intel-hot-name", n.name), el("span", "intel-hot-n", `${n.stories.length}`));
      li.title = n.stories[0]?.title ?? "";
      li.onclick = () => this.selectNode(n.key);
      li.onkeydown = (e) => {
        if (e.key === "Enter") this.selectNode(n.key);
      };
      ul.append(li);
    }
    d.append(ul);
  }

  private renderNode(key: string, name: string, lat: number | null, lon: number | null, stories: Story[], category: Category) {
    const d = this.dossier();
    d.replaceChildren();
    d.style.setProperty("--cat", COLOR[category]);
    const head = el("header", "intel-dossier-head");
    const label = CATEGORIES.find((c) => c.id === category)?.label ?? category;
    head.append(
      el("span", "intel-kicker", `${label} · ${stories.length} report${stories.length === 1 ? "" : "s"}`),
      el("h3", "intel-dossier-title", name),
      el("span", "intel-coords", lat !== null && lon !== null ? `${Math.abs(lat).toFixed(3)}°${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(3)}°${lon >= 0 ? "E" : "W"}` : "position unknown"),
    );
    d.append(head);
    d.append(this.briefBlock(key, "Analyze with Jarvis", () => eventPrompt(name, lat, lon, stories)));
    d.append(el("h4", "intel-section", "Reports"));
    const ul = el("ul", "intel-reports");
    for (const s of stories.slice(0, 40)) ul.append(this.report(s));
    d.append(ul);
  }

  private report(s: Story): HTMLLIElement {
    const li = el<HTMLLIElement>("li", "intel-report");
    li.style.setProperty("--cat", COLOR[s.category]);
    li.append(link(s.url, s.title, "intel-report-title"));
    li.append(el("span", "intel-row-meta", [s.source, ago(s.published)].filter(Boolean).join(" · ")));
    if (s.summary) li.append(el("p", "intel-report-summary", s.summary));
    return li;
  }

  /** The Analyze button and where the brief lands (remembered per subject). */
  private briefBlock(key: string, label: string, prompt: () => string): HTMLElement {
    const box = el("div", "intel-brief-box");
    const bar = el("div", "intel-brief-bar");
    const button = el<HTMLButtonElement>("button", "btn-primary btn-small", label);
    button.type = "button";
    const out = el("div", "intel-brief");
    bar.append(button);
    box.append(bar, out);
    const cached = this.briefs.get(key);
    if (cached) {
      renderBrief(out, cached);
      button.textContent = "Analyze again";
    } else if (this.briefing === key) {
      this.analyzing(out);
      button.disabled = true;
    }
    button.onclick = () => void this.analyze(key, prompt(), button, out);
    return box;
  }

  private analyzing(out: HTMLElement) {
    out.replaceChildren();
    const status = el("div", "intel-analyzing");
    status.append(el("span", "intel-analyzing-bars"), el("span", "", "Jarvis is researching. A minute or two"));
    out.append(status);
  }

  private async analyze(key: string, prompt: string, button: HTMLButtonElement, out: HTMLElement) {
    if (this.briefing) return;
    this.briefing = key;
    button.disabled = true;
    this.analyzing(out);
    let text = "";
    try {
      text = await Promise.race([
        this.host.analyze(prompt),
        new Promise<string>((resolve) => window.setTimeout(() => resolve(""), BRIEF_TIMEOUT_MS)),
      ]);
    } finally {
      this.briefing = null;
    }
    // The dossier may have moved on; the brief is kept for when it comes back.
    if (text.trim()) this.briefs.set(key, text);
    if (!out.isConnected) return;
    button.disabled = false;
    if (!text.trim()) {
      out.replaceChildren(el("p", "intel-hint", "No brief came back. See the transcript, then try again."));
      return;
    }
    button.textContent = "Analyze again";
    renderBrief(out, text);
    const lead = leadLine(text);
    if (lead && this.visible) this.host.speak(lead);
  }

  // ---- search ----------------------------------------------------------------

  private async runSearch(q: string) {
    const d = this.dossier();
    d.replaceChildren(el("p", "intel-hint", `Searching for “${q}”…`));
    try {
      const result = await webGet<SearchResult>(`intel/search?q=${encodeURIComponent(q)}`);
      const stories = result.articles.map(toStory);
      const nodes = cluster(stories);
      this.search = { result, stories, nodes };
      this.selectedKey = null;
      this.globe.setNodes(nodes.map((n) => ({ ...toGlobe(n), color: "#fff1dc" })));
      this.globe.setDim(true);
      if (nodes[0]) this.globe.flyTo(nodes[0].lat, nodes[0].lon, 1.6);
      this.$("#intel-search-label").textContent = `Search · “${result.query}” · ${stories.length} articles · ${nodes.length} places`;
      this.$("#intel-search-banner").hidden = false;
      this.renderSearch();
    } catch (e) {
      d.replaceChildren(el("p", "intel-hint", `Search failed: ${e instanceof ApiError ? e.message : "cannot reach the tower"}`));
    }
  }

  private clearSearch() {
    this.search = null;
    this.selectedKey = null;
    this.$("#intel-search-banner").hidden = true;
    this.$<HTMLInputElement>("#intel-q").value = "";
    this.globe.setDim(false);
    this.globe.setNodes(this.nodes.map(toGlobe));
    this.globe.select(null);
    this.renderIdle();
  }

  private renderSearch() {
    if (!this.search) return;
    const { result, stories } = this.search;
    const d = this.dossier();
    d.replaceChildren();
    d.style.removeProperty("--cat");
    const head = el("header", "intel-dossier-head");
    head.append(el("span", "intel-kicker", "Search"), el("h3", "intel-dossier-title", result.query));
    d.append(head);
    d.append(this.briefBlock(`search:${result.query.toLowerCase()}`, "Brief me", () => searchPrompt(result.query, result.entries, stories)));

    if (result.entries.length) {
      d.append(el("h4", "intel-section", `Matching entries · ${result.entries.length}`));
      const ul = el("ul", "intel-entries");
      for (const e of result.entries) {
        const li = el("li", "intel-entry");
        li.append(link(e.url, e.title, "intel-report-title"));
        if (e.description) li.append(el("span", "intel-row-meta", e.description));
        if (e.extract) li.append(el("p", "intel-report-summary", e.extract));
        const brief = el<HTMLButtonElement>("button", "btn-ghost btn-small", "Brief on this one");
        brief.type = "button";
        brief.onclick = () => {
          const key = `entry:${e.url}`;
          this.renderEntry(key, e, stories);
        };
        li.append(brief);
        ul.append(li);
      }
      d.append(ul);
    }

    d.append(el("h4", "intel-section", `Coverage · ${stories.length}`));
    if (!stories.length) d.append(el("p", "intel-hint", "No recent news coverage."));
    const ul = el("ul", "intel-reports");
    for (const s of stories) ul.append(this.report(s));
    d.append(ul);
    if (result.errors?.length) d.append(el("p", "intel-hint", `Partly unavailable: ${result.errors.join("; ")}`));
  }

  /** One of several namesakes, briefed on their own. */
  private renderEntry(key: string, e: Entry, stories: Story[]) {
    const d = this.dossier();
    d.replaceChildren();
    const head = el("header", "intel-dossier-head");
    const back = el<HTMLButtonElement>("button", "btn-ghost btn-small", "Back to results");
    back.type = "button";
    back.onclick = () => this.renderSearch();
    head.append(back, el("span", "intel-kicker", e.description || "Entry"), el("h3", "intel-dossier-title", e.title));
    d.append(head);
    if (e.extract) d.append(el("p", "intel-report-summary", e.extract));
    d.append(link(e.url, "Encyclopedia entry"));
    d.append(this.briefBlock(key, "Brief me", () => searchPrompt(e.title, [e], stories)));
  }
}

function toGlobe(n: IntelNode): GlobeNode {
  return { key: n.key, lat: n.lat, lon: n.lon, color: COLOR[n.category], weight: n.weight, label: n.name, count: n.stories.length };
}

const refreshOf = (id: LayerId) => LAYERS.find((l) => l.id === id)?.refreshMs ?? REFRESH_MS;

function savedLayers(): LayerId[] {
  try {
    const ids = JSON.parse(localStorage.getItem(LAYERS_KEY) ?? "[]") as string[];
    return LAYERS.filter((l) => ids.includes(l.id)).map((l) => l.id);
  } catch {
    return [];
  }
}

function saveLayers(on: Set<LayerId>) {
  try {
    localStorage.setItem(LAYERS_KEY, JSON.stringify([...on]));
  } catch {
    /* private mode: the toggles just don't survive a reload */
  }
}
