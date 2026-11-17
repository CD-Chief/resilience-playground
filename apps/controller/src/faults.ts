import type { Config } from './config.js';
import type { IncidentTracker } from './incidents.js';
import { errorMessage } from './log.js';
import type { ClusterState, FaultId, FaultView, Incident, PodView } from './types.js';
import { FAULT_IDS } from './types.js';

export interface FaultActions {
  crashPod: (podIp: string) => Promise<void>;
  failReadiness: (podIp: string, seconds: number) => Promise<void>;
  setRolloutImage: (image: string) => Promise<void>;
}

export type InjectResult =
  | { ok: true; incident: Incident }
  | { ok: false; status: 409 | 429 | 502; error: string; retryAfterSeconds?: number };

const COPY: Record<FaultId, { label: string; description: string; heals: string }> = {
  'crash-pod': {
    label: 'Crash a pod',
    description: 'Tells one pod to exit its process, as if it had crashed.',
    heals: 'The kubelet restarts the container; the other pods keep serving.',
  },
  'fail-readiness': {
    label: 'Fail readiness',
    description: "Makes one pod's readiness probe fail for a while.",
    heals: 'The pod is taken out of the Service and rejoins once it is healthy again.',
  },
  'bad-deploy': {
    label: 'Bad deploy',
    description: 'Releases a broken version of the app as a canary.',
    heals: 'Argo Rollouts aborts the release when the canary fails to become ready.',
  },
};

/**
 * The fixed set of faults a visitor can trigger. Each has a cooldown shared by
 * everyone, and only one incident of a kind runs at a time.
 */
export class FaultService {
  private readonly availableAt: Record<FaultId, number> = {
    'crash-pod': 0,
    'fail-readiness': 0,
    'bad-deploy': 0,
  };
  private readonly inFlight = new Set<FaultId>();

  constructor(
    private readonly config: Config,
    private readonly tracker: IncidentTracker,
    private readonly getState: () => ClusterState,
    private readonly actions: FaultActions,
    private readonly random: () => number = Math.random,
  ) {}

  views(): FaultView[] {
    return FAULT_IDS.map((id) => ({
      id,
      ...COPY[id],
      cooldownSeconds: this.config.cooldownMs[id] / 1000,
      availableAt: this.availableAt[id],
      active: this.inFlight.has(id) || this.tracker.isActive(id),
    }));
  }

  async inject(id: FaultId, now: number): Promise<InjectResult> {
    if (this.inFlight.has(id) || this.tracker.isActive(id)) {
      return { ok: false, status: 409, error: 'This fault is still recovering.' };
    }
    if (now < this.availableAt[id]) {
      return {
        ok: false,
        status: 429,
        error: 'This fault is cooling down.',
        retryAfterSeconds: Math.ceil((this.availableAt[id] - now) / 1000),
      };
    }

    // Claimed before the first await, so two requests arriving together
    // cannot both get through.
    this.inFlight.add(id);
    try {
      const result = id === 'bad-deploy' ? await this.badDeploy(now) : await this.podFault(id, now);
      if (result.ok) this.availableAt[id] = now + this.config.cooldownMs[id];
      return result;
    } catch (err) {
      return { ok: false, status: 502, error: `Could not inject the fault: ${errorMessage(err)}` };
    } finally {
      this.inFlight.delete(id);
    }
  }

  private async podFault(id: 'crash-pod' | 'fail-readiness', now: number): Promise<InjectResult> {
    const state = this.getState();
    const serving = state.pods.filter((p) => p.ready && p.inService);
    if (serving.length - 1 < this.config.minServingPods) {
      return {
        ok: false,
        status: 409,
        error: 'Not enough healthy pods right now. Wait for the current recovery to finish.',
      };
    }

    const targeted = this.tracker.targetedPods();
    const candidates = serving.filter(
      (p): p is PodView & { ip: string } =>
        p.role === 'stable' && p.ip !== undefined && !targeted.has(p.name),
    );
    const pod = candidates[Math.floor(this.random() * candidates.length)];
    if (!pod) {
      return { ok: false, status: 409, error: 'No healthy pod is available to target right now.' };
    }

    if (id === 'crash-pod') {
      await this.actions.crashPod(pod.ip);
      const incident = this.tracker.start(
        { fault: id, pod: pod.name, restarts: pod.restarts },
        `Told ${pod.name} to exit its process`,
        now,
      );
      return { ok: true, incident };
    }

    const seconds = this.config.unreadySeconds;
    await this.actions.failReadiness(pod.ip, seconds);
    const incident = this.tracker.start(
      { fault: id, pod: pod.name, seconds },
      `Made ${pod.name} fail its readiness probe for ${seconds}s`,
      now,
    );
    return { ok: true, incident };
  }

  private async badDeploy(now: number): Promise<InjectResult> {
    const rollout = this.getState().rollout;
    if (!rollout || rollout.phase !== 'Healthy' || rollout.image === this.config.brokenImage) {
      return {
        ok: false,
        status: 409,
        error: 'The Rollout is not healthy right now. Wait for it to settle.',
      };
    }

    await this.actions.setRolloutImage(this.config.brokenImage);
    const incident = this.tracker.start(
      { fault: 'bad-deploy', brokenImage: this.config.brokenImage, restoreImage: rollout.image },
      `Released the broken image ${this.config.brokenImage} as a canary`,
      now,
    );
    return { ok: true, incident };
  }
}
