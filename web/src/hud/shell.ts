// The HUD: top bar (tabs, model, mic, clock, link, lock), three columns
// around the orb, and the dock (transcript drawer + text line). It wires
// the pieces together — Listener (mic) → Jarvis (session) → Speaker (voice)
// — and owns nothing else: no fleet state, no conversation state beyond
// the session bookmark Jarvis keeps.

import { get, lock, type Me } from "../api";
import { greeting } from "./greeting";
import { Jarvis, MODELS, type Phase } from "./jarvis";
import { Listener, type ListenerState } from "./listener";
import { Speaker } from "./speaker";
import { compactOps } from "./tools";
import { Transcript } from "./transcript";

const TABS = ["HUD", "Fleet", "Systems", "Usage", "Terminal"] as const;
const DRAWER_KEY = "jarvis.drawer";

const PANEL = (id: string, title: string, body: string) => `
  <section class="panel" id="${id}">
    <header class="panel-head"><span class="panel-title">${title}</span><span class="panel-tag" data-tag>standby</span></header>
    <div class="panel-body">${body}</div>
  </section>`;

const ORB_SVG = `
  <svg viewBox="0 0 200 200">
    <circle class="ring ring-outer" cx="100" cy="100" r="92" />
    <circle class="ring ring-ticks" cx="100" cy="100" r="82" />
    <circle class="ring ring-mid" cx="100" cy="100" r="68" />
    <circle class="ring ring-inner" cx="100" cy="100" r="52" />
    <circle class="ring ring-core-edge" cx="100" cy="100" r="34" />
    <circle class="core" cx="100" cy="100" r="22" />
  </svg>`;

const TEMPLATE = `
  <header class="topbar">
    <div class="brand"><span class="brand-mark" aria-hidden="true"></span>J.A.R.V.I.S.</div>
    <nav class="tabs" role="tablist">
      ${TABS.map((t, i) => `<button role="tab" class="tab" data-tab="${t}" aria-selected="${i === 0}">${t}</button>`).join("")}
    </nav>
    <div class="readouts">
      <span class="chip" id="hud-mic" data-state="off" title="Microphone">Mic</span>
      <span class="readout" id="hud-date"></span>
      <span class="readout readout-clock" id="hud-clock"></span>
      <span class="chip" id="hud-link" data-state="pending">Link</span>
      <button class="btn-ghost" id="hud-lock" title="Lock">Lock</button>
    </div>
  </header>
  <div class="stage" data-tab="HUD">
    <aside class="column column-left">
      ${PANEL("panel-fleet", "Fleet", `<p class="panel-empty">Agents and sessions come online in the next module.</p>`)}
    </aside>
    <div class="center">
      <button class="orb" id="orb" data-state="idle" aria-label="Talk to Jarvis">${ORB_SVG}</button>
      <p class="orb-caption" id="orb-caption">Standing by</p>
      <p class="orb-sub" id="orb-sub"></p>
    </div>
    <aside class="column column-right">
      ${PANEL("panel-systems", "Systems", `<ul class="rows" id="systems-rows"><li class="panel-empty">Reading the tower…</li></ul>`)}
      ${PANEL("panel-usage", "Usage", `<p class="panel-empty">Spend and credits come online in a later module.</p>`)}
    </aside>
  </div>
  <div class="dock">
    <section class="drawer" id="drawer" data-open="true">
      <header class="drawer-head">
        <button class="drawer-toggle" id="drawer-toggle" aria-expanded="true">
          <span class="panel-title">Transcript</span><span class="drawer-caret" aria-hidden="true"></span>
        </button>
        <span class="drawer-meta" id="drawer-meta"></span>
        <label class="select-wrap" title="Model — changing it starts a new conversation">
          <span class="sr-only">Model</span>
          <select id="hud-model">${MODELS.map((m) => `<option value="${m.id}">${m.label}</option>`).join("")}</select>
        </label>
        <button class="btn-ghost" id="drawer-new" title="Start a new conversation">New</button>
      </header>
      <div class="drawer-body">
        <div class="transcript" id="transcript" aria-live="polite"></div>
      </div>
      <form class="ask" id="ask">
        <input id="ask-input" autocomplete="off" spellcheck="true" placeholder="Say “Jarvis, …” or type here" aria-label="Message Jarvis" />
        <button class="btn-primary btn-small" type="submit">Send</button>
      </form>
    </section>
  </div>
`;

