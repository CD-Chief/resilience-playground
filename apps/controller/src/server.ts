import { createServer, type Server, type ServerResponse } from 'node:http';
import { clientIp } from './clientip.js';
import type { InjectResult } from './faults.js';
import { log } from './log.js';
import { clientKey, type RateLimiter } from './ratelimit.js';
import { isFaultId, type FaultId, type LogEntry, type MetricsView, type Snapshot } from './types.js';

export interface ServerDeps {
  snapshot: () => Snapshot;
  backlog: () => LogEntry[];
  /** The latest graphs, or null while there are none. */
  metrics: () => MetricsView | null;
  inject: (fault: FaultId) => Promise<InjectResult>;
  /** Called when a browser connects to or leaves the stream. */
  onWatchersChanged: () => void;
  /** Counts fault requests per client. */
  limiter: RateLimiter;
  /** Lower-case header holding the client address; empty uses the socket address. */
  clientIpHeader: string;
  maxStreamsPerIp: number;
  maxStreamsTotal: number;
}

export interface Api {
  server: Server;
  watchers: () => number;
  broadcast: (event: 'state' | 'log' | 'metrics', data: unknown) => void;
  close: () => void;
}

const HEARTBEAT_MS = 15000;
const REFUSAL_LOG_MS = 60000;
const FAULT_ROUTE = /^\/api\/faults\/([a-z-]+)$/;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function createApi(deps: ServerDeps): Api {
  const clients = new Set<ServerResponse>();
  /** Open streams per client key. */
  const streamsByKey = new Map<string, number>();
  /** When a refusal was last logged per client key, so a flood logs once a minute. */
  const lastRefusalLog = new Map<string, number>();

  // Keys are never logged or returned; only the route is.
  function logRefusal(key: string, route: string): void {
    const now = Date.now();
    if (now - (lastRefusalLog.get(key) ?? 0) < REFUSAL_LOG_MS) return;
    lastRefusalLog.set(key, now);
    if (lastRefusalLog.size > 1000) {
      for (const [k, t] of lastRefusalLog) if (now - t >= REFUSAL_LOG_MS) lastRefusalLog.delete(k);
    }
    log('info', 'rate limited', { route });
  }

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;

    if (req.method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    if (req.method === 'GET' && path === '/api/state') {
      sendJson(res, 200, deps.snapshot());
      return;
    }

    if (req.method === 'GET' && path === '/api/stream') {
      const key = clientKey(clientIp(req, deps.clientIpHeader));
      if ((streamsByKey.get(key) ?? 0) >= deps.maxStreamsPerIp) {
        logRefusal(key, '/api/stream');
        sendJson(res, 429, { error: 'Too many open live views from your connection.' });
        return;
      }
      if (clients.size >= deps.maxStreamsTotal) {
        logRefusal(key, '/api/stream');
        sendJson(res, 503, { error: 'The playground is full right now. Try again in a minute.' });
        return;
      }
      streamsByKey.set(key, (streamsByKey.get(key) ?? 0) + 1);
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // Tells reverse proxies not to buffer the stream.
        'x-accel-buffering': 'no',
      });
      clients.add(res);
      res.write('retry: 2000\n\n');
      res.write(frame('backlog', deps.backlog()));
      res.write(frame('state', deps.snapshot()));
      const metrics = deps.metrics();
      if (metrics) res.write(frame('metrics', metrics));
      deps.onWatchersChanged();
      res.on('close', () => {
        clients.delete(res);
        const open = (streamsByKey.get(key) ?? 1) - 1;
        if (open <= 0) streamsByKey.delete(key);
        else streamsByKey.set(key, open);
        deps.onWatchersChanged();
      });
      return;
    }

    // The fault name is matched against a fixed list. No body is read and no
    // other input is accepted.
    const fault = FAULT_ROUTE.exec(path)?.[1];
    if (fault !== undefined) {
      if (req.method === 'POST') {
        const key = clientKey(clientIp(req, deps.clientIpHeader));
        const verdict = deps.limiter.hit(key);
        if (!verdict.ok) {
          req.resume();
          logRefusal(key, '/api/faults');
          sendJson(
            res,
            429,
            {
              error: `Too many fault requests from your connection. Try again in ${verdict.retryAfterSeconds}s.`,
              retryAfterSeconds: verdict.retryAfterSeconds,
            },
            { 'retry-after': String(verdict.retryAfterSeconds) },
          );
          return;
        }
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'Use POST.' }, { allow: 'POST' });
        return;
      }
      req.resume();
      if (!isFaultId(fault)) {
        sendJson(res, 404, { error: 'Unknown fault.' });
        return;
      }
      void deps.inject(fault).then((result) => {
        if (result.ok) {
          sendJson(res, 202, { incident: result.incident });
          return;
        }
        const headers: Record<string, string> = {};
        if (result.retryAfterSeconds !== undefined) headers['retry-after'] = String(result.retryAfterSeconds);
        sendJson(res, result.status, { error: result.error, retryAfterSeconds: result.retryAfterSeconds }, headers);
      });
      return;
    }

    sendJson(res, 404, { error: 'Not found.' });
  });

  const heartbeat = setInterval(() => {
    for (const client of clients) client.write(': keep-alive\n\n');
  }, HEARTBEAT_MS);
  heartbeat.unref();

  return {
    server,
    watchers: () => clients.size,
    broadcast: (event, data) => {
      if (clients.size === 0) return;
      const payload = frame(event, data);
      for (const client of clients) client.write(payload);
    },
    close: () => {
      clearInterval(heartbeat);
      for (const client of clients) client.end();
      server.close();
    },
  };
}
