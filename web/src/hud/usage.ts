// The Usage tab: what is left to spend (the Anthropic ledger and Fish's
// credit, with the balance and warning lines you set) and what the fleet
// has spent, by agent and by day. Spend comes from the control plane's
// audit CSV — one row per session, costed where it was last observed — so
// the table, the bars and the download are the same numbers.

import { raw, web } from "../api";
import { dollars, fishDollars, type Credits } from "./credits";

const TZ = "America/Los_Angeles";
const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const dayLabel = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric" });
const shortLabel = new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric" });
const stamp = new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** RFC 4180, as the control plane writes it (quotes only when needed). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export interface Day {
  key: string; // YYYY-MM-DD in Pacific time
  at: Date;
  cents: number;
  sessions: number;
}

export interface AgentSpend {
  agent: string;
  cents: number;
  sessions: number;
  budgetHits: number;
}

export interface Spend {
  days: Day[]; // oldest first, one per day, today last
  agents: AgentSpend[]; // most spent first
  totalCents: number;
}

/** The last `n` Pacific days (today included) of the usage CSV. */
export function spendFromCsv(csv: string, n: number, now = new Date()): Spend {
  const days: Day[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const at = new Date(now.getTime() - i * 86_400_000);
    days.push({ key: dayKey.format(at), at, cents: 0, sessions: 0 });
  }
  const byKey = new Map(days.map((d) => [d.key, d]));
  const agents = new Map<string, AgentSpend>();
  const [header, ...rows] = parseCsv(csv.trim());
  const col = (name: string) => header?.indexOf(name) ?? -1;
  const [iAgent, iCost, iAt, iBudget] = ["agent_slug", "list_cost_cents", "observed_at", "budget_reached"].map(col);
  for (const r of rows) {
    const at = Date.parse(r[iAt] ?? "");
    if (!Number.isFinite(at)) continue;
    const day = byKey.get(dayKey.format(new Date(at)));
    if (!day) continue;
    const cents = Number(r[iCost]) || 0;
    day.cents += cents;
    day.sessions += 1;
    const slug = r[iAgent] || "?";
    const a = agents.get(slug) ?? { agent: slug, cents: 0, sessions: 0, budgetHits: 0 };
    a.cents += cents;
    a.sessions += 1;
    if (r[iBudget] === "1") a.budgetHits += 1;
    agents.set(slug, a);
  }
  const list = [...agents.values()].sort((a, b) => b.cents - a.cents || a.agent.localeCompare(b.agent));
  return { days, agents: list, totalCents: days.reduce((s, d) => s + d.cents, 0) };
}

/** RFC 3339 without milliseconds. */
export const isoSeconds = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/** "12.50" / "$12.50" / "12" → cents; null when it isn't an amount. */
export function parseDollars(input: string): number | null {
  const m = input.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(m)) return null;
  return Math.round(Number(m) * 100);
}

