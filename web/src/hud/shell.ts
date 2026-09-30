// The HUD: top bar (tabs, model, mic, clock, link, lock), three columns
// around the orb, and the dock (transcript drawer + text line). It wires
// the pieces together — Listener (mic) → Jarvis (session) → Speaker (voice)
// — and owns nothing else: no fleet state, no conversation state beyond
// the session bookmark Jarvis keeps.

import { get, lock, type Me, type Profile } from "../api";
import { CreditWatch, creditLine, dollars, fishDollars, level, type Credits } from "./credits";
import { ago, FleetView } from "./fleet";
import { greeting } from "./greeting";
import { Jarvis, MODELS, type Phase } from "./jarvis";
import { Listener, type Engine, type ListenerState } from "./listener";
import { MicLease } from "./micLease";
import { Speaker } from "./speaker";
import { SystemsView } from "./systems";
import { TerminalView, terminalTask } from "./terminal";
import { compactOps, tabsFor } from "./tools";
import { Attachments } from "./attach";
import { agentName, JobWatch, type Job } from "./jobs";
import { ReminderWatch } from "./reminders";
import { Transcript } from "./transcript";
import { isoSeconds, UsageView } from "./usage";

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

/** The owner sees every panel; anyone else, their own conversation, fleet
 * sessions, spend and terminal (no Systems, no Jobs, no credit ledger). */
