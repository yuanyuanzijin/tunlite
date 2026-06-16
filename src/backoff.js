'use strict';

// Exponential backoff with jitter and reset-on-stable.
//
//   delay(attempt) = min(capMs, baseMs * factor^attempt) ± jitter
//
// `attempt` starts at 0. Callers increment on each failure and call reset()
// once a connection has stayed up long enough to be considered stable.

const DEFAULTS = {
  baseMs: 1000,
  capMs: 60000,
  factor: 2,
  jitter: 0.2, // fraction of the computed delay, applied as ±jitter
  resetAfterMs: 60000,
};

class Backoff {
  constructor(opts = {}, rng = Math.random) {
    this.opts = { ...DEFAULTS, ...opts };
    this.attempt = 0;
    this.rng = rng;
  }

  // Deterministic base delay (no jitter), exposed for testing/inspection.
  baseDelay(attempt = this.attempt) {
    const { baseMs, capMs, factor } = this.opts;
    const raw = baseMs * Math.pow(factor, attempt);
    return Math.min(capMs, raw);
  }

  // Next delay in ms, then advances the attempt counter.
  next() {
    const base = this.baseDelay(this.attempt);
    const { jitter } = this.opts;
    let delay = base;
    if (jitter > 0) {
      const span = base * jitter;
      // rng in [0,1) -> [-span, +span)
      delay = base + (this.rng() * 2 - 1) * span;
    }
    this.attempt += 1;
    return Math.max(0, Math.round(delay));
  }

  reset() {
    this.attempt = 0;
  }
}

module.exports = { Backoff, DEFAULTS };
