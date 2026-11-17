import { memoryStore, type IncidentStore } from './store.js';
import type { ClusterState, FaultId, Incident, IncidentStep, PodView, StepKey } from './types.js';

/** Something the incident needs done to the cluster, carried out by the caller. */
export type Effect = { type: 'restore-image'; image: string };

export interface Transition {
  incident: Incident;
  step: StepKey | 'timed-out';
  detail: string;
}

export interface ObserveResult {
  transitions: Transition[];
  effects: Effect[];
}

export type StartContext =
  | { fault: 'crash-pod'; pod: string; restarts: number }
  | { fault: 'fail-readiness'; pod: string; seconds: number }
  | { fault: 'bad-deploy' | 'flaky-deploy'; brokenImage: string; restoreImage: string };

interface Tracked {
  incident: Incident;
  context: StartContext;
  /** bad-deploy only: the Rollout has been pointed back at the good image. */
  restoreRequested: boolean;
}

const HISTORY_LIMIT = 20;
const STEP_ORDER: StepKey[] = ['injected', 'detected', 'mitigated', 'recovered'];

/**
 * Follows each incident from injection to recovery by watching cluster state.
 * Holds no clock and makes no calls of its own: time and state are passed in,
 * and anything it wants done comes back as an effect.
 */
export class IncidentTracker {
  private tracked: Tracked[] = [];
  /** Loaded from the store at startup: history only, with no context to follow. */
  private restored: Incident[] = [];
  private nextId = 1;

  constructor(
    private readonly timeoutMs: number,
    private readonly store: IncidentStore = memoryStore(),
  ) {
    const now = Date.now();
    for (const incident of store.load(HISTORY_LIMIT)) {
      // The controller restarted mid-incident and can no longer follow it.
      if (incident.status === 'active') {
        incident.status = 'timed-out';
        incident.endedAt = now;
        store.save(incident);
      }
      const suffix = /^inc-(\d+)$/.exec(incident.id);
      if (suffix) this.nextId = Math.max(this.nextId, Number(suffix[1]) + 1);
      this.restored.push(incident);
    }
  }

  /** Newest first. */
  list(): Incident[] {
    return [...this.tracked.map((t) => t.incident), ...this.restored].slice(0, HISTORY_LIMIT);
  }

  isActive(fault: FaultId): boolean {
    return this.tracked.some((t) => t.incident.fault === fault && t.incident.status === 'active');
  }

  /** Record how many requests failed while the incident ran. */
  setFailedRequests(id: string, count: number): void {
    const incident = this.list().find((i) => i.id === id);
    if (!incident || incident.failedRequests === count) return;
    incident.failedRequests = count;
    this.persist(incident);
  }

  /** Pods that an active incident is already aimed at. */
  targetedPods(): Set<string> {
    const pods = new Set<string>();
    for (const t of this.tracked) {
      if (t.incident.status === 'active' && t.incident.pod) pods.add(t.incident.pod);
    }
    return pods;
  }

  start(context: StartContext, detail: string, now: number): Incident {
    const steps: IncidentStep[] = STEP_ORDER.map((key) => ({ key }));
    steps[0] = { key: 'injected', at: now, detail };
    const incident: Incident = {
      id: `inc-${this.nextId++}`,
      fault: context.fault,
      pod: 'pod' in context ? context.pod : undefined,
      status: 'active',
      startedAt: now,
      steps,
    };
    this.tracked.unshift({ incident, context, restoreRequested: false });
    this.tracked.length = Math.min(this.tracked.length, HISTORY_LIMIT);
    this.restored.length = Math.min(this.restored.length, HISTORY_LIMIT - this.tracked.length);
    this.persist(incident);
    return incident;
  }

  /** Advance every active incident against the latest cluster state. */
  observe(state: ClusterState, now: number): ObserveResult {
    const result: ObserveResult = { transitions: [], effects: [] };
    for (const t of this.tracked) {
      if (t.incident.status !== 'active') continue;
      const before = JSON.stringify(t.incident);
      switch (t.context.fault) {
        case 'crash-pod':
          this.observeCrash(t, t.context, state, now, result);
          break;
        case 'fail-readiness':
          this.observeUnready(t, t.context, state, now, result);
          break;
        case 'bad-deploy':
        case 'flaky-deploy':
          this.observeDeploy(t, t.context, state, now, result);
          break;
      }
      if (t.incident.status === 'active' && now - t.incident.startedAt > this.timeoutMs) {
        this.timeOut(t, now, result);
      }
      // Runs every second; only write when something changed.
      if (JSON.stringify(t.incident) !== before) this.persist(t.incident);
    }
    return result;
  }

