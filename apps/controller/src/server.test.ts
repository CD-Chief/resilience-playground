import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import type { Incident, Snapshot } from './types.js';
import { RateLimiter } from './ratelimit.js';
import { createApi, type Api, type ServerDeps } from './server.js';

const incident = { id: 'i1', fault: 'crash-pod' } as unknown as Incident;

async function listening(overrides: Partial<ServerDeps> = {}): Promise<{ api: Api; base: string }> {
  const api = createApi({
    snapshot: () => ({}) as Snapshot,
    backlog: () => [],
    metrics: () => null,
    inject: async () => ({ ok: true, incident }),
    onWatchersChanged: () => {},
    limiter: new RateLimiter([{ windowMs: 60000, max: 4 }]),
    clientIpHeader: '',
    maxStreamsPerIp: 6,
    maxStreamsTotal: 1000,
    ...overrides,
  });
  await new Promise<void>((resolve) => api.server.listen(0, '127.0.0.1', resolve));
  return { api, base: `http://127.0.0.1:${(api.server.address() as AddressInfo).port}` };
}

function post(base: string, name: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/api/faults/${name}`, { method: 'POST', headers });
}

function stop(api: Api): void {
  api.close();
  api.server.closeAllConnections();
}

describe('fault rate limit', () => {
  it('refuses the 5th request in a minute with Retry-After', async () => {
    const { api, base } = await listening();
    try {
      for (let i = 0; i < 4; i++) assert.equal((await post(base, 'crash-pod')).status, 202);
      const res = await post(base, 'crash-pod');
      assert.equal(res.status, 429);
      assert.ok(Number(res.headers.get('retry-after')) >= 1);
      const body = (await res.json()) as { error: string; retryAfterSeconds: number };
      assert.match(body.error, /^Too many fault requests from your connection\. Try again in \d+s\.$/);
      assert.ok(body.retryAfterSeconds >= 1);
    } finally {
      stop(api);
    }
  });

  it('counts unknown fault names too', async () => {
    const { api, base } = await listening({ limiter: new RateLimiter([{ windowMs: 60000, max: 1 }]) });
    try {
      assert.equal((await post(base, 'nope')).status, 404);
      assert.equal((await post(base, 'nope')).status, 429);
    } finally {
      stop(api);
    }
  });

  it('limits cf-connecting-ip values separately when the header is configured', async () => {
    const { api, base } = await listening({
      clientIpHeader: 'cf-connecting-ip',
      limiter: new RateLimiter([{ windowMs: 60000, max: 1 }]),
    });
    try {
      assert.equal((await post(base, 'crash-pod', { 'cf-connecting-ip': '203.0.113.1' })).status, 202);
      assert.equal((await post(base, 'crash-pod', { 'cf-connecting-ip': '203.0.113.1' })).status, 429);
      assert.equal((await post(base, 'crash-pod', { 'cf-connecting-ip': '203.0.113.2' })).status, 202);
    } finally {
      stop(api);
    }
  });

  it('ignores the header when the setting is empty', async () => {
    const { api, base } = await listening({ limiter: new RateLimiter([{ windowMs: 60000, max: 1 }]) });
    try {
      assert.equal((await post(base, 'crash-pod', { 'cf-connecting-ip': '203.0.113.1' })).status, 202);
      assert.equal((await post(base, 'crash-pod', { 'cf-connecting-ip': '203.0.113.2' })).status, 429);
    } finally {
      stop(api);
    }
  });
});

describe('stream caps', () => {
  it('refuses the 7th stream from one client and frees a slot on disconnect', async () => {
    const { api, base } = await listening();
    const controllers: AbortController[] = [];
    const open = async (): Promise<Response> => {
      const ac = new AbortController();
      controllers.push(ac);
      return fetch(`${base}/api/stream`, { signal: ac.signal });
    };
    try {
      for (let i = 0; i < 6; i++) assert.equal((await open()).status, 200);
      const refused = await open();
      assert.equal(refused.status, 429);
      assert.deepEqual(await refused.json(), { error: 'Too many open live views from your connection.' });

      controllers[0]!.abort();
      for (let i = 0; i < 100 && api.watchers() > 5; i++) await new Promise((r) => setTimeout(r, 10));
      assert.equal(api.watchers(), 5);
      assert.equal((await open()).status, 200);
    } finally {
      for (const ac of controllers) ac.abort();
      stop(api);
    }
  });

  it('answers 503 when the total cap is reached', async () => {
    const { api, base } = await listening({ maxStreamsTotal: 1, clientIpHeader: 'cf-connecting-ip' });
    const ac = new AbortController();
    try {
      const first = await fetch(`${base}/api/stream`, {
        signal: ac.signal,
        headers: { 'cf-connecting-ip': '203.0.113.1' },
      });
      assert.equal(first.status, 200);
      const res = await fetch(`${base}/api/stream`, { headers: { 'cf-connecting-ip': '203.0.113.2' } });
      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), { error: 'The playground is full right now. Try again in a minute.' });
    } finally {
      ac.abort();
      stop(api);
    }
  });
});