const MIC_LABEL: Record<ListenerState, string> = {
  off: "Mic off",
  passive: "Listening for “Jarvis”",
  awake: "Listening",
  paused: "Speaking",
  unsupported: "Voice needs Chrome",
  denied: "Mic blocked",
};

const el = <T extends HTMLElement>(root: ParentNode, sel: string): T => {
  const found = root.querySelector(sel);
  if (!found) throw new Error(`missing ${sel}`);
  return found as T;
};

function loadFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}
function saveFlag(key: string, v: boolean) {
  try {
    localStorage.setItem(key, v ? "1" : "0");
  } catch {
    /* fine */
  }
}

export interface Hud {
  unmount(): void;
}

/** `speaker` was primed inside the unlock click, so it may play audio. */
export function mountHud(root: HTMLElement, speaker: Speaker, onLocked: () => void): Hud {
  root.innerHTML = TEMPLATE;
  root.hidden = false;
  root.classList.remove("entering");
  void root.offsetWidth;
  root.classList.add("entering");

  const $ = <T extends HTMLElement>(sel: string) => el<T>(root, sel);
  const orb = $<HTMLButtonElement>("#orb");
  const caption = $<HTMLParagraphElement>("#orb-caption");
  const sub = $<HTMLParagraphElement>("#orb-sub");
  const mic = $<HTMLSpanElement>("#hud-mic");
  const link = $<HTMLSpanElement>("#hud-link");
  const drawer = $<HTMLElement>("#drawer");
  const toggle = $<HTMLButtonElement>("#drawer-toggle");
  const meta = $<HTMLSpanElement>("#drawer-meta");
  const input = $<HTMLInputElement>("#ask-input");
  const modelSelect = $<HTMLSelectElement>("#hud-model");
  const stage = $<HTMLDivElement>(".stage");
  const timers: number[] = [];

  // ---- tabs ----------------------------------------------------------------
  const openPanel = (tab: string) => {
    root.querySelectorAll<HTMLButtonElement>(".tab").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.tab === tab)));
    stage.dataset.tab = tab;
  };
  root.querySelectorAll<HTMLButtonElement>(".tab").forEach((b) => (b.onclick = () => openPanel(b.dataset.tab ?? "HUD")));

  // ---- clock ---------------------------------------------------------------
  const tz = "America/Los_Angeles";
  const timeFmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const dateFmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "2-digit" });
  const tick = () => {
    const now = new Date();
    $("#hud-clock").textContent = timeFmt.format(now);
    $("#hud-date").textContent = dateFmt.format(now).toUpperCase();
  };
  tick();
  timers.push(window.setInterval(tick, 1000));

  // ---- drawer --------------------------------------------------------------
  const setDrawer = (open: boolean) => {
    drawer.dataset.open = String(open);
    toggle.setAttribute("aria-expanded", String(open));
    saveFlag(DRAWER_KEY, open);
  };
  setDrawer(loadFlag(DRAWER_KEY, true));
  toggle.onclick = () => setDrawer(drawer.dataset.open !== "true");

  // ---- orb -----------------------------------------------------------------
  let phase: Phase = "idle";
  let micState: ListenerState = "off";
  const renderOrb = () => {
    const state = speaker.speaking ? "speaking" : phase === "thinking" ? "thinking" : phase === "error" ? "error" : micState === "awake" ? "listening" : "idle";
    orb.dataset.state = state;
    if (state === "speaking") caption.textContent = "Speaking";
    else if (state === "thinking") caption.textContent = "Working";
    else if (state === "listening") caption.textContent = "Listening";
    else if (state === "error") caption.textContent = "Fault";
    else caption.textContent = "Standing by";
  };
  let raf = 0;
  const animate = () => {
    orb.style.setProperty("--level", speaker.level().toFixed(3));
    raf = requestAnimationFrame(animate);
  };
  raf = requestAnimationFrame(animate);

  // ---- the conversation ----------------------------------------------------
  const transcript = new Transcript($("#transcript"));
  const listener = new Listener({
    onCommand: (text) => {
      speaker.stop();
      void jarvis.ask(text);
    },
    onHearing: (text) => {
      if (text) sub.textContent = `“${text}”`;
      else if (phase !== "thinking") sub.textContent = "";
    },
    onState: (s) => {
      micState = s;
      mic.dataset.state = s;
      mic.textContent = MIC_LABEL[s];
      renderOrb();
    },
  });
  const jarvis = new Jarvis(transcript, {
    onPhase: (p, detail) => {
      phase = p;
      if (p === "thinking" && detail) sub.textContent = `“${detail}”`;
      if (p === "error" && detail) sub.textContent = detail;
      if (p === "idle" && !speaker.speaking) sub.textContent = "";
      renderOrb();
    },
    onReply: (text) => speaker.say(text),
    onUsage: (cost, cap) => {
      if (cost === null) return;
      meta.textContent = `$${(cost / 100).toFixed(2)}${cap ? ` of $${(cap / 100).toFixed(2)}` : ""}`;
    },
    openPanel,
  });
  speaker.onChange((s) => {
    if (s === "speaking") listener.pause();
    else listener.resumeAfterSpeech();
    renderOrb();
  });

  modelSelect.value = jarvis.model;
  modelSelect.onchange = () => jarvis.setModel(modelSelect.value);
  $<HTMLButtonElement>("#drawer-new").onclick = () => {
    speaker.stop();
    jarvis.newConversation();
    meta.textContent = "";
  };

  $<HTMLFormElement>("#ask").onsubmit = (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    speaker.stop();
    void jarvis.ask(text);
  };

  // Click the orb: stop talking if he is, otherwise listen without the wake word.
  orb.onclick = () => {
    if (speaker.speaking) {
      speaker.stop();
      return;
    }
    listener.arm();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    speaker.stop();
    void jarvis.interrupt();
  };
  window.addEventListener("keydown", onKey);

  $<HTMLButtonElement>("#hud-lock").onclick = async () => {
    await lock();
    onLocked();
  };

  // ---- systems panel -------------------------------------------------------
  const rows = $<HTMLUListElement>("#systems-rows");
  const renderSystems = async () => {
    try {
      const ops = compactOps(await get<Record<string, unknown>>("ops"));
      rows.replaceChildren(
        ...ops.map((r) => {
          const li = document.createElement("li");
          li.className = "row";
          li.dataset.state = r.state;
          const name = document.createElement("span");
          name.className = "row-name";
          name.textContent = r.service;
          const detail = document.createElement("span");
          detail.className = "row-detail";
          detail.textContent = r.headline;
          li.append(name, detail);
          return li;
        }),
      );
      const tag = root.querySelector<HTMLElement>("#panel-systems [data-tag]");
      if (tag) tag.textContent = `${ops.filter((r) => r.state === "ok").length}/${ops.length} ok`;
    } catch {
      rows.innerHTML = `<li class="panel-empty">Operations feed unavailable</li>`;
    }
  };
  void renderSystems();
  timers.push(window.setInterval(() => void renderSystems(), 60_000));

  // ---- start ---------------------------------------------------------------
  get<Me>("me")
    .then((me) => {
      link.dataset.state = "ok";
      link.textContent = "Link · API";
      link.title = `key ${me.name} (${me.key_id})`;
    })
    .catch(() => {
      link.dataset.state = "down";
      link.textContent = "Link down";
    });

  listener.start();
  void jarvis.resume();
  void greeting().then((line) => {
    transcript.note(line);
    speaker.say(line);
  });

  return {
    unmount() {
      timers.forEach((t) => window.clearInterval(t));
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey);
      listener.stop();
      speaker.stop();
      speaker.onChange(null);
      jarvis.detach();
    },
  };
}
