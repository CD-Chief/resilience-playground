import { createServer, type Server, type ServerResponse } from 'node:http';
import type { InjectResult } from './faults.js';
import { isFaultId, type FaultId, type LogEntry, type Snapshot } from './types.js';

export interface ServerDeps {
  snapshot: () => Snapshot;
  backlog: () => LogEntry[];
  inject: (fault: FaultId) => Promise<InjectResult>;
  /** Called when a browser connects to or leaves the stream. */
  onWatchersChanged: () => void;
}

export interface Api {
  server: Server;
  watchers: () => number;
  broadcast: (event: 'state' | 'log', data: unknown) => void;
  close: () => void;
}

const HEARTBEAT_MS = 15000;
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
      deps.onWatchersChanged();
      res.on('close', () => {
        clients.delete(res);
        deps.onWatchersChanged();
      });
      return;
    }

    // The fault name is matched against a fixed list. No body is read and no
    // other input is accepted.
    const fault = FAULT_ROUTE.exec(path)?.[1];
    if (fault !== undefined) {
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
