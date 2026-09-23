// Always-on listening. Chrome's speech recognition runs continuously and is
// restarted whenever it stops on its own (silence, network, the 60 s cap).
// A turn starts only when an utterance contains the wake word — "Jarvis, …"
// — or arrives within the follow-up window after Jarvis finishes speaking,
// so room noise and other people cost nothing. Recognition is paused while
// Jarvis talks, so his own voice never becomes a turn.

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

export type ListenerState = "off" | "passive" | "awake" | "paused" | "unsupported" | "denied";

export interface ListenerEvents {
  /** A complete request for Jarvis (wake word already stripped). */
  onCommand(text: string): void;
  /** What is being heard right now, for the caption. `null` clears it. */
  onHearing(text: string | null): void;
  onState(state: ListenerState): void;
}

const WAKE = /\b(?:hey\s+|ok(?:ay)?\s+)?(jarvis|jarvas|jervis)\b[\s,.:!?-]*/i;
/** How long after Jarvis stops speaking a reply needs no wake word. */
export const FOLLOW_UP_MS = 10_000;
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
  private wanted = false; // should be running (not paused, not off)
  private running = false;
  private followUpUntil = 0;
  private armedUntil = 0;
  private state: ListenerState = "off";
  private restartDelay = 250;

  constructor(private readonly ev: ListenerEvents) {}

  static supported(): boolean {
    return "webkitSpeechRecognition" in window || "SpeechRecognition" in window;
  }

  /** Call from a user gesture (the unlock) so the mic prompt can appear. */
  start() {
    if (!Listener.supported()) return this.setState("unsupported");
    const Ctor = ((window as unknown as Record<string, unknown>).SpeechRecognition ??
      (window as unknown as Record<string, unknown>).webkitSpeechRecognition) as new () => Recognition;
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    rec.maxAlternatives = 1;
    rec.onstart = () => {
      this.running = true;
      this.restartDelay = 250;
      this.setState(this.awake() ? "awake" : "passive");
    };
    rec.onresult = (e) => this.onResult(e);
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        this.wanted = false;
        this.setState("denied");
      }
      // "no-speech", "network", "aborted": onend restarts.
    };
    rec.onend = () => {
      this.running = false;
      if (!this.wanted) return;
      // Back off if the service keeps failing, up to 5 s.
      window.setTimeout(() => this.resume(), this.restartDelay);
      this.restartDelay = Math.min(this.restartDelay * 2, 5000);
    };
    this.rec = rec;
    this.wanted = true;
    this.resume();
  }

  /** Jarvis started talking: stop hearing (his voice is not a command). */
  pause() {
    if (this.state === "denied" || this.state === "unsupported") return;
    this.wanted = false;
    this.setState("paused");
    this.ev.onHearing(null);
    try {
      this.rec?.abort();
    } catch {
      /* not running */
    }
  }

  /** Jarvis stopped talking: listen again, and open the follow-up window. */
  resumeAfterSpeech() {
    this.followUpUntil = Date.now() + FOLLOW_UP_MS;
    this.wanted = true;
    this.resume();
  }

  /** Treat the next utterance as addressed to Jarvis (orb click). */
  arm() {
    this.armedUntil = Date.now() + ARMED_MS;
    if (!this.wanted && this.rec) {
      this.wanted = true;
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
    this.setState("off");
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
      const { woke, rest } = stripWake(interim);
      if (woke || this.awake()) {
        this.setState("awake");
        this.ev.onHearing(rest || "…");
      }
    }
  }

  private onFinal(text: string) {
    const { woke, rest } = stripWake(text);
    const awake = this.awake();
    this.ev.onHearing(null);
    if (!woke && !awake) {
      this.setState("passive");
      return; // not for Jarvis
    }
    if (!rest) {
      // Just "Jarvis": wait for the request itself.
      this.armedUntil = Date.now() + ARMED_MS;
      this.setState("awake");
      return;
    }
    this.armedUntil = 0;
    this.followUpUntil = 0;
    this.setState("passive");
    this.ev.onCommand(rest);
  }

  private setState(s: ListenerState) {
    if (s === this.state) return;
    this.state = s;
    this.ev.onState(s);
  }
}
