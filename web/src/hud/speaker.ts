// Jarvis's voice: text in, the Fish voice out through `/bff/v1/voice/speak`,
// one sentence at a time so the first words play while the rest are still
// being synthesised. `speechSynthesis` is the fallback when the voice API
// fails. The analyser's level drives the orb while he talks.

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

export class Speaker {
  private readonly queue: Item[] = [];
  private busy = false;
  private current: HTMLAudioElement | null = null;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private readonly samples = new Uint8Array(256);
  private generation = 0;
  private listener: ((s: SpeakerState) => void) | null = null;

  /** Who hears "speaking" / "idle" (the HUD while it is mounted). */
  onChange(cb: ((s: SpeakerState) => void) | null) {
    this.listener = cb;
  }

  private onState(s: SpeakerState) {
    this.listener?.(s);
  }

  /** Must run inside a user gesture once (the unlock click) so audio may play. */
  prime() {
    if (this.ctx) return;
    try {
      this.ctx = new AudioContext();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.connect(this.ctx.destination);
      void this.ctx.resume();
    } catch {
      this.ctx = null;
    }
  }

  get speaking(): boolean {
    return this.busy;
  }

  /** 0..1 loudness of what is playing now. */
  level(): number {
    if (!this.analyser || !this.busy) return 0;
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
    if (this.current) {
      this.current.pause();
      this.current.src = "";
      this.current = null;
    }
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
      if (blob) await this.play(blob, gen);
      else await this.speakLocally(item.text);
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

  private play(blob: Blob, gen: number): Promise<void> {
    return new Promise((resolve) => {
      if (gen !== this.generation) return resolve();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      this.current = audio;
      if (this.ctx && this.analyser) {
        try {
          this.ctx.createMediaElementSource(audio).connect(this.analyser);
        } catch {
          /* already connected or unsupported: play without the meter */
        }
      }
      const done = () => {
        URL.revokeObjectURL(url);
        if (this.current === audio) this.current = null;
        resolve();
      };
      audio.onended = done;
      audio.onerror = done;
      audio.play().catch(done);
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
