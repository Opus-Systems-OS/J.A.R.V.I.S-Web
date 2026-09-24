// Always-on listening, with two engines behind one wake-word gate:
// - browser: Chrome/Edge's own speech recognition, continuous, restarted
//   whenever it stops on its own (silence, network, the 60 s cap). Free.
// - cloud (ears.ts): for browsers whose recognition has no service behind it
//   (Arc, Brave, Safari, Firefox) — the page detects utterances itself and
//   has Fish transcribe them. Chosen automatically after the browser engine
//   fails three times, and remembered for this browser.
// A turn starts only when an utterance contains the wake word — "Jarvis, …"
// — or answers a question Jarvis just asked, so room noise and other
// people cost nothing. Recognition is paused while Jarvis talks, so his own
// voice never becomes a turn.
//
// The no-wake-word follow-up is deliberately narrow (learned live on
// 2026-09-23, when a classroom's talk chained turn after turn through an
// always-open follow-up window): it opens only after a reply that ends in a
// question, only once in a row — a turn that came in without the wake word
// never opens another — and it needs at least two words.

import { CloudEars } from "./ears";

// Chrome and Edge ship the API prefixed; Firefox has none.
type Recognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onresult: ((e: RecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onstart: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};
type RecognitionEvent = {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
};

export type ListenerState = "off" | "passive" | "awake" | "paused" | "unsupported" | "denied" | "unavailable";

export type Engine = "browser" | "cloud";

export interface ListenerEvents {
  /** A complete request for Jarvis (wake word already stripped). */
  onCommand(text: string): void;
  /** What is being heard right now, for the caption. `null` clears it. */
  onHearing(text: string | null): void;
  onState(state: ListenerState): void;
  /** Which engine is listening (for the mic chip). */
  onEngine?(engine: Engine): void;
}

const ENGINE_KEY = "jarvis.ears";
function loadEngine(): Engine | null {
  try {
    return localStorage.getItem(ENGINE_KEY) === "cloud" ? "cloud" : null;
  } catch {
    return null;
  }
}
function saveEngine(e: Engine) {
  try {
    localStorage.setItem(ENGINE_KEY, e);
  } catch {
    /* private mode: re-detected next load */
  }
}

const WAKE = /\b(?:hey\s+|ok(?:ay)?\s+)?(jarvis|jarvas|jervis)\b[\s,.:!?-]*/i;
/** How long after Jarvis stops speaking a reply needs no wake word. */
export const FOLLOW_UP_MS = 10_000;
/**
 * Quiet time that ends a request. Both engines break speech at natural
 * pauses ("Jarvis, I just did some research" … "on black widows"); pieces
 * arriving within this window join the request instead of being dropped as
 * speech without a wake word (seen live 2026-09-24).
 */
export const ASSEMBLE_MS = 1_300;
/** The same request twice within this window is sent once. */
const REPEAT_MS = 4_000;
/** Consecutive failed starts (nothing heard) before giving up. */
const MAX_FAILURES = 3;
/** After a bare "Jarvis", how long to wait for the actual request. */
const ARMED_MS = 8_000;

/**
 * The request around the wake word. Normally what follows it ("Jarvis, what
 * time is it"); when nothing follows, a short lead-in ("what time is it,
 * Jarvis") — but not a long one, which is more likely talk *about* Jarvis.
 */
export function stripWake(text: string): { woke: boolean; rest: string } {
  const m = WAKE.exec(text);
  if (!m) return { woke: false, rest: text.trim() };
  const after = text.slice(m.index + m[0].length).trim();
  if (after) return { woke: true, rest: after };
  const before = text.slice(0, m.index).replace(/[\s,]+$/, "").trim();
  const words = before ? before.split(/\s+/).length : 0;
  return { woke: true, rest: words > 0 && words <= 12 ? before : "" };
}

export class Listener {
  private rec: Recognition | null = null;
  private ears: CloudEars | null = null;
  private wanted = false; // should be running (not paused, not off)
  private running = false;
  private followUpUntil = 0;
  private armedUntil = 0;
  private state: ListenerState = "off";
  private restartDelay = 250;
  /** The last command came in without the wake word (a follow-up). */
  private lastWasFollowUp = false;
  /**
   * Starts that ended in an error without hearing anything. Browsers that
   * ship the API without Google's speech service (Arc, Brave, Vivaldi…)
   * fail every start with `network`; restarting them forever makes the mic
   * flicker once a second. Reset only when speech is actually heard.
   */
  private failures = 0;
  /** A request being assembled: text so far, and when to send it. */
  private pending: string | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private lastSent = { text: "", at: 0 };
  /** Cloud ears hear speech right now (the text arrives after it ends). */
  private speaking = false;

  constructor(private readonly ev: ListenerEvents) {}

  static supported(): boolean {
    return "webkitSpeechRecognition" in window || "SpeechRecognition" in window;
  }

  /** Call from a user gesture (the unlock) so the mic prompt can appear. */
  start() {
    if (loadEngine() === "cloud" || !Listener.supported()) return this.startCloud();
    this.startBrowser();
  }

  private startCloud() {
    if (!CloudEars.supported()) return this.setState(Listener.supported() ? "unavailable" : "unsupported");
    this.ev.onEngine?.("cloud");
    this.wanted = true;
    this.ears = new CloudEars({
      started: () => this.setState(this.awake() ? "awake" : "passive"),
      hearing: (active) => {
        this.speaking = active;
        if (this.pending !== null) {
          // Still talking: hold the request open; silence restarts the clock.
          if (active) clearTimeout(this.flushTimer);
          else this.scheduleFlush();
          return;
        }
        if (active && this.awake()) this.ev.onHearing("…");
        if (!active) this.ev.onHearing(null);
      },
      final: (text) => {
        if (text) this.onFinal(text);
      },
      failed: (reason) => {
        this.wanted = false;
        this.setState(reason);
      },
    });
    void this.ears.start();
  }

  /** The browser engine gave up: switch to cloud ears if this browser can. */
  private fallBack() {
    try {
      this.rec?.abort();
    } catch {
      /* not running */
    }
    this.rec = null;
    if (CloudEars.supported()) {
      saveEngine("cloud");
      this.failures = 0;
      this.startCloud();
    } else {
      this.wanted = false;
      this.setState("unavailable");
    }
  }

  private startBrowser() {
    this.ev.onEngine?.("browser");
    const Ctor = ((window as unknown as Record<string, unknown>).SpeechRecognition ??
      (window as unknown as Record<string, unknown>).webkitSpeechRecognition) as new () => Recognition;
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    rec.maxAlternatives = 1;
    rec.onstart = () => {
      this.running = true;
      if (this.failures === 0) this.setState(this.awake() ? "awake" : "passive");
    };
    rec.onresult = (e) => {
      // Something was heard: the service works.
      this.failures = 0;
      this.restartDelay = 250;
      this.onResult(e);
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed") {
        this.wanted = false;
        this.setState("denied");
        return;
      }
      if (e.error === "no-speech" || e.error === "aborted") return; // normal; onend restarts
      // "network", "service-not-allowed", "audio-capture", "language-not-supported"
      this.failures += 1;
      if (this.failures >= MAX_FAILURES) this.fallBack();
    };
    rec.onend = () => {
      this.running = false;
      if (!this.wanted || this.rec !== rec) return;
      // Back off while the service keeps failing, up to 5 s.
      window.setTimeout(() => this.resume(), this.restartDelay);
      this.restartDelay = this.failures ? Math.min(this.restartDelay * 2, 5000) : 250;
    };
    this.rec = rec;
    this.wanted = true;
    this.resume();
  }

  /** Jarvis started talking: stop hearing (his voice is not a command). */
  pause() {
    if (this.state === "denied" || this.state === "unsupported" || this.state === "unavailable") return;
    this.wanted = false;
    this.setState("paused");
    this.dropPending();
    this.ears?.pause();
    try {
      this.rec?.abort();
    } catch {
      /* not running */
    }
  }

  /**
   * Jarvis stopped talking: listen again. `askedQuestion`: his reply ended
   * in a question, so the answer may come without the wake word — unless
   * the turn he was replying to was itself a follow-up.
   */
  resumeAfterSpeech(askedQuestion: boolean) {
    if (this.state === "denied" || this.state === "unsupported" || this.state === "unavailable") return;
    this.followUpUntil = askedQuestion && !this.lastWasFollowUp ? Date.now() + FOLLOW_UP_MS : 0;
    this.wanted = true;
    if (this.ears) {
      this.ears.resume();
      this.setState(this.awake() ? "awake" : "passive");
    }
    this.resume();
  }

  /** Treat the next utterance as addressed to Jarvis (orb click). */
  arm() {
    if (this.state === "denied" || this.state === "unsupported" || this.state === "unavailable") return;
    this.armedUntil = Date.now() + ARMED_MS;
    if (!this.wanted) {
      this.wanted = true;
      this.ears?.resume();
      this.resume();
    }
    this.setState("awake");
  }

  stop() {
    this.wanted = false;
    try {
      this.rec?.abort();
    } catch {
      /* not running */
    }
    this.rec = null;
    this.ears?.stop();
    this.ears = null;
    this.dropPending();
    this.setState("off");
  }

  private dropPending() {
    clearTimeout(this.flushTimer);
    this.pending = null;
    this.speaking = false;
    this.ev.onHearing(null);
  }

  private resume() {
    if (!this.rec || this.running || !this.wanted) return;
    try {
      this.rec.start();
    } catch {
      /* already starting */
    }
  }

  private awake(): boolean {
    const now = Date.now();
    return now < this.followUpUntil || now < this.armedUntil;
  }

  private onResult(e: RecognitionEvent) {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      const text = r[0].transcript;
      if (!r.isFinal) {
        interim += text;
        continue;
      }
      this.onFinal(text);
    }
    if (interim) {
      if (this.pending !== null) {
        // More of the same request is coming: wait for it.
        this.scheduleFlush();
        this.ev.onHearing(`${this.pending} ${interim.trim()}`);
        return;
      }
      const { woke, rest } = stripWake(interim);
      if (woke || this.awake()) {
        this.setState("awake");
        this.ev.onHearing(rest || "…");
      }
    }
  }

  private scheduleFlush() {
    clearTimeout(this.flushTimer);
    // Never close a request while speech is still coming in; the end of
    // that speech schedules the flush.
    if (this.speaking) return;
    this.flushTimer = setTimeout(() => this.flush(), ASSEMBLE_MS);
  }

  private flush() {
    const text = (this.pending ?? "").replace(/\s+/g, " ").trim();
    this.pending = null;
    this.ev.onHearing(null);
    if (!text) return;
    const now = Date.now();
    if (text.toLowerCase() === this.lastSent.text && now - this.lastSent.at < REPEAT_MS) return;
    this.lastSent = { text: text.toLowerCase(), at: now };
    this.ev.onCommand(text);
  }

  private onFinal(text: string) {
    if (this.pending !== null) {
      // The next piece of a request already under way: no wake word needed.
      this.pending = `${this.pending} ${text.trim()}`;
      this.ev.onHearing(this.pending);
      this.scheduleFlush();
      return;
    }
    const { woke, rest } = stripWake(text);
    const armed = Date.now() < this.armedUntil;
    const followUp = !woke && !armed && Date.now() < this.followUpUntil;
    this.ev.onHearing(null);
    if (!woke && !armed && !followUp) {
      this.setState("passive");
      return; // not for Jarvis
    }
    if (followUp && rest.split(/\s+/).filter(Boolean).length < 2) {
      return; // a cough, a "yeah" across the room: not an answer
    }
    if (!rest) {
      // Just "Jarvis": wait for the request itself.
      this.armedUntil = Date.now() + ARMED_MS;
      this.setState("awake");
      return;
    }
    this.armedUntil = 0;
    this.followUpUntil = 0;
    this.lastWasFollowUp = followUp;
    this.setState("awake");
    // Don't send yet: the sentence may continue after a pause.
    this.pending = rest;
    this.ev.onHearing(rest);
    this.scheduleFlush();
  }

  private setState(s: ListenerState) {
    if (s === this.state) return;
    this.state = s;
    this.ev.onState(s);
  }
}
