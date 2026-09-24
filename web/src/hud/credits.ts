// What is left to spend, as jarvis-web's `/web/credits` reports it, and the
// sentence Jarvis says about it. The Anthropic figure is a ledger (the
// balance you typed after a top-up, minus fleet spend since), so it is
// always spoken as "about". `CreditWatch` polls it and speaks only when a
// balance *crosses* into trouble — never the same warning twice in a row.

import { webGet } from "../api";

export interface Credits {
  anthropic: {
    anchor_cents: number | null;
    anchored_at: string | null;
    spent_since_cents: number | null;
    remaining_cents: number | null;
    warn_below_cents: number;
    low: boolean;
    exhausted: boolean;
    billing_error_at: string | null;
    estimate: boolean;
    error: string | null;
  };
  fish: {
    credit_usd: string | null;
    warn_below_cents: number;
    low: boolean;
    error: string | null;
  };
}

export type Level = "ok" | "low" | "exhausted";

export const dollars = (cents: number) => `${cents < 0 ? "−" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;

/** "$12.34" from Fish's "12.34"; the raw string if it isn't a number. */
export const fishDollars = (usd: string) => {
  const v = Number(usd);
  return Number.isFinite(v) ? `$${v.toFixed(2)}` : usd;
};

/** The worst of the two balances. */
export function level(c: Credits): Level {
  if (c.anthropic.exhausted) return "exhausted";
  if (c.anthropic.low || c.fish.low) return "low";
  return "ok";
}

/** What Jarvis says (and the banner shows), or `null` when all is well. */
export function creditLine(c: Credits): string | null {
  const parts: string[] = [];
  const a = c.anthropic;
  if (a.exhausted) {
    parts.push("The Anthropic account is out of credit, sir; I can't think until it's topped up.");
  } else if (a.low && a.remaining_cents !== null) {
    parts.push(
      a.remaining_cents <= 0
        ? "A word of warning, sir: by my ledger the Anthropic balance is spent."
        : `A word of warning, sir: the Anthropic balance is down to about ${dollars(a.remaining_cents)}.`,
    );
  }
  if (c.fish.low && c.fish.credit_usd !== null) {
    parts.push(`Voice credit is running low: ${fishDollars(c.fish.credit_usd)} left.`);
  }
  return parts.length ? parts.join(" ") : null;
}

export interface WatchEvents {
  /** Every successful read. */
  onCredits(c: Credits): void;
  /** A balance just got worse: say this. */
  onWarn(line: string): void;
}

/** Severity per balance, so a second balance going low still warns. */
const severity = (c: Credits) => ({
  anthropic: c.anthropic.exhausted ? 2 : c.anthropic.low ? 1 : 0,
  fish: c.fish.low ? 1 : 0,
});

export const POLL_MS = 5 * 60_000;

/**
 * Polls `/web/credits`. The first read only sets the baseline (the greeting
 * already spoke it); after that, `onWarn` fires when either balance gets
 * worse, and re-arms once it recovers.
 */
export class CreditWatch {
  private last: { anthropic: number; fish: number } | null = null;
  private timer: number | undefined;

  constructor(
    private readonly ev: WatchEvents,
    private readonly read: () => Promise<Credits> = () => webGet<Credits>("credits"),
  ) {}

  start(ms = POLL_MS) {
    void this.poll();
    this.timer = window.setInterval(() => void this.poll(), ms);
  }

  stop() {
    window.clearInterval(this.timer);
  }

  /** Feed a reading taken elsewhere (after you set the balance). */
  observe(c: Credits) {
    this.ev.onCredits(c);
    const now = severity(c);
    const before = this.last;
    this.last = now;
    if (!before) return;
    if (now.anthropic > before.anthropic || now.fish > before.fish) {
      const line = creditLine(c);
      if (line) this.ev.onWarn(line);
    }
  }

  /** Something outside the poll saw a billing error (Jarvis's own session). */
  markExhausted() {
    if (this.last) this.last = { ...this.last, anthropic: 2 };
  }

  async poll() {
    try {
      this.observe(await this.read());
    } catch {
      /* the panel shows its last reading; next poll tries again */
    }
  }
}
