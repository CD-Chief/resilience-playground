import type { CoreV1Event, V1EndpointSlice, V1Pod } from '@kubernetes/client-node';
import type { LogEntry, PodState, PodView, RolloutView } from './types.js';

/** The fields of an Argo Rollout that the controller reads. */
export interface RolloutObject {
  metadata?: { name?: string };
  spec?: {
    template?: { spec?: { containers?: { image?: string }[] } };
    strategy?: { canary?: { steps?: unknown[] } };
  };
  status?: {
    phase?: string;
    message?: string;
    abort?: boolean;
    stableRS?: string;
    replicas?: number;
    readyReplicas?: number;
    updatedReplicas?: number;
    currentStepIndex?: number;
  };
}

const HASH_LABEL = 'rollouts-pod-template-hash';

function podState(pod: V1Pod, ready: boolean): PodState {
  if (pod.metadata?.deletionTimestamp) return 'terminating';
  const container = pod.status?.containerStatuses?.[0];
  if (!container) return 'pending';
  if (container.state?.terminated) return 'crashed';
  if (container.state?.waiting) {
    // Waiting after having run before means it died and is being restarted.
    return container.restartCount > 0 || container.lastState?.terminated ? 'crashed' : 'pending';
  }
  if (!container.started) return 'starting';
  return ready ? 'ready' : 'not-ready';
}

export function imageTag(image: string): string {
  const name = image.slice(image.lastIndexOf('/') + 1);
  const colon = name.lastIndexOf(':');
  return colon === -1 ? 'latest' : name.slice(colon + 1);
}

export function toPodView(pod: V1Pod, stableHash: string, servingIps: Set<string>): PodView {
  const deleting = Boolean(pod.metadata?.deletionTimestamp);
  const ready =
    !deleting && (pod.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True');
  const image = pod.spec?.containers[0]?.image ?? '';
  const hash = pod.metadata?.labels?.[HASH_LABEL] ?? '';
  const ip = pod.status?.podIP;
  return {
    name: pod.metadata?.name ?? '',
    ip,
    state: podState(pod, ready),
    ready,
    inService: ip !== undefined && servingIps.has(ip),
    restarts: pod.status?.containerStatuses?.[0]?.restartCount ?? 0,
    image,
    version: imageTag(image),
    hash,
    role: stableHash === '' || hash === stableHash ? 'stable' : 'canary',
    createdAt: new Date(pod.metadata?.creationTimestamp ?? 0).toISOString(),
  };
}

/** Pod IPs the Service is routing to right now. */
export function servingIps(slices: readonly V1EndpointSlice[]): Set<string> {
  const ips = new Set<string>();
  for (const slice of slices) {
    for (const endpoint of slice.endpoints ?? []) {
      if (endpoint.conditions?.ready === false) continue;
      for (const address of endpoint.addresses) ips.add(address);
    }
  }
  return ips;
}

export function toRolloutView(rollout: RolloutObject): RolloutView {
  const status = rollout.status ?? {};
  return {
    phase: status.phase ?? 'Unknown',
    message: status.message ?? '',
    aborted: status.abort === true,
    image: rollout.spec?.template?.spec?.containers?.[0]?.image ?? '',
    stableHash: status.stableRS ?? '',
    replicas: status.replicas ?? 0,
    readyReplicas: status.readyReplicas ?? 0,
    updatedReplicas: status.updatedReplicas ?? 0,
    step: status.currentStepIndex ?? 0,
    stepCount: rollout.spec?.strategy?.canary?.steps?.length ?? 0,
  };
}

export function eventTime(event: CoreV1Event): number {
  const when = event.lastTimestamp ?? event.eventTime ?? event.metadata.creationTimestamp;
  return when ? new Date(when).getTime() : 0;
}

export function toLogEntry(event: CoreV1Event): Omit<LogEntry, 'id'> {
  const object = event.involvedObject;
  return {
    ts: eventTime(event),
    source: 'kubernetes',
    level: event.type === 'Warning' ? 'warn' : 'info',
    reason: event.reason ?? 'Event',
    object: object.kind && object.name ? `${object.kind}/${object.name}` : undefined,
    message: (event.message ?? '').trim(),
  };
}
