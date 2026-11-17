import { startLoadgen } from './loadgen.js';

function log(level: 'info' | 'warn', msg: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(
    JSON.stringify({ ts: new Date().toISOString(), level, msg, app: 'loadgen', ...fields }) + '\n',
  );
}

function numberFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number from ${min} to ${max}, got "${raw}"`);
  }
  return value;
}

const url = process.env.TARGET_URL ?? 'http://target/api/work';
if (!url.startsWith('http://')) {
  throw new Error(`TARGET_URL must be an http:// URL, got "${url}"`);
}
const rate = numberFromEnv('RATE', 10, 1, 200);
const timeoutMs = numberFromEnv('TIMEOUT_MS', 2000, 100, 30000);

log('info', 'starting', { url, rate, timeoutMs });

const loadgen = startLoadgen({
  url,
  rate,
  timeoutMs,
  onTick: (stats) => log(stats.failed > 0 ? 'warn' : 'info', 'tick', { ...stats }),
});

function shutdown(signal: string): void {
  log('info', 'shutting down', { signal });
  loadgen.stop();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
