import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { createApp, type App, type Config } from './app.js';
import { setSilent } from './log.js';

setSilent(true);

interface Running {
  app: App;
  mainUrl: string;
  adminUrl: string;
  exits: number[];
  stop: () => Promise<void>;
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

async function start(overrides: Partial<Config> = {}): Promise<Running> {
  const exits: number[] = [];
  const app = createApp({
    version: 'test',
    podName: 'pod-a',
    broken: false,
    startupDelayMs: 0,
    exit: (code) => exits.push(code),
    ...overrides,
  });
  const [mainUrl, adminUrl] = await Promise.all([listen(app.main), listen(app.admin)]);
  return {
    app,
    mainUrl,
    adminUrl,
    exits,
    stop: async () => {
      await Promise.all([close(app.main), close(app.admin)]);
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('healthy app', () => {
  let t: Running;
  before(async () => {
    t = await start();
  });
  after(() => t.stop());

  it('passes all three probes', async () => {
    for (const path of ['/healthz', '/readyz', '/startupz']) {
      const res = await fetch(t.mainUrl + path);
      assert.equal(res.status, 200, path);
    }
  });

  it('does work and reports pod and version', async () => {
    const res = await fetch(`${t.mainUrl}/api/work`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.equal(body.pod, 'pod-a');
    assert.equal(body.version, 'test');
    assert.match(String(body.result), /^[0-9a-f]{12}$/);
  });

  it('does not serve admin routes on the public port', async () => {
    const res = await fetch(`${t.mainUrl}/admin/crash`, { method: 'POST' });
    assert.notEqual(res.status, 202);
    assert.deepEqual(t.exits, []);
  });

  it('returns 404 for unknown paths', async () => {
    assert.equal((await fetch(`${t.mainUrl}/nope`)).status, 404);
    assert.equal((await fetch(`${t.adminUrl}/admin/nope`, { method: 'POST' })).status, 404);
  });

  it('rejects GET on admin routes', async () => {
    assert.equal((await fetch(`${t.adminUrl}/admin/crash`)).status, 405);
    assert.deepEqual(t.exits, []);
  });
});

describe('unready fault', () => {
  let t: Running;
  before(async () => {
    t = await start();
  });
  after(() => t.stop());

  it('rejects invalid durations', async () => {
    for (const seconds of ['0', '-5', '1.5', 'abc', '301', '']) {
      const res = await fetch(`${t.adminUrl}/admin/unready?seconds=${seconds}`, { method: 'POST' });
      assert.equal(res.status, 400, `seconds=${seconds}`);
    }
    assert.equal((await fetch(`${t.mainUrl}/readyz`)).status, 200);
  });

  it('fails readiness for the requested time, then recovers', async () => {
    const res = await fetch(`${t.adminUrl}/admin/unready?seconds=1`, { method: 'POST' });
    assert.equal(res.status, 202);

    const notReady = await fetch(`${t.mainUrl}/readyz`);
    assert.equal(notReady.status, 503);
    assert.equal(((await notReady.json()) as { reason: string }).reason, 'fault: unready');

    // Liveness and traffic handling are unaffected: only readiness flips.
    assert.equal((await fetch(`${t.mainUrl}/healthz`)).status, 200);
    assert.equal((await fetch(`${t.mainUrl}/api/work`)).status, 200);

    await sleep(1100);
    assert.equal((await fetch(`${t.mainUrl}/readyz`)).status, 200);
  });

  it('defaults to 45 seconds', async () => {
    const res = await fetch(`${t.adminUrl}/admin/unready`, { method: 'POST' });
    assert.equal(res.status, 202);
    assert.equal(((await res.json()) as { seconds: number }).seconds, 45);
  });
});

describe('crash fault', () => {
  it('acknowledges, then exits with a non-zero code', async () => {
    const t = await start();
    try {
      const res = await fetch(`${t.adminUrl}/admin/crash`, { method: 'POST' });
      assert.equal(res.status, 202);
      await sleep(200);
      assert.deepEqual(t.exits, [1]);
    } finally {
      await t.stop();
    }
  });
});

describe('broken build', () => {
  it('never becomes ready but stays alive', async () => {
    const t = await start({ broken: true });
    try {
      assert.equal((await fetch(`${t.mainUrl}/readyz`)).status, 503);
      assert.equal((await fetch(`${t.mainUrl}/healthz`)).status, 200);
      assert.equal((await fetch(`${t.mainUrl}/startupz`)).status, 200);
    } finally {
      await t.stop();
    }
  });
});

describe('startup and shutdown', () => {
  it('fails startup and readiness until the startup delay has passed', async () => {
    const t = await start({ startupDelayMs: 300 });
    try {
      assert.equal((await fetch(`${t.mainUrl}/startupz`)).status, 503);
      assert.equal((await fetch(`${t.mainUrl}/readyz`)).status, 503);
      await sleep(350);
      assert.equal((await fetch(`${t.mainUrl}/startupz`)).status, 200);
      assert.equal((await fetch(`${t.mainUrl}/readyz`)).status, 200);
    } finally {
      await t.stop();
    }
  });

  it('fails readiness once shutdown begins', async () => {
    const t = await start();
    try {
      t.app.beginShutdown();
      assert.equal((await fetch(`${t.mainUrl}/readyz`)).status, 503);
      assert.equal((await fetch(`${t.mainUrl}/api/work`)).status, 200);
    } finally {
      await t.stop();
    }
  });
});