const template = (full: boolean) => `
  <header class="topbar">
    <div class="brand"><span class="brand-mark" aria-hidden="true"></span>J.A.R.V.I.S.</div>
    <nav class="tabs" role="tablist">
      ${tabsFor(full).map((t, i) => `<button role="tab" class="tab" data-tab="${t}" aria-selected="${i === 0}">${t}</button>`).join("")}
    </nav>
    <div class="readouts">
      <span class="chip" id="hud-mic" data-state="off" title="Microphone">Mic</span>
      <span class="readout" id="hud-date"></span>
      <span class="readout readout-clock" id="hud-clock"></span>
      <span class="chip" id="hud-link" data-state="pending">Link</span>
      <button class="btn-ghost" id="hud-lock" title="Lock">Lock</button>
    </div>
  </header>
  <div class="banner" id="hud-banner" role="status">
    <span class="banner-text" id="hud-banner-text"></span>
    <button class="btn-ghost" id="hud-banner-usage">Usage</button>
    <button class="btn-ghost" id="hud-banner-close" aria-label="Dismiss">Dismiss</button>
  </div>
  <div class="views">
  <div class="stage" data-view="HUD">
    <aside class="column column-left">
      ${PANEL("panel-fleet", "Fleet", `<ul class="rows recent" id="recent-rows"><li class="panel-empty">Reading the fleet…</li></ul>`)}
      ${full ? PANEL("panel-jobs", "Jobs", `<ul class="rows" id="job-rows"><li class="panel-empty">No jobs dispatched</li></ul>`) : ""}
    </aside>
    <div class="center">
      <button class="orb" id="orb" data-state="idle" aria-label="Talk to Jarvis">${ORB_SVG}</button>
      <p class="orb-caption" id="orb-caption">Standing by</p>
      <p class="orb-sub" id="orb-sub"></p>
    </div>
    <aside class="column column-right">
      ${full ? PANEL("panel-systems", "Systems", `<ul class="rows" id="systems-rows"><li class="panel-empty">Reading the tower…</li></ul>`) : ""}
      ${PANEL("panel-usage", "Usage", `<ul class="rows" id="usage-rows"><li class="panel-empty">Reading the ledger…</li></ul>`)}
    </aside>
  </div>
  <div class="view" data-view="Fleet" id="view-fleet" hidden></div>
  ${full ? `<div class="view" data-view="Systems" id="view-systems" hidden></div>` : ""}
  <div class="view" data-view="Usage" id="view-usage" hidden></div>
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
        <div class="ask-tray" id="ask-tray" aria-label="Attached files" hidden></div>
        <button class="ask-attach" id="ask-attach" type="button" title="Attach files (or drop or paste them)" aria-label="Attach files">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M21 11.5l-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l8-8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <input id="ask-files" type="file" multiple hidden />
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
export function mountHud(root: HTMLElement, speaker: Speaker, onLocked: () => void, profile: Profile): Hud {
  const full = profile.full;
  root.innerHTML = template(full);
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
  const fleetView = full ? new FleetView($("#view-fleet")) : new FleetView($("#view-fleet"), []);
  const systemsView = full ? new SystemsView($("#view-systems")) : null;
  const usageView = new UsageView($("#view-usage"), (c) => watch.observe(c), full);
  let current = "HUD";
  const openPanel = (tab: string) => {
    root.querySelectorAll<HTMLButtonElement>(".tab").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.tab === tab)));
    root.querySelectorAll<HTMLElement>("[data-view]").forEach((v) => (v.hidden = v.dataset.view !== tab));
    root.dataset.tab = tab;
    if (current === "Fleet") fleetView.hide();
    if (current === "Systems") systemsView?.hide();
    if (current === "Usage") usageView.hide();
    current = tab;
    if (tab === "Fleet") fleetView.show();
    if (tab === "Systems") systemsView?.show();
    if (tab === "Usage") usageView.show();
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
  const attachments = new Attachments($("#ask-tray"), (t) => transcript.note(t, true));
  /** A request, typed or spoken, with whatever is in the tray. */
  const send = async (text: string) => {
    speaker.stop();
    const files = attachments.count ? await attachments.take() : [];
    void jarvis.ask(text, { attachments: files });
  };
  const listener = new Listener({
    onCommand: (text) => void send(text),
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

  const jarvis = new Jarvis(
    transcript,
    {
    jobs: () => jobWatch.current,
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
    onBillingError: () => {
      if (!full) return; // the ledger is the owner's; Jarvis already said so
      watch.markExhausted();
      setBanner("exhausted", "The Anthropic account is out of credit. Top up, then set the new balance in Usage.");
      void watch.poll();
    },
    },
    profile,
  );
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
    if (!text && !attachments.count) return;
    input.value = "";
    void send(text);
  };

  // ---- attachments: paperclip, drop anywhere on the HUD, paste -------------
  const picker = $<HTMLInputElement>("#ask-files");
  $<HTMLButtonElement>("#ask-attach").onclick = () => picker.click();
  picker.onchange = () => {
    if (picker.files) attachments.add(Array.from(picker.files));
    picker.value = "";
    input.focus();
  };
  const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
  const onDragOver = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    root.dataset.dropping = "true";
  };
  const onDragLeave = (e: DragEvent) => {
    if (!e.relatedTarget) delete root.dataset.dropping;
  };
  const onDrop = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    delete root.dataset.dropping;
    attachments.add(Array.from(e.dataTransfer?.files ?? []));
    setDrawer(true);
    input.focus();
  };
  window.addEventListener("dragover", onDragOver);
  window.addEventListener("dragleave", onDragLeave);
  window.addEventListener("drop", onDrop);
  input.addEventListener("paste", (e) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (!files.length) return;
    e.preventDefault();
    attachments.add(files);
  });

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

  // ---- systems panel (the owner's) ------------------------------------------
  const renderSystems = async () => {
    const rows = root.querySelector<HTMLUListElement>("#systems-rows");
    if (!rows) return;
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
  if (full) {
    void renderSystems();
    timers.push(window.setInterval(() => void renderSystems(), 60_000));
  }

  // ---- credits: banner, Usage panel, spoken warnings ---------------------------
  const banner = $<HTMLDivElement>("#hud-banner");
  let dismissed = "";
  const setBanner = (lvl: string, text: string) => {
    if (lvl === "ok" || !text) {
      delete banner.dataset.level;
      dismissed = "";
      return;
    }
    if (dismissed === `${lvl}:${text}`) return;
    banner.dataset.level = lvl;
    $("#hud-banner-text").textContent = text;
  };
  $<HTMLButtonElement>("#hud-banner-close").onclick = () => {
    dismissed = `${banner.dataset.level}:${$("#hud-banner-text").textContent}`;
    delete banner.dataset.level;
  };
  $<HTMLButtonElement>("#hud-banner-usage").onclick = () => openPanel("Usage");

  const usageRows = $<HTMLUListElement>("#usage-rows");
  let spent24h: number | null = null;
  const row = (name: string, detail: string, state: string) => {
    const li = document.createElement("li");
    li.className = "row";
    li.dataset.state = state;
    const n = document.createElement("span");
    n.className = "row-name";
    n.textContent = name;
    const d = document.createElement("span");
    d.className = "row-detail";
    d.textContent = detail;
    li.append(n, d);
    li.onclick = () => openPanel("Usage");
    return li;
  };
  let lastCredits: Credits | null = null;
  const renderUsagePanel = () => {
    const c = lastCredits;
    const rows: HTMLLIElement[] = [];
    if (c) {
      const a = c.anthropic;
      rows.push(
        row(
          "Anthropic",
          a.exhausted ? "out of credit" : a.remaining_cents !== null ? `≈ ${dollars(a.remaining_cents)} est.` : a.error ? "unavailable" : "balance not set",
          a.exhausted ? "down" : a.low ? "warn" : a.remaining_cents !== null ? "ok" : "idle",
        ),
      );
      rows.push(row("Voice", c.fish.credit_usd !== null ? `${fishDollars(c.fish.credit_usd)} Fish credit` : "unavailable", c.fish.error ? "idle" : c.fish.low ? "warn" : "ok"));
    }
    if (spent24h !== null) rows.push(row("Fleet", `${dollars(spent24h)} in 24 h`, "ok"));
    if (rows.length) usageRows.replaceChildren(...rows);
    const tag = root.querySelector<HTMLElement>("#panel-usage [data-tag]");
    if (tag && c) tag.textContent = level(c) === "ok" ? "nominal" : level(c);
  };
  const refresh24h = async () => {
    try {
      const u = await get<{ by_agent: { total_list_cost_cents: number }[] }>(`usage?since=${isoSeconds(new Date(Date.now() - 86_400_000))}`);
      spent24h = u.by_agent.reduce((s, a) => s + (a.total_list_cost_cents || 0), 0);
      renderUsagePanel();
    } catch {
      /* the credit rows still show */
    }
  };
  void refresh24h();
  timers.push(window.setInterval(() => void refresh24h(), 5 * 60_000));

  const watch = new CreditWatch({
    onCredits: (c) => {
      lastCredits = c;
      renderUsagePanel();
      usageView.setCredits(c);
      setBanner(level(c), creditLine(c) ?? "");
    },
    onWarn: (line) => {
      transcript.note(line);
      // Only the HUD with the mic speaks, like the greeting.
      if (lease.held) {
        lastReplyAsked = false;
        speaker.say(line);
      }
    },
  });

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

  // ---- jobs Jarvis dispatched (BlueWeb, the rig; the owner's) ---------------
  const jobRows = root.querySelector<HTMLUListElement>("#job-rows");
  const DAY = 86_400_000;
  const renderJobs = (all: Job[]) => {
    if (!jobRows) return;
    // Working ones, and anything that stopped in the last day.
    const jobs = all
      .filter((j) => j.status === "running" || j.status === "rescheduling" || (j.updatedAt && Date.now() - Date.parse(j.updatedAt) < DAY))
      .slice(0, 6);
    const tag = root.querySelector<HTMLElement>("#panel-jobs [data-tag]");
    const working = jobs.filter((j) => j.status === "running" || j.status === "rescheduling").length;
    if (tag) tag.textContent = working ? `${working} working` : "standby";
    if (!jobs.length) {
      jobRows.innerHTML = `<li class="panel-empty">No jobs dispatched</li>`;
      return;
    }
    jobRows.replaceChildren(
      ...jobs.map((j) => {
        const li = document.createElement("li");
        li.className = "row";
        li.dataset.state = j.status === "running" || j.status === "rescheduling" ? "ok" : j.status === "terminated" ? "down" : "idle";
        const name = document.createElement("span");
        name.className = "row-name";
        name.textContent = agentName(j.agent);
        const detail = document.createElement("span");
        detail.className = "row-detail";
        detail.textContent = `${j.title} · ${j.status} · ${ago(j.updatedAt)}`;
        li.append(name, detail);
        li.title = "Open in Fleet";
        li.onclick = () => {
          openPanel("Fleet");
          fleetView.open(j.id);
        };
        return li;
      }),
    );
  };
  const reminderWatch = new ReminderWatch({
    speaks: () => lease.held,
    announce: (line) => {
      transcript.note(line);
      lastReplyAsked = false;
      speaker.say(line);
    },
  });
  const jobWatch = new JobWatch({
    onJobs: renderJobs,
    onAnnounce: (line) => {
      transcript.note(line);
      if (lease.held) {
        lastReplyAsked = false;
        speaker.say(line);
      }
    },
  });

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
  if (full) {
    watch.start();
    jobWatch.start();
  }
  void jarvis.resume();
  void Promise.all([greeting(profile), firstClaim]).then(([line, held]) => {
    transcript.note(line);
    lastReplyAsked = false; // the greeting never opens a follow-up
    // Only the HUD with the mic speaks it; another open window just shows it.
    if (held) speaker.say(line);
    // Then anything that came due while no HUD was open.
    void reminderWatch.check();
    reminderWatch.start();
  });

  return {
    unmount() {
      timers.forEach((t) => window.clearInterval(t));
      jobWatch.stop();
      reminderWatch.stop();
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("focus", takeOnFocus);
      document.removeEventListener("visibilitychange", takeOnFocus);
      lease.onChange(null);
      lease.stop();
      listener.stop();
      speaker.stop();
      speaker.onChange(null);
      jarvis.detach();
      fleetView.dispose();
      systemsView?.dispose();
      usageView.dispose();
      watch.stop();
    },
  };
}
