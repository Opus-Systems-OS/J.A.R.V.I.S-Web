// One microphone across every open HUD (tabs, Chrome and Arc side by side):
// the server grants a short lease to one of them, this page renews it every
// few seconds, and clicking the orb takes it over deliberately. Without it
// every open HUD heard "Jarvis, …" and each started its own answer.

import { web } from "../api";

const RENEW_MS = 7_000;

export class MicLease {
  readonly id = `hud-${crypto.randomUUID()}`;
  private timer: number | undefined;
  private current = false;
  private listener: ((held: boolean) => void) | null = null;

  get held(): boolean {
    return this.current;
  }

  onChange(cb: ((held: boolean) => void) | null) {
    this.listener = cb;
  }

  /** Claim (or renew); `take` wins it from another HUD. */
  async claim(take = false): Promise<boolean> {
    let held = false;
    try {
      held = (await web<{ held: boolean }>("mic", { client: this.id, take })).held;
    } catch {
      // Can't reach the server: keep whatever we had rather than flapping.
      held = this.current;
    }
    if (held !== this.current) {
      this.current = held;
      this.listener?.(held);
    }
    return held;
  }

  start() {
    void this.claim(false);
    this.timer = window.setInterval(() => void this.claim(false), RENEW_MS);
  }

  stop() {
    window.clearInterval(this.timer);
    if (this.current) void web("mic", { client: this.id, release: true }, true);
    this.current = false;
  }
}
