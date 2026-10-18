// Jarvis's voice: text in, the Fish voice out through `/bff/v1/voice/speak`,
// one sentence at a time so the first words play while the rest are still
// being synthesised. `speechSynthesis` is the fallback when the voice API
// fails. The analyser's level drives the orb while he talks.
//
// iPhone browsers (Safari, and Arc, which is Safari underneath there) only
// play audio a tap started. So one audio element is unlocked by the unlock
// tap and reused for every sentence, and any later tap unlocks it again if
// iOS took it back (a locked screen, a call). There it plays directly, not
// through Web Audio: the silent switch mutes Web Audio and a locked screen
// suspends it, and the orb pulses on its own instead of following a meter.

import { raw } from "../api";

export type SpeakerState = "speaking" | "idle";

/** Split into sentence-sized chunks the TTS handles well (≤ 400 chars). */
export function sentences(text: string): string[] {
  const clean = text
    .replace(/```[\s\S]*?```/g, " ") // never read code aloud
    .replace(/[*_#`>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return [];
  const parts = clean.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [clean];
  const out: string[] = [];
  let buf = "";
  for (const p of parts) {
    if ((buf + p).length > 400 && buf) {
      out.push(buf.trim());
      buf = "";
    }
    buf += p;
    // Very short fragments ("Sir.") ride with the next sentence.
    if (buf.trim().length >= 40) {
      out.push(buf.trim());
      buf = "";
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

interface Item {
  text: string;
  audio?: Promise<Blob | null>;
}

/** iPhone and iPad (an iPad says it is a Mac, with touch). */
export function isAppleTouch(nav: Pick<Navigator, "userAgent" | "platform" | "maxTouchPoints"> = navigator): boolean {
  return /iP(hone|ad|od)/.test(nav.userAgent) || (nav.platform === "MacIntel" && nav.maxTouchPoints > 1);
}

/** A tenth of a second of silence as a WAV blob: what the unlock tap plays. */
export function silentWav(): Blob {
  const rate = 8000;
  const samples = rate / 10;
  const buf = new ArrayBuffer(44 + samples * 2);
  const v = new DataView(buf);
  const text = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  v.setUint32(4, 36 + samples * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, "data");
  v.setUint32(40, samples * 2, true);
  return new Blob([buf], { type: "audio/wav" });
}

export class Speaker {
  private readonly queue: Item[] = [];
  private busy = false;
  /** The one element every sentence plays through, unlocked by a tap. */
  private player: HTMLAudioElement | null = null;
  private silence: string | null = null;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private readonly samples = new Uint8Array(256);
  private generation = 0;
  private listener: ((s: SpeakerState) => void) | null = null;
  /** iOS refused to play: the next tap anywhere unlocks again. */
  private blocked = false;
  private readonly direct = isAppleTouch();

  /** Who hears "speaking" / "idle" (the HUD while it is mounted). */
  onChange(cb: ((s: SpeakerState) => void) | null) {
    this.listener = cb;
  }

  private onState(s: SpeakerState) {
    this.listener?.(s);
  }

  /** Must run inside a user gesture (the unlock click) so audio may play. */
  prime() {
    this.unlock();
    if (this.ctx || this.direct) return;
    try {
      this.ctx = new AudioContext();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.connect(this.ctx.destination);
      void this.ctx.resume();
      if (this.player) this.ctx.createMediaElementSource(this.player).connect(this.analyser);
    } catch {
      this.ctx = null;
      this.analyser = null;
    }
  }

  /**
   * Inside a tap: play a moment of silence on the shared element (which
   * lets iOS play it later without a tap), wake the speech fallback and
   * the meter. Taps after the first re-unlock only if something was lost.
   */
  private unlock() {
    if (!this.player) {
      this.player = new Audio();
      this.player.setAttribute("playsinline", "");
      this.player.preload = "auto";
      this.silence = URL.createObjectURL(silentWav());
      // Later taps (the orb, a button) re-unlock what iOS takes back.
      document.addEventListener("pointerdown", () => this.relock(), { capture: true, passive: true });
    }
    const p = this.player;
    if (p.paused && this.silence) {
      p.src = this.silence;
      p.play().then(
        () => (this.blocked = false),
        () => undefined,
      );
    }
    if ("speechSynthesis" in window) {
      const u = new SpeechSynthesisUtterance("");
      u.volume = 0;
      window.speechSynthesis.speak(u);
    }
    if (this.ctx && this.ctx.state !== "running") void this.ctx.resume();
  }

  private relock() {
    if (this.blocked || (this.ctx && this.ctx.state !== "running")) this.unlock();
  }

  get speaking(): boolean {
    return this.busy;
  }

  /** 0..1 loudness of what is playing now (a steady pulse with no meter). */
  level(): number {
    if (!this.busy) return 0;
    if (!this.analyser || this.ctx?.state !== "running") {
      const t = performance.now() / 1000;
      return 0.35 + 0.2 * Math.sin(t * 9) * Math.sin(t * 2.3);
    }
    this.analyser.getByteTimeDomainData(this.samples);
    let sum = 0;
    for (const v of this.samples) {
      const d = (v - 128) / 128;
      sum += d * d;
    }
    return Math.min(1, Math.sqrt(sum / this.samples.length) * 3);
  }

  say(text: string) {
    const chunks = sentences(text);
    if (!chunks.length) return;
    this.queue.push(...chunks.map((text) => ({ text })));
    if (!this.busy) void this.pump(this.generation);
  }

  /** Stop now and forget anything queued (barge-in, interrupt). */
  stop() {
    this.generation++;
    this.queue.length = 0;
    if (this.player && !this.player.paused) this.player.pause();
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    if (this.busy) {
      this.busy = false;
      this.onState("idle");
    }
  }

  private async pump(gen: number) {
    this.busy = true;
    this.onState("speaking");
    while (this.queue.length && gen === this.generation) {
      const item = this.queue.shift() as Item;
      item.audio ??= this.fetchAudio(item.text);
      // Synthesise the next sentence while this one plays.
      const upcoming = this.queue[0];
      if (upcoming && !upcoming.audio) upcoming.audio = this.fetchAudio(upcoming.text);
      const blob = await item.audio;
      if (gen !== this.generation) break;
      const played = blob ? await this.play(blob, gen) : false;
      if (!played && gen === this.generation) await this.speakLocally(item.text);
    }
    if (gen === this.generation) {
      this.busy = false;
      this.onState("idle");
    }
  }

  private async fetchAudio(text: string): Promise<Blob | null> {
    try {
      const res = await raw("POST", "voice/speak", { text, format: "mp3", latency: "low" });
      return await res.blob();
    } catch {
      return null;
    }
  }

  /** Resolves true once the clip has played, false if the browser refused it. */
  private play(blob: Blob, gen: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (gen !== this.generation) return resolve(true);
      if (!this.player) {
        // Never primed (no tap yet): a fresh element, which desktop browsers allow.
        this.player = new Audio();
        this.player.setAttribute("playsinline", "");
      }
      const audio = this.player;
      const url = URL.createObjectURL(blob);
      const done = (ok: boolean) => {
        audio.onended = audio.onerror = audio.onpause = null;
        URL.revokeObjectURL(url);
        resolve(ok);
      };
      audio.onended = () => done(true);
      audio.onerror = () => done(false);
      // stop() pauses it: the sentence is over either way.
      audio.onpause = () => {
        if (!audio.ended) done(true);
      };
      audio.src = url;
      audio.play().catch((e: unknown) => {
        // iOS took the unlock back: say it with the fallback voice if it can,
        // and let the next tap unlock the element again.
        if (e instanceof DOMException && e.name === "NotAllowedError") this.blocked = true;
        done(false);
      });
    });
  }

  private speakLocally(text: string): Promise<void> {
    return new Promise((resolve) => {
      if (!("speechSynthesis" in window)) return resolve();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "en-GB";
      u.rate = 1.02;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      window.speechSynthesis.speak(u);
    });
  }
}
