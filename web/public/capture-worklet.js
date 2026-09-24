// AudioWorklet: hands the microphone's samples (mono, the context's rate) to
// the page in ~20 ms batches. Loaded by src/hud/ears.ts. Plain JS on
// purpose: worklet modules are fetched as-is, outside the bundle.
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(Math.round(sampleRate / 50)); // 20 ms
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf.slice(0));
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("jarvis-capture", Capture);