const el = (tag: string, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const WINDOWS = [7, 30] as const;

export class UsageView {
  private days: number = WINDOWS[0];
  private csv = "";
  private timer: number | undefined;
  private readonly $ = <T extends HTMLElement>(sel: string) => this.root.querySelector(sel) as T;

  /** `onCredits` gets the fresh reading after you change the ledger. */
  constructor(
    private readonly root: HTMLElement,
    private readonly onCredits: (c: Credits) => void,
  ) {
    root.innerHTML = `
      <div class="usage">
        <section class="panel usage-credit" id="credit-anthropic">
          <header class="panel-head"><span class="panel-title">Anthropic</span><span class="panel-tag">estimate</span></header>
          <div class="panel-body">
            <p class="credit-figure" id="anth-figure">—</p>
            <p class="credit-sub" id="anth-sub">Reading the ledger…</p>
            <form class="credit-form" id="anth-form">
              <label><span>Console balance</span><input id="anth-anchor" inputmode="decimal" autocomplete="off" placeholder="$0.00" /></label>
              <button class="btn-primary btn-small" type="submit">Set</button>
            </form>
            <form class="credit-form" id="anth-warn-form">
              <label><span>Warn below</span><input id="anth-warn" inputmode="decimal" autocomplete="off" /></label>
              <button class="btn-ghost" type="submit">Save</button>
            </form>
            <p class="credit-note" id="anth-note"></p>
          </div>
        </section>
        <section class="panel usage-credit" id="credit-fish">
          <header class="panel-head"><span class="panel-title">Voice · Fish</span><span class="panel-tag">API credit</span></header>
          <div class="panel-body">
            <p class="credit-figure" id="fish-figure">—</p>
            <p class="credit-sub" id="fish-sub">Reading Fish…</p>
            <form class="credit-form" id="fish-warn-form">
              <label><span>Warn below</span><input id="fish-warn" inputmode="decimal" autocomplete="off" /></label>
              <button class="btn-ghost" type="submit">Save</button>
            </form>
            <p class="credit-note" id="fish-note"></p>
          </div>
        </section>
        <section class="panel usage-spend">
          <header class="panel-head">
            <span class="panel-title">Fleet spend</span>
            <span class="usage-actions">
              <span class="seg" role="group" aria-label="Window">
                ${WINDOWS.map((d) => `<button class="seg-btn" data-days="${d}" aria-pressed="${d === this.days}">${d} d</button>`).join("")}
              </span>
              <button class="btn-ghost" id="usage-csv">CSV</button>
            </span>
          </header>
          <div class="panel-body">
            <p class="spend-total"><span id="spend-total">—</span><span class="spend-total-label" id="spend-total-label"></span></p>
            <div class="bars-wrap">
              <div class="bars" id="spend-bars" role="list" aria-label="Fleet spend by day"></div>
              <div class="bars-axis"><span id="bars-first"></span><span id="bars-last"></span></div>
              <p class="bars-readout" id="bars-readout" aria-live="polite"></p>
            </div>
            <table class="spend-table">
              <thead><tr><th>Agent</th><th>Sessions</th><th>Budget hits</th><th>Spend</th></tr></thead>
              <tbody id="spend-agents"><tr><td colspan="4" class="panel-empty">Reading usage…</td></tr></tbody>
            </table>
          </div>
        </section>
      </div>`;

    this.root.querySelectorAll<HTMLButtonElement>(".seg-btn").forEach(
      (b) =>
        (b.onclick = () => {
          this.days = Number(b.dataset.days);
          this.root.querySelectorAll<HTMLButtonElement>(".seg-btn").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
          void this.refreshSpend();
        }),
    );
    this.$<HTMLButtonElement>("#usage-csv").onclick = () => void this.download();
    this.$<HTMLFormElement>("#anth-form").onsubmit = (e) => {
      e.preventDefault();
      void this.save("anth-anchor", "anchor_cents", "anth-note");
    };
    this.$<HTMLFormElement>("#anth-warn-form").onsubmit = (e) => {
      e.preventDefault();
      void this.save("anth-warn", "anthropic_warn_cents", "anth-note");
    };
    this.$<HTMLFormElement>("#fish-warn-form").onsubmit = (e) => {
      e.preventDefault();
      void this.save("fish-warn", "fish_warn_cents", "fish-note");
    };
  }

  show() {
    void this.refreshSpend();
    window.clearInterval(this.timer);
    this.timer = window.setInterval(() => void this.refreshSpend(), 60_000);
  }

  hide() {
    window.clearInterval(this.timer);
  }

  dispose() {
    this.hide();
  }

  // ---- credits ----------------------------------------------------------------

  /** Render a reading (from the HUD's CreditWatch or a save here). */
  setCredits(c: Credits) {
    const a = c.anthropic;
    const figure = this.$("#anth-figure");
    const sub = this.$("#anth-sub");
    const card = this.$("#credit-anthropic");
    card.dataset.level = a.exhausted ? "exhausted" : a.low ? "low" : "ok";
    if (a.exhausted) {
      figure.textContent = "Out of credit";
      sub.textContent = `The last session ended on a billing error${a.billing_error_at ? ` (${stamp.format(new Date(a.billing_error_at))})` : ""}. Top up, then set the new balance.`;
    } else if (a.remaining_cents !== null && a.anchor_cents !== null) {
      figure.textContent = `≈ ${dollars(a.remaining_cents)}`;
      sub.textContent = `${dollars(a.anchor_cents)} set ${a.anchored_at ? stamp.format(new Date(a.anchored_at)) : ""} · ${dollars(a.spent_since_cents ?? 0)} fleet spend since, at list price`;
    } else if (a.error) {
      figure.textContent = "—";
      sub.textContent = `Usage unavailable: ${a.error}`;
    } else {
      figure.textContent = "Not set";
      sub.textContent = "Type the balance from the Console's Billing page after a top-up; Jarvis subtracts fleet spend from there.";
    }
    const warnA = this.$<HTMLInputElement>("#anth-warn");
    if (document.activeElement !== warnA) warnA.value = (a.warn_below_cents / 100).toFixed(2);

    const f = c.fish;
    this.$("#credit-fish").dataset.level = f.low ? "low" : "ok";
    this.$("#fish-figure").textContent = f.credit_usd !== null ? fishDollars(f.credit_usd) : "—";
    this.$("#fish-sub").textContent =
      f.error !== null ? `Unavailable: ${f.error}` : "Speech and transcription draw on this; fish.audio → API credit to top up.";
    const warnF = this.$<HTMLInputElement>("#fish-warn");
    if (document.activeElement !== warnF) warnF.value = (f.warn_below_cents / 100).toFixed(2);
  }

  private async save(inputId: string, field: string, noteId: string) {
    const input = this.$<HTMLInputElement>(`#${inputId}`);
    const note = this.$(`#${noteId}`);
    const cents = parseDollars(input.value);
    if (cents === null) {
      note.textContent = "Enter an amount in dollars, like 25 or 25.40.";
      return;
    }
    note.textContent = "Saving…";
    try {
      const c = await web<Credits>("credits", { [field]: cents });
      note.textContent = field === "anchor_cents" ? "Balance set." : "Saved.";
      if (field === "anchor_cents") input.value = "";
      input.blur();
      this.onCredits(c);
    } catch (e) {
      note.textContent = `Not saved: ${(e as Error).message}`;
    }
  }

  // ---- spend ------------------------------------------------------------------

  private since(): string {
    // One spare day so the oldest Pacific day is whole.
    return isoSeconds(new Date(Date.now() - (this.days + 1) * 86_400_000));
  }

  private async refreshSpend() {
    try {
      this.csv = await (await raw("GET", `usage/export.csv?since=${this.since()}`)).text();
    } catch {
      this.$("#spend-agents").replaceChildren(this.emptyRow("Usage unavailable"));
      return;
    }
    this.render(spendFromCsv(this.csv, this.days));
  }

  private emptyRow(text: string) {
    const tr = el("tr");
    const td = el("td", "panel-empty", text) as HTMLTableCellElement;
    td.colSpan = 4;
    tr.append(td);
    return tr;
  }

  private render(s: Spend) {
    this.$("#spend-total").textContent = dollars(s.totalCents);
    this.$("#spend-total-label").textContent = ` over ${this.days} days · list price`;

    const max = Math.max(...s.days.map((d) => d.cents), 0);
    const readout = this.$("#bars-readout");
    const describe = (d: Day) =>
      `${dayLabel.format(d.at)} · ${dollars(d.cents)} · ${d.sessions} session${d.sessions === 1 ? "" : "s"}`;
    const peak = s.days.reduce<Day | null>((best, d) => (d.cents > 0 && (!best || d.cents > best.cents) ? d : best), null);
    const bars = s.days.map((d) => {
      const bar = el("div", "bar");
      bar.setAttribute("role", "listitem");
      bar.tabIndex = 0;
      bar.setAttribute("aria-label", describe(d));
      const fill = el("span", "bar-fill");
      fill.style.height = max ? `${Math.max((d.cents / max) * 100, d.cents ? 3 : 0)}%` : "0%";
      bar.append(fill);
      // Direct label on the peak only.
      if (d === peak) bar.append(el("span", "bar-label", dollars(d.cents)));
      const show = () => (readout.textContent = describe(d));
      bar.onmouseenter = show;
      bar.onfocus = show;
      bar.onmouseleave = () => (readout.textContent = "");
      bar.onblur = () => (readout.textContent = "");
      return bar;
    });
    const strip = this.$("#spend-bars");
    strip.style.setProperty("--n", String(s.days.length));
    strip.replaceChildren(...bars);
    this.$("#bars-first").textContent = s.days.length ? shortLabel.format(s.days[0].at) : "";
    this.$("#bars-last").textContent = "Today";

    const body = this.$("#spend-agents");
    if (!s.agents.length) {
      body.replaceChildren(this.emptyRow("No sessions in this window"));
      return;
    }
    body.replaceChildren(
      ...s.agents.map((a) => {
        const tr = el("tr");
        tr.append(el("td", "spend-agent", a.agent), el("td", "num", String(a.sessions)), el("td", "num", String(a.budgetHits)), el("td", "num", dollars(a.cents)));
        return tr;
      }),
    );
  }

  private async download() {
    if (!this.csv) await this.refreshSpend();
    const url = URL.createObjectURL(new Blob([this.csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `fleet-usage-${this.days}d-${dayKey.format(new Date())}.csv`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
