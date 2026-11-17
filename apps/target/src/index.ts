import { createApp } from './app.js';
import { log } from './log.js';

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  }
  return value;
}

const port = intFromEnv('PORT', 8080);
const adminPort = intFromEnv('ADMIN_PORT', 9090);
// Time between failing readiness and closing the listeners on SIGTERM, so the
// Service stops routing here before in-flight requests are cut off.
const shutdownDelayMs = intFromEnv('SHUTDOWN_DELAY_MS', 3000);
const broken = process.env.BROKEN === 'true';

const app = createApp({
  version: process.env.VERSION ?? 'dev',
  podName: process.env.POD_NAME ?? process.env.HOSTNAME ?? 'local',
  broken,
  startupDelayMs: intFromEnv('STARTUP_DELAY_MS', 2000),
  exit: (code) => process.exit(code),
});

app.main.listen(port, () => log('info', 'listening', { server: 'main', port }));
app.admin.listen(adminPort, () => log('info', 'listening', { server: 'admin', port: adminPort }));

if (broken) log('warn', 'BROKEN=true: readiness will never pass');

let stopping = false;
function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  log('info', 'shutting down', { signal, shutdownDelayMs });
  app.beginShutdown();
  setTimeout(() => {
    app.main.close();
    app.admin.close();
    app.main.closeIdleConnections();
    app.admin.closeIdleConnections();
    // Don't let a stuck connection hold the pod past its grace period.
    setTimeout(() => process.exit(0), 2000).unref();
  }, shutdownDelayMs);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
