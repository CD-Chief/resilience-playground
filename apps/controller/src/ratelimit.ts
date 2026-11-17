export interface Rule {
  windowMs: number;
  max: number;
}

export type Verdict = { ok: true } | { ok: false; retryAfterSeconds: number };

/** Sliding-window limiter keyed by client. Memory is bounded by `maxKeys`. */
export class RateLimiter {
  /** Insertion order is last-attempt order, so the first key is the stalest. */
  private readonly attempts = new Map<string, number[]>();
  private readonly longest: number;
  private readonly keep: number;

  constructor(
    private readonly rules: Rule[],
    private readonly now: () => number = Date.now,
    private readonly maxKeys: number = 10000,
  ) {
    this.longest = Math.max(0, ...rules.map((r) => r.windowMs));
    this.keep = Math.max(1, ...rules.map((r) => r.max));
  }

  /** Records an attempt for `key` and says whether it is allowed. Refused attempts are not recorded. */
  hit(key: string): Verdict {
    const now = this.now();
    const times = (this.attempts.get(key) ?? []).filter((t) => now - t < this.longest);

    let retryAt = 0;
    for (const rule of this.rules) {
      const inWindow = times.filter((t) => now - t < rule.windowMs);
      if (inWindow.length >= rule.max) {
        // The attempt whose departure brings the count back under the limit.
        const blocking = inWindow[inWindow.length - rule.max] ?? now;
        retryAt = Math.max(retryAt, blocking + rule.windowMs);
      }
    }
    if (retryAt > 0) {
      if (times.length > 0) this.attempts.set(key, times);
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((retryAt - now) / 1000)) };
    }

    times.push(now);
    if (times.length > this.keep) times.splice(0, times.length - this.keep);
    // Re-insert so the map stays ordered by last attempt.
    this.attempts.delete(key);
    if (this.attempts.size >= this.maxKeys) {
      const stalest = this.attempts.keys().next().value;
      if (stalest !== undefined) this.attempts.delete(stalest);
    }
    this.attempts.set(key, times);
    return { ok: true };
  }

  /** Drops keys with no attempts inside the longest window. */
  prune(): void {
    const now = this.now();
    for (const [key, times] of this.attempts) {
      if (!times.some((t) => now - t < this.longest)) this.attempts.delete(key);
    }
  }

  size(): number {
    return this.attempts.size;
  }
}

/** IPv4 as-is; IPv6 -> its /64 prefix ("2001:db8:1:2::/64"); IPv4-mapped IPv6 ("::ffff:1.2.3.4") -> "1.2.3.4". */
export function clientKey(ip: string): string {
  const addr = ip.split('%')[0]!.trim().toLowerCase();
  if (!addr.includes(':')) return addr;

  let text = addr;
  const dot = text.lastIndexOf('.');
  if (dot !== -1) {
    const colon = text.lastIndexOf(':');
    const octets = text.slice(colon + 1).split('.').map(Number);
    if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return addr;
    const hex = (hi: number, lo: number): string => (hi * 256 + lo).toString(16);
    text = `${text.slice(0, colon + 1)}${hex(octets[0]!, octets[1]!)}:${hex(octets[2]!, octets[3]!)}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return addr;
  const head = halves[0] === '' ? [] : halves[0]!.split(':');
  const tail = halves.length === 2 && halves[1] !== '' ? halves[1]!.split(':') : [];
  let groups: string[];
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return addr;
    groups = [...head, ...Array<string>(fill).fill('0'), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return addr;

  const nums = groups.map((g) => parseInt(g, 16));
  if (nums.slice(0, 5).every((n) => n === 0) && nums[5] === 0xffff) {
    return `${nums[6]! >> 8}.${nums[6]! & 255}.${nums[7]! >> 8}.${nums[7]! & 255}`;
  }
  const prefix = nums.slice(0, 4).map((n) => n.toString(16));
  return `${prefix.join(':')}::/64`;
}
