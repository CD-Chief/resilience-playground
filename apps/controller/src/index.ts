import { Cluster } from './cluster.js';
import { config } from './config.js';
import { FaultService } from './faults.js';
import { IncidentTracker, type ObserveResult } from './incidents.js';
import { errorMessage, log } from './log.js';
import { Prometheus } from './metrics.js';
import { createApi } from './server.js';
import type { LogEntry, MetricsView, Snapshot } from './types.js';

const LOG_LIMIT = 200;
const BROADCAST_DELAY_MS = 100;
const TICK_MS = 1000;
const RESTORE_RETRY_MS = 10000;
const METRICS_MS = 5000;
// Long enough for Prometheus to scrape the last failures of an incident.
const FAILED_COUNT_SETTLE_MS = 12000;

const tracker = new IncidentTracker(config.incidentTimeoutMs);
const entries: LogEntry[] = [];
let nextEntryId = 1;
let broadcastTimer: NodeJS.Timeout | undefined;
let lastRestoreAttempt = 0;

const prometheus = config.prometheusUrl ? new Prometheus(config.prometheusUrl) : null;
let metrics: MetricsView | null = null;
let metricsFailing = false;
/** Incident id -> the load generator's failed-request total when it began. */
const failedBaselines = new Map<string, number>();

const cluster = new Cluster(config, {
  onChange: () => {
    apply(tracker.observe(cluster.state(), Date.now()));
    scheduleBroadcast();
  },
  onEvent: (entry) => addEntry(entry),
});

const faults = new FaultService(config, tracker, () => cluster.state(), {
  crashPod: (ip) => cluster.callAdmin(ip, '/admin/crash'),
  failReadiness: (ip, seconds) => cluster.callAdmin(ip, `/admin/unready?seconds=${seconds}`),
  setRolloutImage: (image) => cluster.setRolloutImage(image),
});

const api = createApi({
  snapshot,
  backlog: () => entries,
  metrics: () => metrics,
  inject: async (fault) => {
    // Read before the fault, so everything it breaks is counted.
    const baseline = prometheus ? await prometheus.failedTotal().catch(() => null) : null;
    const result = await faults.inject(fault, Date.now());
    if (result.ok) {
      if (baseline !== null) {
        failedBaselines.set(result.incident.id, baseline);
        tracker.setFailedRequests(result.incident.id, 0);
      }
      const detail = result.incident.steps[0]?.detail ?? fault;
      addEntry({
        ts: result.incident.startedAt,
        source: 'controller',
        level: 'warn',
        reason: 'FaultInjected',
        object: result.incident.pod ? `Pod/${result.incident.pod}` : `Rollout/${config.rolloutName}`,
        message: detail,
      });
      log('info', 'fault injected', { fault, incident: result.incident.id, pod: result.incident.pod });
      scheduleBroadcast();
    } else {
      log('info', 'fault refused', { fault, status: result.status, reason: result.error });
    }
    return result;
  },
  onWatchersChanged: scheduleBroadcast,
});

function snapshot(): Snapshot {
  const state = cluster.state();
  return {
    now: Date.now(),
    pods: state.pods,
    rollout: state.rollout,
    faults: faults.views(),
    incidents: tracker.list(),
    watchers: api.watchers(),
  };
}

function addEntry(entry: Omit<LogEntry, 'id'>): void {
  const full: LogEntry = { id: nextEntryId++, ...entry };
  entries.push(full);
  if (entries.length > LOG_LIMIT) entries.shift();
  api.broadcast('log', full);
}

// Several watch updates usually arrive together; send one snapshot for the lot.
function scheduleBroadcast(): void {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = undefined;
    api.broadcast('state', snapshot());
  }, BROADCAST_DELAY_MS);
}

function apply(result: ObserveResult): void {
  for (const { incident, step, detail } of result.transitions) {
    const recovered = step === 'recovered';
    const seconds = incident.recoveryMs === undefined ? '' : ` in ${(incident.recoveryMs / 1000).toFixed(1)}s`;
    addEntry({
      ts: Date.now(),
      source: 'controller',
      level: step === 'timed-out' ? 'warn' : 'info',
      reason: `Incident${step[0]!.toUpperCase()}${step.slice(1)}`,
      object: incident.pod ? `Pod/${incident.pod}` : `Rollout/${config.rolloutName}`,
      message: recovered ? `${detail} (recovered${seconds})` : detail,
    });
    log('info', 'incident step', { incident: incident.id, fault: incident.fault, step, recoveryMs: incident.recoveryMs });
  }
  for (const effect of result.effects) {
    restoreImage(effect.image, 'Set the Rollout back to the stable image');
  }
  if (result.transitions.length > 0) scheduleBroadcast();
}

function restoreImage(image: string, message: string): void {
  lastRestoreAttempt = Date.now();
  cluster.setRolloutImage(image).then(
    () => {
      addEntry({
        ts: Date.now(),
        source: 'controller',
        level: 'info',
        reason: 'ImageRestored',
        object: `Rollout/${config.rolloutName}`,
        message: `${message} (${image})`,
      });
      log('info', 'rollout image restored', { image });
    },
    (err: unknown) => log('error', 'restoring rollout image failed', { image, error: errorMessage(err) }),
  );
}

// Time-based checks that no watch update will trigger.
setInterval(() => {
  const state = cluster.state();
  apply(tracker.observe(state, Date.now()));

  // Safety net: the Rollout must never be left on the broken image, whether a
  // restore call failed or this process restarted in the middle of an incident.
  const image = state.rollout?.image;
  const stranded =
    (image === config.brokenImage || image === config.flakyImage) &&
    !faults.views().some((f) => (f.id === 'bad-deploy' || f.id === 'flaky-deploy') && f.active);
  if (stranded && Date.now() - lastRestoreAttempt > RESTORE_RETRY_MS) {
    restoreImage(config.stableImage, 'Found the Rollout on a faulty image; set it back to stable');
  }
}, TICK_MS);

async function refreshMetrics(): Promise<void> {
  if (!prometheus) return;
  try {
    metrics = await prometheus.graphs(Date.now());
    api.broadcast('metrics', metrics);

    if (failedBaselines.size > 0) {
      const total = await prometheus.failedTotal();
      const now = Date.now();
      for (const incident of tracker.list()) {
        const baseline = failedBaselines.get(incident.id);
        if (baseline === undefined || total === null) continue;
        tracker.setFailedRequests(incident.id, Math.max(0, Math.round(total - baseline)));
        if (incident.endedAt !== undefined && now - incident.endedAt > FAILED_COUNT_SETTLE_MS) {
          failedBaselines.delete(incident.id);
        }
      }
      scheduleBroadcast();
    }
    if (metricsFailing) log('info', 'prometheus reachable again');
    metricsFailing = false;
  } catch (err) {
    // Logged once per outage, not every five seconds.
    if (!metricsFailing) log('warn', 'prometheus query failed', { error: errorMessage(err) });
    metricsFailing = true;
  }
}
setInterval(() => void refreshMetrics(), METRICS_MS);

process.on('SIGTERM', () => {
  log('info', 'shutting down');
  api.close();
  process.exit(0);
});

cluster.start().then(
  () => {
    api.server.listen(config.port, () => {
      log('info', 'listening', { port: config.port, namespace: config.namespace });
    });
  },
  (err: unknown) => {
    log('error', 'could not start cluster watches', { error: errorMessage(err) });
    process.exit(1);
  },
);
