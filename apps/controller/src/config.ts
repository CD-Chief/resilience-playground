function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  }
  return value;
}

export const config = {
  port: intFromEnv('PORT', 8080),
  /** The only namespace the controller reads from or writes to. */
  namespace: process.env.SANDBOX_NAMESPACE ?? 'sandbox',
  rolloutName: process.env.ROLLOUT_NAME ?? 'target',
  serviceName: process.env.SERVICE_NAME ?? 'target',
  podSelector: process.env.POD_SELECTOR ?? 'app=target',
  adminPort: intFromEnv('TARGET_ADMIN_PORT', 9090),
  /** The image a bad deploy releases, and the one to fall back to afterwards. */
  brokenImage: process.env.BROKEN_IMAGE ?? 'resilience-playground/target:v2-broken',
  stableImage: process.env.STABLE_IMAGE ?? 'resilience-playground/target:v1',
  /** Becomes ready, then fails a share of its requests. */
  flakyImage: process.env.FLAKY_IMAGE ?? 'resilience-playground/target:v2-flaky',
  /** Empty turns off graphs and failed-request counts. */
  prometheusUrl: process.env.PROMETHEUS_URL ?? '',
  unreadySeconds: intFromEnv('UNREADY_SECONDS', 45),
  /** Pod faults are refused unless this many pods would still be serving. */
  minServingPods: intFromEnv('MIN_SERVING_PODS', 2),
  incidentTimeoutMs: intFromEnv('INCIDENT_TIMEOUT_SECONDS', 120) * 1000,
  cooldownMs: {
    'crash-pod': intFromEnv('COOLDOWN_CRASH_POD_SECONDS', 30) * 1000,
    'fail-readiness': intFromEnv('COOLDOWN_FAIL_READINESS_SECONDS', 60) * 1000,
    'bad-deploy': intFromEnv('COOLDOWN_BAD_DEPLOY_SECONDS', 90) * 1000,
    'flaky-deploy': intFromEnv('COOLDOWN_FLAKY_DEPLOY_SECONDS', 90) * 1000,
  },
};

export type Config = typeof config;
