// Hidden Queen Chess — Phase 5 abuse hardening: shared rate-limiting
// building blocks. Deliberately simple (spec section 14: "a simple token
// bucket is enough") — a fixed-window counter per key, not a precise
// sliding window. Good enough to stop a flood/script, not meant to be
// billing-grade accurate.

function createRateLimiter({ windowMs, max }) {
  /** @type {Map<string, {count:number, windowStart:number}>} */
  const hits = new Map();

  // Periodic sweep so one-off keys (a socket that connected once and left)
  // don't accumulate forever — irrelevant at this project's scale, but
  // cheap insurance.
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits.entries()) {
      if (now - entry.windowStart > windowMs) hits.delete(key);
    }
  }, Math.max(windowMs, 60000)).unref();

  // Returns true if this call is allowed (and records it), false if the
  // key is currently over the limit.
  return function check(key) {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now - entry.windowStart > windowMs) {
      hits.set(key, { count: 1, windowStart: now });
      return true;
    }
    entry.count++;
    return entry.count <= max;
  };
}

module.exports = { createRateLimiter };
