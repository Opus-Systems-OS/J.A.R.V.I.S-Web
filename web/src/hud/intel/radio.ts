// An equalizer for an airport's ATC. LiveATC doesn't allow re-streaming,
// so the HUD never fetches its audio: you open LiveATC in its own tab and
// share that tab here (the browser's screen-share prompt, with "share tab
// audio" ticked). The shared audio goes only into an analyser, never to
// the speakers, so nothing plays twice and the HUD itself stays silent.
// Chrome, Edge and Arc share a tab's audio; Safari and Firefox don't.

/** `n` bar heights (0–1) from an analyser's frequency bins: log-spaced over
 * the lower half of the spectrum, where speech sits, each the loudest bin
 * in its band. */
export function bars(freq: Uint8Array, n: number): number[] {
  const top = Math.max(2, Math.floor(freq.length / 2));
  const out: number[] = [];
  let next = 1; // bin 0 is DC
  for (let i = 0; i < n; i++) {
    // Each band starts where the last ended, so low bars don't repeat a bin.
    const a = Math.max(next, Math.floor(top ** (i / n)));
    const b = Math.max(a + 1, Math.floor(top ** ((i + 1) / n)));
    next = b;
    let m = 0;
    for (let j = a; j < b && j < freq.length; j++) m = Math.max(m, freq[j]);
    out.push(m / 255);
  }
  return out;
}

/** Reads a shared tab's sound. Made inside the click, so its audio context
 * is allowed to run; `listen` then asks for the tab. */
export class TabMeter {
  private readonly ctx = new AudioContext();
  private readonly analyser = this.ctx.createAnalyser();
  private readonly freq: Uint8Array<ArrayBuffer>;
  private stream: MediaStream | null = null;

  constructor() {
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.7;
    this.freq = new Uint8Array(this.analyser.frequencyBinCount);
    void this.ctx.resume();
  }

  /** Ask to share a tab with its audio; `onEnd` runs when sharing stops
   * (the browser's "Stop sharing", or the tab closing). */
  async listen(onEnd: () => void): Promise<void> {
    const md = navigator.mediaDevices;
    if (!md?.getDisplayMedia) throw new Error("This browser can't share a tab. Use Chrome, Edge or Arc.");
    const stream = await md.getDisplayMedia({
      video: true, // required to ask; the picture is never used
      audio: true,
      selfBrowserSurface: "exclude",
      systemAudio: "exclude",
      preferCurrentTab: false,
    } as DisplayMediaStreamOptions);
    stream.getVideoTracks().forEach((t) => (t.enabled = false));
    const audio = stream.getAudioTracks();
    if (!audio.length) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error("No sound came with it. Pick the LiveATC tab and tick “Also share tab audio” (Chrome, Edge or Arc).");
    }
    this.stream = stream;
    audio[0].addEventListener("ended", onEnd);
    // Into the analyser only: never to ctx.destination.
    this.ctx.createMediaStreamSource(stream).connect(this.analyser);
  }

  get live(): boolean {
    return !!this.stream?.getAudioTracks().some((t) => t.readyState === "live");
  }

  read(n: number): number[] {
    this.analyser.getByteFrequencyData(this.freq);
    return bars(this.freq, n);
  }

  close() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ctx.close();
  }
}
