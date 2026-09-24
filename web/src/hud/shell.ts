// The HUD: top bar (tabs, model, mic, clock, link, lock), three columns
// around the orb, and the dock (transcript drawer + text line). It wires
// the pieces together — Listener (mic) → Jarvis (session) → Speaker (voice)
// — and owns nothing else: no fleet state, no conversation state beyond
// the session bookmark Jarvis keeps.

import { get, lock, type Me } from "../api";
import { ago, FleetView } from "./fleet";
import { greeting } from "./greeting";
import { Jarvis, MODELS, type Phase } from "./jarvis";
import { Listener, type Engine, type ListenerState } from "./listener";
import { MicLease } from "./micLease";
import { Speaker } from "./speaker";
import { SystemsView } from "./systems";
import { TerminalView, terminalTask } from "./terminal";
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
  <div class="views">
  <div class="stage" data-view="HUD">
    <aside class="column column-left">
      ${PANEL("panel-fleet", "Fleet", `<ul class="rows recent" id="recent-rows"><li class="panel-empty">Reading the fleet…</li></ul>`)}
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
  <div class="view" data-view="Fleet" id="view-fleet" hidden></div>
  <div class="view" data-view="Systems" id="view-systems" hidden></div>
  <div class="view view-soon" data-view="Usage" hidden><p class="panel-empty">Spend, credits and warnings arrive in the next module.</p></div>
  <div class="view" data-view="Terminal" id="view-terminal" hidden></div>
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
  unavailable: "Voice input unavailable here — type below",
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
  root.dataset.tab = "HUD";
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
  const timers: number[] = [];

  // ---- views ---------------------------------------------------------------
  const fleetView = new FleetView($("#view-fleet"));
  const systemsView = new SystemsView($("#view-systems"));
  let current = "HUD";
  const openPanel = (tab: string) => {
    root.querySelectorAll<HTMLButtonElement>(".tab").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.tab === tab)));
    root.querySelectorAll<HTMLElement>("[data-view]").forEach((v) => (v.hidden = v.dataset.view !== tab));
    root.dataset.tab = tab;
    if (current === "Fleet") fleetView.hide();
    if (current === "Systems") systemsView.hide();
    current = tab;
    if (tab === "Fleet") fleetView.show();
    if (tab === "Systems") systemsView.show();
    if (tab === "Terminal") terminal.focus();
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
  let lastReplyAsked = false; // did Jarvis's last spoken reply end in a question?
  let micState: ListenerState = "off";
  let engine: Engine = "browser";
  const lease = new MicLease();
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
      renderMic();
      renderOrb();
    },
    onEngine: (e) => {
      engine = e;
      mic.title =
        e === "cloud"
          ? "This browser has no speech service of its own: speech is detected here and transcribed by Fish (≈ $0.36 per hour of speech; silence is never sent)."
          : "The browser's own speech recognition.";
    },
  });
  const renderMic = () => {
    if (!lease.held && (micState === "off" || micState === "paused")) {
      mic.dataset.state = "elsewhere";
      mic.textContent = "Mic in another window";
      mic.title = "Another open HUD is listening. Click the orb to listen here instead.";
      return;
    }
    mic.dataset.state = micState;
    mic.textContent = MIC_LABEL[micState] + (engine === "cloud" && (micState === "passive" || micState === "awake") ? " · cloud" : "");
  };
  // Only the HUD holding the lease listens; the rest wait (orb click = take it).
  lease.onChange((held) => {
    if (held) listener.start();
    else listener.stop();
    renderMic();
  });

  const terminal = new TerminalView($("#view-terminal"), {
    run: (cmd) => {
      speaker.stop();
      void jarvis.ask(terminalTask(cmd), { silent: true });
    },
    sessionId: () => jarvis.session,
  });

  const jarvis = new Jarvis(transcript, {
    onPhase: (p, detail) => {
      phase = p;
      if (p === "thinking" && detail) sub.textContent = `“${detail}”`;
      if (p === "error" && detail) sub.textContent = detail;
      if (p === "idle" && !speaker.speaking) sub.textContent = "";
      renderOrb();
    },
    onReply: (text) => {
      lastReplyAsked = /\?["')\]]*\s*$/.test(text.trim());
      speaker.say(text);
    },
    onUsage: (cost, cap) => {
      if (cost === null) return;
      meta.textContent = `$${(cost / 100).toFixed(2)}${cap ? ` of $${(cap / 100).toFixed(2)}` : ""}`;
    },
    openPanel,
    onEvent: (e) => terminal.feed(e),
  });
  speaker.onChange((s) => {
    if (s === "speaking") listener.pause();
    else listener.resumeAfterSpeech(lastReplyAsked);
    renderOrb();
  });

  modelSelect.value = jarvis.model;
  modelSelect.onchange = () => {
    jarvis.setModel(modelSelect.value);
    terminal.clear();
  };
  $<HTMLButtonElement>("#drawer-new").onclick = () => {
    speaker.stop();
    jarvis.newConversation();
    terminal.clear();
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

  // Click the orb: stop talking if he is; take the mic if another HUD has
  // it; otherwise listen without the wake word.
  orb.onclick = async () => {
    if (speaker.speaking) {
      speaker.stop();
      return;
    }
    if (!lease.held) await lease.claim(true);
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

  // ---- recent sessions (HUD's Fleet panel) ----------------------------------
  const recent = $<HTMLUListElement>("#recent-rows");
  const renderRecent = async () => {
    try {
      const list = (
        await get<{ data: { id: string; status: string; title?: string; updated_at?: string; created_at: string; metadata?: Record<string, string> }[] }>(
          "sessions?limit=6&order=desc",
        )
      ).data;
      recent.replaceChildren(
        ...list.map((s) => {
          const li = document.createElement("li");
          li.className = "row";
          li.dataset.state = s.status === "running" ? "ok" : s.status === "terminated" ? "down" : "idle";
          const name = document.createElement("span");
          name.className = "row-name";
          name.textContent = s.metadata?.iron_fleet_agent ?? "?";
          const detail = document.createElement("span");
          detail.className = "row-detail";
          detail.textContent = `${s.title ?? s.id} · ${ago(s.updated_at ?? s.created_at)}`;
          li.append(name, detail);
          li.onclick = () => openPanel("Fleet");
          return li;
        }),
      );
      const tag = root.querySelector<HTMLElement>("#panel-fleet [data-tag]");
      if (tag) tag.textContent = `${list.filter((s) => s.status === "running").length} running`;
    } catch {
      recent.innerHTML = `<li class="panel-empty">Fleet unavailable</li>`;
    }
  };
  void renderRecent();
  timers.push(window.setInterval(() => void renderRecent(), 30_000));

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

  // The window you're using gets the mic: this one on unlock (you just typed
  // the passphrase here), and any HUD you switch back to.
  const takeOnFocus = () => {
    if (document.visibilityState === "visible" && document.hasFocus() && !lease.held) void lease.claim(true);
  };
  window.addEventListener("focus", takeOnFocus);
  document.addEventListener("visibilitychange", takeOnFocus);
  const firstClaim = lease.claim(true).then((held) => {
    renderMic();
    return held;
  });
  lease.start();
  void jarvis.resume();
  void Promise.all([greeting(), firstClaim]).then(([line, held]) => {
    transcript.note(line);
    lastReplyAsked = false; // the greeting never opens a follow-up
    // Only the HUD with the mic speaks it; another open window just shows it.
    if (held) speaker.say(line);
  });

  return {
    unmount() {
      timers.forEach((t) => window.clearInterval(t));
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("focus", takeOnFocus);
      document.removeEventListener("visibilitychange", takeOnFocus);
      lease.onChange(null);
      lease.stop();
      listener.stop();
      speaker.stop();
      speaker.onChange(null);
      jarvis.detach();
      fleetView.dispose();
      systemsView.dispose();
    },
  };
}