  private observeCrash(
    t: Tracked,
    context: Extract<StartContext, { fault: 'crash-pod' }>,
    state: ClusterState,
    now: number,
    result: ObserveResult,
  ): void {
    const pod = findPod(state, context.pod);
    if (!pod) return;
    const restarted = pod.restarts > context.restarts;

    if (!pod.ready || restarted) {
      this.mark(t, 'detected', now, result, 'Kubelet saw the container exit; the pod was marked not ready and taken out of the Service');
    }
    if (restarted) {
      this.mark(t, 'mitigated', now, result, `Kubelet restarted the container (restart #${pod.restarts})`);
    }
    if (restarted && pod.ready && pod.inService) {
      this.mark(t, 'recovered', now, result, 'Probes passing again; the pod is back in the Service');
    }
  }

  private observeUnready(
    t: Tracked,
    context: Extract<StartContext, { fault: 'fail-readiness' }>,
    state: ClusterState,
    now: number,
    result: ObserveResult,
  ): void {
    const pod = findPod(state, context.pod);
    if (!pod) return;

    if (!pod.ready || !pod.inService) {
      this.mark(t, 'detected', now, result, 'Readiness probe failed; the pod was marked not ready');
    }
    if (!pod.inService) {
      this.mark(t, 'mitigated', now, result, 'Removed from the Service endpoints; the other pods take the traffic');
    }
    if (this.has(t, 'mitigated') && pod.ready && pod.inService) {
      this.mark(t, 'recovered', now, result, 'Readiness probe passing again; the pod rejoined the Service');
    }
  }

  /** Both deploy faults: a canary of a bad image, aborted by Argo Rollouts. */
  private observeDeploy(
    t: Tracked,
    context: Extract<StartContext, { fault: 'bad-deploy' | 'flaky-deploy' }>,
    state: ClusterState,
    now: number,
    result: ObserveResult,
  ): void {
    const rollout = state.rollout;
    if (!rollout) return;
    const canaries = state.pods.filter((p) => p.image === context.brokenImage && p.state !== 'terminating');
    const flaky = context.fault === 'flaky-deploy';

    if (flaky) {
      // Only an analysis run started by this release counts.
      const analysis = state.analysis;
      if (analysis && analysis.startedAt >= t.incident.startedAt - 1000 && analysis.failed > 0) {
        this.mark(t, 'detected', now, result, 'Canary analysis measured an error rate above 5% on the canary');
      }
    } else if (canaries.some((p) => p.state === 'not-ready')) {
      this.mark(t, 'detected', now, result, 'Canary pod started but fails its readiness probe, so it receives no traffic');
    }

    if (rollout.aborted && rollout.image === context.brokenImage) {
      this.mark(t, 'detected', now, result, flaky ? 'Canary was serving errors' : 'Canary never became ready');
      this.mark(
        t,
        'mitigated',
        now,
        result,
        flaky
          ? 'Analysis failed; Argo Rollouts aborted the release and sent all traffic back to the stable version'
          : 'Progress deadline passed; Argo Rollouts aborted the release and removed the canary',
      );
      if (!t.restoreRequested) {
        t.restoreRequested = true;
        result.effects.push({ type: 'restore-image', image: context.restoreImage });
      }
    }
    if (
      this.has(t, 'mitigated') &&
      rollout.image === context.restoreImage &&
      rollout.phase === 'Healthy' &&
      canaries.length === 0
    ) {
      this.mark(t, 'recovered', now, result, 'Rollout is healthy on the stable version');
    }
  }

  private persist(incident: Incident): void {
    this.store.save(incident);
    this.store.prune(HISTORY_LIMIT);
  }

  private timeOut(t: Tracked, now: number, result: ObserveResult): void {
    t.incident.status = 'timed-out';
    t.incident.endedAt = now;
    const detail = `No full recovery within ${Math.round(this.timeoutMs / 1000)}s`;
    result.transitions.push({ incident: t.incident, step: 'timed-out', detail });
    // Never leave the Rollout pointing at the broken image.
    if ('restoreImage' in t.context && !t.restoreRequested) {
      t.restoreRequested = true;
      result.effects.push({ type: 'restore-image', image: t.context.restoreImage });
    }
  }

  private has(t: Tracked, key: StepKey): boolean {
    return t.incident.steps.some((s) => s.key === key && s.at !== undefined);
  }

  /** Record a step the first time it is seen. Earlier steps are filled in if skipped. */
  private mark(t: Tracked, key: StepKey, now: number, result: ObserveResult, detail: string): void {
    if (this.has(t, key)) return;
    const index = STEP_ORDER.indexOf(key);
    for (let i = 1; i < index; i++) {
      const earlier = t.incident.steps[i]!;
      if (earlier.at === undefined) earlier.at = now;
    }
    t.incident.steps[index] = { key, at: now, detail };
    result.transitions.push({ incident: t.incident, step: key, detail });
    if (key === 'recovered') {
      t.incident.status = 'recovered';
      t.incident.endedAt = now;
      t.incident.recoveryMs = now - t.incident.startedAt;
    }
  }
}

function findPod(state: ClusterState, name: string): PodView | undefined {
  return state.pods.find((p) => p.name === name);
}
