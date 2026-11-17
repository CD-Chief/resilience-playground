import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { startLoadgen, type TickStats } from './loadgen.js';

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

/** Run the load generator against `url` and return the first `count` ticks. */
function collect(url: string, count: number, timeoutMs = 500): Promise<TickStats[]> {
  return new Promise((resolve) => {
    const ticks: TickStats[] = [];
    const loadgen = startLoadgen({
      url,
      rate: 50,
      timeoutMs,
      tickMs: 400,
      onTick: (stats) => {
        ticks.push(stats);
        if (ticks.length === count) {
          loadgen.stop();
          resolve(ticks);
        }
      },
    });
  });
}

describe('loadgen', () => {
  it('counts successes and versions at roughly the requested rate', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version: 'v1' }));
    });
    const url = await listen(server);
    try {
      const ticks = await collect(url, 2);
      const last = ticks[1]!;
      assert.equal(last.totalFailed, 0);
      // 50 req/s for 0.8s is 40; allow generous slack for timer jitter.
      assert.ok(last.totalOk >= 20 && last.totalOk <= 45, `totalOk=${last.totalOk}`);
      assert.equal(last.versions.v1, last.ok);
      assert.deepEqual(last.errors, {});
    } finally {
      await close(server);
    }
  });

  it('counts non-2xx responses as failures, keyed by status', async () => {
    let n = 0;
    const server = createServer((_req, res) => {
      n += 1;
      res.writeHead(n % 2 === 0 ? 503 : 200);
      res.end('{}');
    });
    const url = await listen(server);
    try {
      const [tick] = await collect(url, 1);
      assert.ok(tick!.ok > 0);
      assert.ok(tick!.failed > 0);
      assert.equal(tick!.errors['503'], tick!.failed);
    } finally {
      await close(server);
    }
  });

  it('counts connection errors as failures', async () => {
    const server = createServer();
    const url = await listen(server);
    await close(server);

    const [tick] = await collect(url, 1);
    assert.equal(tick!.ok, 0);
    assert.ok(tick!.failed > 0);
    assert.equal(tick!.errors.ECONNREFUSED, tick!.failed);
  });

  it('counts slow responses as timeouts and keeps sending', async () => {
    const server = createServer(() => {
      // Never respond.
    });
    const url = await listen(server);
    try {
      const ticks = await collect(url, 2, 100);
      const last = ticks[1]!;
      assert.equal(last.totalOk, 0);
      assert.ok(last.totalFailed >= 10, `totalFailed=${last.totalFailed}`);
      assert.equal(last.errors.timeout, last.failed);
    } finally {
      await close(server);
    }
  });
});
