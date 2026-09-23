// The HUD frame: top bar (clock, link state, tabs, lock), three columns
// around the orb, and the dock for the transcript and terminal drawers.
// Panels fill in stage by stage; the frame is the stage-1 surface.

import { get, lock, type Me } from "../api";

const TABS = ["HUD", "Fleet", "Systems", "Usage", "Terminal"] as const;
export type Tab = (typeof TABS)[number];

const PANEL = (id: string, title: string, note: string) => `
  <section class="panel" id="${id}">
    <header class="panel-head"><span class="panel-title">${title}</span><span class="panel-tag">standby</span></header>
    <div class="panel-body"><p class="panel-empty">${note}</p></div>
  </section>`;

const TEMPLATE = `
  <header class="topbar">
    <div class="brand"><span class="brand-mark" aria-hidden="true"></span>J.A.R.V.I.S.</div>
    <nav class="tabs" role="tablist">
      ${TABS.map((t, i) => `<button role="tab" class="tab" data-tab="${t}" aria-selected="${i === 0}">${t}</button>`).join("")}
    </nav>
    <div class="readouts">
      <span class="readout" id="hud-date"></span>
      <span class="readout readout-clock" id="hud-clock"></span>
      <span class="chip" id="hud-link" data-state="pending">Link</span>
      <button class="btn-ghost" id="hud-lock" title="Lock">Lock</button>
    </div>
  </header>
  <div class="stage" data-tab="HUD">
    <aside class="column column-left">
      ${PANEL("panel-fleet", "Fleet", "Agents and sessions come online in the next module.")}
    </aside>
    <div class="center">
      <div class="orb" id="orb" data-state="idle" aria-hidden="true">
        <svg viewBox="0 0 200 200">
          <circle class="ring ring-outer" cx="100" cy="100" r="92" />
          <circle class="ring ring-ticks" cx="100" cy="100" r="82" />
          <circle class="ring ring-mid" cx="100" cy="100" r="68" />
          <circle class="ring ring-inner" cx="100" cy="100" r="52" />
          <circle class="ring ring-core-edge" cx="100" cy="100" r="34" />
          <circle class="core" cx="100" cy="100" r="22" />
        </svg>
      </div>
      <p class="orb-caption" id="orb-caption">Standing by</p>
      <p class="orb-sub" id="orb-sub"></p>
    </div>
    <aside class="column column-right">
      ${PANEL("panel-systems", "Systems", "The architecture map comes online in a later module.")}
      ${PANEL("panel-usage", "Usage", "Spend and credits come online in a later module.")}
    </aside>
  </div>
  <div class="dock">
    <div class="drawer" id="drawer-transcript">
      <header class="drawer-head"><span class="panel-title">Transcript</span></header>
    </div>
  </div>
`;

const el = <T extends HTMLElement>(root: ParentNode, sel: string): T => {
  const found = root.querySelector(sel);
  if (!found) throw new Error(`missing ${sel}`);
  return found as T;
};

export function mountHud(root: HTMLElement, onLocked: () => void): () => void {
  root.innerHTML = TEMPLATE;
  root.hidden = false;
  root.classList.remove("entering");
  void root.offsetWidth;
  root.classList.add("entering");

  const clock = el<HTMLSpanElement>(root, "#hud-clock");
  const date = el<HTMLSpanElement>(root, "#hud-date");
  const link = el<HTMLSpanElement>(root, "#hud-link");
  const sub = el<HTMLParagraphElement>(root, "#orb-sub");

  // Calabasas time, whatever machine the page is open on.
  const tz = "America/Los_Angeles";
  const timeFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const dateFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "2-digit",
  });
  const tick = () => {
    const now = new Date();
    clock.textContent = timeFmt.format(now);
    date.textContent = dateFmt.format(now).toUpperCase();
  };
  tick();
  const timer = window.setInterval(tick, 1000);

  root.querySelectorAll<HTMLButtonElement>(".tab").forEach((b) => {
    b.onclick = () => {
      root.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-selected", String(t === b)));
      el<HTMLDivElement>(root, ".stage").dataset.tab = b.dataset.tab;
    };
  });

  el<HTMLButtonElement>(root, "#hud-lock").onclick = async () => {
    await lock();
    onLocked();
  };

  get<Me>("me")
    .then((me) => {
      link.dataset.state = "ok";
      link.textContent = "Link · API";
      link.title = `key ${me.name} (${me.key_id}) · ${me.scopes.join(", ")}`;
      sub.textContent = "All systems nominal";
    })
    .catch(() => {
      link.dataset.state = "down";
      link.textContent = "Link down";
      sub.textContent = "Cannot reach the Opus Systems OS API";
    });

  return () => window.clearInterval(timer);
}
