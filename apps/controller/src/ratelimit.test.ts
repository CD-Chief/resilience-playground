import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clientKey, RateLimiter } from './ratelimit.js';

function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => void (t += ms) };
}

describe('RateLimiter', () => {
  it('allows up to max, then refuses with the time until a slot frees', () => {
    const c = clock();
    const limiter = new RateLimiter([{ windowMs: 60000, max: 2 }], c.now);
    assert.deepEqual(limiter.hit('a'), { ok: true });
    c.advance(10000);
    assert.deepEqual(limiter.hit('a'), { ok: true });
    c.advance(5000);
    assert.deepEqual(limiter.hit('a'), { ok: false, retryAfterSeconds: 45 });
  });

  it('allows again after the window', () => {
    const c = clock();
    const limiter = new RateLimiter([{ windowMs: 60000, max: 1 }], c.now);
    limiter.hit('a');
    assert.equal(limiter.hit('a').ok, false);
    c.advance(60000);
    assert.deepEqual(limiter.hit('a'), { ok: true });
  });

  it('rounds the retry time up and never returns less than 1', () => {
    const c = clock();
    const limiter = new RateLimiter([{ windowMs: 1000, max: 1 }], c.now);
    limiter.hit('a');
    c.advance(600);
    assert.deepEqual(limiter.hit('a'), { ok: false, retryAfterSeconds: 1 });
  });

  it('keeps keys separate', () => {
    const limiter = new RateLimiter([{ windowMs: 60000, max: 1 }]);
    assert.equal(limiter.hit('a').ok, true);
    assert.equal(limiter.hit('b').ok, true);
    assert.equal(limiter.hit('a').ok, false);
  });

  it('applies the per-hour rule after the per-minute rule has reset', () => {
    const c = clock();
    const limiter = new RateLimiter(
      [
        { windowMs: 60000, max: 2 },
        { windowMs: 3600000, max: 3 },
      ],
      c.now,
    );
    assert.equal(limiter.hit('a').ok, true);
    assert.equal(limiter.hit('a').ok, true);
    assert.deepEqual(limiter.hit('a'), { ok: false, retryAfterSeconds: 60 });
    c.advance(60000);
    assert.equal(limiter.hit('a').ok, true);
    c.advance(60000);
    // The minute window is clear, but three attempts are inside the hour.
    assert.deepEqual(limiter.hit('a'), { ok: false, retryAfterSeconds: 3600 - 120 });
  });

  it('does not record refused attempts', () => {
    const c = clock();
    const limiter = new RateLimiter([{ windowMs: 60000, max: 1 }], c.now);
    limiter.hit('a');
    c.advance(30000);
    for (let i = 0; i < 5; i++) assert.equal(limiter.hit('a').ok, false);
    c.advance(30000);
    assert.equal(limiter.hit('a').ok, true);
  });

  it('prune drops idle keys', () => {
    const c = clock();
    const limiter = new RateLimiter([{ windowMs: 60000, max: 2 }], c.now);
    limiter.hit('old');
    c.advance(61000);
    limiter.hit('fresh');
    assert.equal(limiter.size(), 2);
    limiter.prune();
    assert.equal(limiter.size(), 1);
  });

  it('evicts the stalest key when full', () => {
    const c = clock();
    const limiter = new RateLimiter([{ windowMs: 60000, max: 1 }], c.now, 3);
    for (const key of ['a', 'b', 'c', 'd', 'e']) {
      limiter.hit(key);
      c.advance(1);
      assert.ok(limiter.size() <= 3);
    }
    assert.equal(limiter.size(), 3);
    // "a" was evicted, so it gets a fresh allowance; "e" is still limited.
    assert.equal(limiter.hit('e').ok, false);
    assert.equal(limiter.hit('a').ok, true);
  });
});

describe('clientKey', () => {
  it('returns IPv4 as is', () => {
    assert.equal(clientKey('203.0.113.7'), '203.0.113.7');
  });

  it('maps a full IPv6 address to its /64', () => {
    assert.equal(clientKey('2001:0db8:0001:0002:aaaa:bbbb:cccc:dddd'), '2001:db8:1:2::/64');
  });

  it('expands :: shorthand before taking the prefix', () => {
    assert.equal(clientKey('2001:db8:1:2::1'), '2001:db8:1:2::/64');
    assert.equal(clientKey('2001:db8:1:2::1'), clientKey('2001:db8:1:2:ffff::9'));
    assert.notEqual(clientKey('2001:db8:1:2::1'), clientKey('2001:db8:1:3::1'));
    assert.equal(clientKey('2001:db8::1'), '2001:db8:0:0::/64');
    assert.equal(clientKey('::1'), '0:0:0:0::/64');
  });

  it('maps IPv4-mapped IPv6 to the IPv4 address', () => {
    assert.equal(clientKey('::ffff:1.2.3.4'), '1.2.3.4');
    assert.equal(clientKey('::FFFF:102:304'), '1.2.3.4');
  });

  it('passes unrecognised values through', () => {
    assert.equal(clientKey('unknown'), 'unknown');
  });
});
