// Cloud ears: speech recognition for browsers without a speech service of
// their own (Arc, Brave, Vivaldi, Safari, Firefox). The page listens to the
// microphone itself, cuts it into utterances with a simple energy detector,
// encodes each as 16 kHz mono WAV and posts it to /bff/v1/voice/transcribe
// (Fish Audio speech-to-text, key on the droplet). WAV rather than
// MediaRecorder's WebM: Fish cannot decode WebM (verified 2026-09-23).
//
// Only speech leaves the page — silence is never sent — and what is sent is
// transcribed and discarded; the wake-word gate in listener.ts decides
// whether any of it becomes a turn.

import { ApiError, postAudio } from "../api";

export const TARGET_RATE = 16_000;

// ---- pure pieces (unit-tested) ---------------------------------------------

/** Linear-interpolation resample of mono samples. */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const f = x - i0;
    out[i] = input[i0] * (1 - f) + input[i1] * f;
  }
  return out;
}

/** 16-bit PCM WAV, mono. */
export function encodeWav(samples: Float32Array, rate: number): ArrayBuffer {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true); // PCM chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

export function rms(frame: Float32Array): number {
  let sum = 0;
  for (const x of frame) sum += x * x;
  return Math.sqrt(sum / (frame.length || 1));
}

export interface SegmenterOptions {
  frameMs: number;
  /** Speech this long above threshold starts an utterance. */
  startMs: number;
  /** Silence this long ends it. */
  hangMs: number;
  /** Kept from before the start, so the first syllable isn't clipped. */
  prerollMs: number;
  /** Shorter utterances are dropped (a cough, a door). */
  minMs: number;
  /** Longer ones are cut and sent as they are. */
  maxMs: number;
  /** Absolute floor for the threshold, whatever the noise floor. */
  minThreshold: number;
}

export const DEFAULTS: SegmenterOptions = {
  frameMs: 20,
  startMs: 100,
  hangMs: 750,
  prerollMs: 300,
  minMs: 400,
  maxMs: 15_000,
  minThreshold: 0.012,
};

/**
 * Energy-based utterance detector over fixed-size frames. The threshold
 * tracks the room: three times a slowly-adapting noise floor, never below
 * `minThreshold`. `push` returns a finished utterance (all its frames,
 * pre-roll included) when one ends, else null.
 */
export class Segmenter {
  private floor = 0.004;
  private above = 0;
  private below = 0;
  /** Loud frames in the current utterance: what counts as speech. */
  private voiced = 0;
  private active = false;
  private frames: Float32Array[] = [];
  private readonly preroll: Float32Array[] = [];
  private readonly o: SegmenterOptions;

  constructor(opts: Partial<SegmenterOptions> = {}) {
    this.o = { ...DEFAULTS, ...opts };
  }

  get speaking(): boolean {
    return this.active;
  }

  reset() {
    this.active = false;
    this.frames = [];
    this.preroll.length = 0;
    this.above = this.below = this.voiced = 0;
  }

  push(frame: Float32Array): Float32Array[] | null {
    const level = rms(frame);
    const threshold = Math.max(this.floor * 3, this.o.minThreshold);
    const loud = level > threshold;
    const f = this.o.frameMs;

    if (!this.active) {
      // Learn the room only from quiet frames: fast down, slow up.
      if (!loud) this.floor = level < this.floor ? this.floor * 0.9 + level * 0.1 : this.floor * 0.995 + level * 0.005;
      this.preroll.push(frame);
      if (this.preroll.length > this.o.prerollMs / f) this.preroll.shift();
      this.above = loud ? this.above + 1 : 0;
      if (this.above * f >= this.o.startMs) {
        this.active = true;
        this.frames = [...this.preroll];
        this.preroll.length = 0;
        this.below = 0;
        this.voiced = this.above;
      }
      return null;
    }

    this.frames.push(frame);
    this.below = loud ? 0 : this.below + 1;
    if (loud) this.voiced += 1;
    const length = this.frames.length * f;
    if (this.below * f >= this.o.hangMs || length >= this.o.maxMs) {
      const done = this.frames;
      const spoken = this.voiced * f;
      this.reset();
      return spoken >= this.o.minMs ? done : null;
    }
    return null;
  }
}

export function concat(frames: Float32Array[]): Float32Array {
  const n = frames.reduce((a, f) => a + f.length, 0);
  const out = new Float32Array(n);
  let o = 0;
  for (const f of frames) {
    out.set(f, o);
    o += f.length;
  }
  return out;
}

// ---- the engine ------------------------------------------------------------

export interface EarsEvents {
  /** An utterance's text (may be empty). */
  final(text: string): void;
  /** Speech detected / ended — for the caption, before the text is back. */
  hearing(active: boolean): void;
  failed(reason: "denied" | "unavailable"): void;
  started(): void;
}

export class CloudEars {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private readonly seg = new Segmenter();
  private paused = false;
  private failures = 0;

  constructor(private readonly ev: EarsEvents) {}

  static supported(): boolean {
    return !!navigator.mediaDevices?.getUserMedia && typeof AudioWorkletNode !== "undefined";
  }

  async start() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
    } catch (e) {
      const name = e instanceof DOMException ? e.name : "";
      this.ev.failed(name === "NotAllowedError" || name === "SecurityError" ? "denied" : "unavailable");
      return;
    }
    try {
      this.ctx = new AudioContext();
      if (this.ctx.state === "suspended") await this.ctx.resume();
      await this.ctx.audioWorklet.addModule("/capture-worklet.js");
      const src = this.ctx.createMediaStreamSource(this.stream);
      this.node = new AudioWorkletNode(this.ctx, "jarvis-capture");
      const rate = this.ctx.sampleRate;
      this.node.port.onmessage = (m: MessageEvent<Float32Array>) => this.onFrame(m.data, rate);
      // Chrome only runs nodes that reach the destination; a zero gain
      // keeps the graph alive without playing the mic back.
      const mute = this.ctx.createGain();
      mute.gain.value = 0;
      src.connect(this.node);
      this.node.connect(mute);
      mute.connect(this.ctx.destination);
      this.ev.started();
    } catch {
      this.stop();
      this.ev.failed("unavailable");
    }
  }

  pause() {
    this.paused = true;
    this.seg.reset();
    this.ev.hearing(false);
  }

  resume() {
    this.paused = false;
  }

  stop() {
    this.node?.disconnect();
    this.node = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }

  private wasSpeaking = false;

  private onFrame(frame: Float32Array, rate: number) {
    if (this.paused) return;
    const utterance = this.seg.push(frame);
    if (this.seg.speaking !== this.wasSpeaking) {
      this.wasSpeaking = this.seg.speaking;
      this.ev.hearing(this.seg.speaking);
    }
    if (utterance) void this.send(concat(utterance), rate);
  }

  private async send(samples: Float32Array, rate: number) {
    const wav = encodeWav(resample(samples, rate, TARGET_RATE), TARGET_RATE);
    try {
      const out = await postAudio<{ text?: string }>("voice/transcribe?language=en", wav, "audio/wav");
      this.failures = 0;
      this.ev.final((out.text ?? "").trim());
    } catch (e) {
      // A bad utterance (400) is just dropped; the service failing
      // repeatedly means the ears are down.
      if (e instanceof ApiError && e.status === 400) return;
      this.failures += 1;
      if (this.failures >= 3) {
        this.stop();
        this.ev.failed("unavailable");
      }
    }
  }
}
