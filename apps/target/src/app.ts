import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Counter, Histogram, Registry } from 'prom-client';
import { log } from './log.js';

export interface Config {
  version: string;
  podName: string;
  /** When true, /readyz never passes. Used by the bad-deploy image tag. */
  broken: boolean;
  /** How long the app pretends to be starting up before /startupz passes. */
  startupDelayMs: number;
  /** Share of /api/work requests that fail with a 500, from 0 to 1. Used by the flaky-deploy image tag. */
  errorRate: number;
  /** Injected so tests can observe a crash instead of dying with it. */
  exit: (code: number) => void;
  /** Injected so tests can decide which requests fail. */
  random?: () => number;
}

export interface App {
  /** Public server: probes and /api/work. */
  main: Server;
  /** Admin server: fault toggles. Never exposed through ingress. */
  admin: Server;
  /** Fail readiness so the pod is taken out of rotation before the process stops. */
  beginShutdown: () => void;
}

const MAX_UNREADY_SECONDS = 300;
const DEFAULT_UNREADY_SECONDS = 45;
/** Paths called on a timer by the cluster itself; kept out of the request log. */
const QUIET_PATHS = new Set(['/healthz', '/readyz', '/startupz', '/metrics']);

function send(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function parseUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? '/', 'http://localhost');
}

/** A small, fixed amount of CPU work so requests have a measurable duration. */
function doWork(seed: string): string {
  let digest = seed;
  for (let i = 0; i < 2000; i++) {
    digest = createHash('sha256').update(digest).digest('hex');
  }
  return digest.slice(0, 12);
}

export function createApp(config: Config): App {
  const startedAt = Date.now();
  let unreadyUntil = 0;
  let unreadyTimer: NodeJS.Timeout | undefined;
  let shuttingDown = false;
  let workCount = 0;

  const random = config.random ?? Math.random;

  const registry = new Registry();
  const requests = new Counter({
    name: 'target_http_requests_total',
    help: 'Requests to /api/work, by response status.',
    labelNames: ['status'],
    registers: [registry],
  });
  const duration = new Histogram({
    name: 'target_http_request_duration_seconds',
    help: 'Time spent handling /api/work.',
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
    registers: [registry],
  });

  const identity = { pod: config.podName, version: config.version };
  const started = (): boolean => Date.now() - startedAt >= config.startupDelayMs;

  const notReadyReason = (): string | undefined => {
    if (shuttingDown) return 'shutting down';
    if (config.broken) return 'broken build';
    if (!started()) return 'starting';
    if (Date.now() < unreadyUntil) return 'fault: unready';
    return undefined;
  };

  const main = createServer((req, res) => {
    const { pathname } = parseUrl(req);
    const begin = process.hrtime.bigint();

    if (!QUIET_PATHS.has(pathname)) {
      res.on('finish', () => {
        log('info', 'request', {
          method: req.method,
          path: pathname,
          status: res.statusCode,
          durationMs: Number(process.hrtime.bigint() - begin) / 1e6,
        });
      });
    }

    if (req.method !== 'GET') {
      send(res, 405, { error: 'method not allowed' });
      return;
    }

    switch (pathname) {
      case '/healthz':
        send(res, 200, { status: 'ok', ...identity });
        return;
      case '/startupz':
        if (started()) send(res, 200, { status: 'started', ...identity });
        else send(res, 503, { status: 'starting', ...identity });
        return;
      case '/readyz': {
        const reason = notReadyReason();
        if (reason) send(res, 503, { status: 'not ready', reason, ...identity });
        else send(res, 200, { status: 'ready', ...identity });
        return;
      }
      case '/api/work': {
        workCount += 1;
        const result = doWork(`${config.podName}:${workCount}`);
        const failed = config.errorRate > 0 && random() < config.errorRate;
        if (failed) send(res, 500, { ok: false, error: 'internal error', ...identity });
        else send(res, 200, { ok: true, result, count: workCount, ...identity });
        requests.inc({ status: String(res.statusCode) });
        duration.observe(Number(process.hrtime.bigint() - begin) / 1e9);
        return;
      }
      case '/metrics':
        void registry.metrics().then((body) => {
          res.writeHead(200, { 'content-type': registry.contentType });
          res.end(body);
        });
        return;
      default:
        send(res, 404, { error: 'not found' });
    }
  });

  const admin = createServer((req, res) => {
    const url = parseUrl(req);

    if (req.method !== 'POST') {
      send(res, 405, { error: 'method not allowed' });
      return;
    }

    switch (url.pathname) {
      case '/admin/crash':
        log('warn', 'fault injected: crash', { fault: 'crash' });
        send(res, 202, { ok: true, fault: 'crash', ...identity });
        // Give the response a moment to flush, then die like a real crash would.
        setTimeout(() => config.exit(1), 100);
        return;
      case '/admin/unready': {
        const raw = url.searchParams.get('seconds');
        const seconds = raw === null ? DEFAULT_UNREADY_SECONDS : Number(raw);
        if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_UNREADY_SECONDS) {
          send(res, 400, { error: `seconds must be an integer from 1 to ${MAX_UNREADY_SECONDS}` });
          return;
        }
        unreadyUntil = Date.now() + seconds * 1000;
        clearTimeout(unreadyTimer);
        unreadyTimer = setTimeout(() => {
          log('info', 'fault ended: readiness restored', { fault: 'unready' });
        }, seconds * 1000);
        unreadyTimer.unref();
        log('warn', 'fault injected: unready', { fault: 'unready', seconds });
        send(res, 202, {
          ok: true,
          fault: 'unready',
          seconds,
          until: new Date(unreadyUntil).toISOString(),
          ...identity,
        });
        return;
      }
      default:
        send(res, 404, { error: 'not found' });
    }
  });

  return {
    main,
    admin,
    beginShutdown: () => {
      shuttingDown = true;
    },
  };
}
