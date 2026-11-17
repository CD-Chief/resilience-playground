import { Agent, request } from 'node:http';

export interface TickStats {
  /** Requests that completed with a 2xx in this interval. */
  ok: number;
  /** Requests that failed in this interval: non-2xx, timeout or network error. */
  failed: number;
  avgMs: number;
  maxMs: number;
  /** Failure reasons in this interval, e.g. { "503": 2, "ECONNREFUSED": 1 }. */
  errors: Record<string, number>;
  /** Successful responses per target version, which shows canary traffic share. */
  versions: Record<string, number>;
  totalOk: number;
  totalFailed: number;
}

export interface Options {
  url: string;
  /** Requests per second. */
  rate: number;
  timeoutMs: number;
  /** How often stats are reported. */
  tickMs?: number;
  onTick: (stats: TickStats) => void;
}

interface Result {
  ok: boolean;
  ms: number;
  error?: string;
  version?: string;
}

// A fresh connection per request. With keep-alive, kube-proxy would pin each
// connection to one pod, hiding both load balancing and endpoint removal.
const agent = new Agent({ keepAlive: false });

function sendOne(url: string, timeoutMs: number): Promise<Result> {
  return new Promise((resolve) => {
    const begin = performance.now();
    const done = (result: Omit<Result, 'ms'>) => {
      resolve({ ...result, ms: performance.now() - begin });
    };

    const req = request(url, { agent, signal: AbortSignal.timeout(timeoutMs) }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', (err) => done({ ok: false, error: reason(err) }));
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          done({ ok: false, error: String(status) });
          return;
        }
        let version: string | undefined;
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { version?: unknown };
          if (typeof body.version === 'string') version = body.version;
        } catch {
          // A 2xx with a non-JSON body still counts as a success.
        }
        done({ ok: true, version });
      });
    });
    req.on('error', (err) => done({ ok: false, error: reason(err) }));
    req.end();
  });
}

function reason(err: unknown): string {
  const e = err as { name?: string; code?: string };
  if (e.name === 'TimeoutError' || e.code === 'ABORT_ERR') return 'timeout';
  return e.code ?? e.name ?? 'error';
}

function emptyTick() {
  return {
    ok: 0,
    failed: 0,
    sumMs: 0,
    maxMs: 0,
    errors: {} as Record<string, number>,
    versions: {} as Record<string, number>,
  };
}

export function startLoadgen(options: Options): { stop: () => void } {
  const { url, rate, timeoutMs, onTick, tickMs = 1000 } = options;
  let tick = emptyTick();
  let totalOk = 0;
  let totalFailed = 0;

  const record = (result: Result) => {
    tick.sumMs += result.ms;
    tick.maxMs = Math.max(tick.maxMs, result.ms);
    if (result.ok) {
      tick.ok += 1;
      totalOk += 1;
      const version = result.version ?? 'unknown';
      tick.versions[version] = (tick.versions[version] ?? 0) + 1;
    } else {
      tick.failed += 1;
      totalFailed += 1;
      const key = result.error ?? 'error';
      tick.errors[key] = (tick.errors[key] ?? 0) + 1;
    }
  };

  // Open loop: requests go out on schedule whether or not earlier ones have
  // finished, so a slow or dead target can't quietly lower the request rate.
  const sender = setInterval(() => {
    void sendOne(url, timeoutMs).then(record);
  }, 1000 / rate);

  const reporter = setInterval(() => {
    const done = tick.ok + tick.failed;
    const snapshot = tick;
    tick = emptyTick();
    onTick({
      ok: snapshot.ok,
      failed: snapshot.failed,
      avgMs: done === 0 ? 0 : Math.round((snapshot.sumMs / done) * 10) / 10,
      maxMs: Math.round(snapshot.maxMs * 10) / 10,
      errors: snapshot.errors,
      versions: snapshot.versions,
      totalOk,
      totalFailed,
    });
  }, tickMs);

  return {
    stop: () => {
      clearInterval(sender);
      clearInterval(reporter);
    },
  };
}
