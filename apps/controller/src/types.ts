export type PodState = 'ready' | 'not-ready' | 'starting' | 'crashed' | 'pending' | 'terminating';

export interface PodView {
  name: string;
  ip?: string;
  state: PodState;
  ready: boolean;
  /** True when the Service is currently sending this pod traffic. */
  inService: boolean;
  restarts: number;
  image: string;
  /** The image tag, e.g. "v1". */
  version: string;
  /** Which ReplicaSet the pod belongs to. */
  hash: string;
  role: 'stable' | 'canary';
  createdAt: string;
}

export interface RolloutView {
  phase: string;
  message: string;
  aborted: boolean;
  image: string;
  stableHash: string;
  replicas: number;
  readyReplicas: number;
  updatedReplicas: number;
  step: number;
  stepCount: number;
}

/** The most recent canary analysis run. */
export interface AnalysisView {
  name: string;
  phase: string;
  startedAt: number;
  successful: number;
  failed: number;
}

export interface ClusterState {
  pods: PodView[];
  rollout: RolloutView | null;
  analysis: AnalysisView | null;
}

export const FAULT_IDS = ['crash-pod', 'fail-readiness', 'bad-deploy', 'flaky-deploy'] as const;
export type FaultId = (typeof FAULT_IDS)[number];

export function isFaultId(value: string): value is FaultId {
  return (FAULT_IDS as readonly string[]).includes(value);
}

export type StepKey = 'injected' | 'detected' | 'mitigated' | 'recovered';

export interface IncidentStep {
  key: StepKey;
  /** Epoch milliseconds; absent until the step has happened. */
  at?: number;
  detail?: string;
}

export interface Incident {
  id: string;
  fault: FaultId;
  /** The pod the fault was aimed at, for pod faults. */
  pod?: string;
  status: 'active' | 'recovered' | 'timed-out';
  startedAt: number;
  endedAt?: number;
  /** Injected to recovered, in milliseconds. */
  recoveryMs?: number;
  /** Requests the load generator saw fail during the incident. Absent without Prometheus. */
  failedRequests?: number;
  steps: IncidentStep[];
}

export interface FaultView {
  id: FaultId;
  label: string;
  description: string;
  heals: string;
  cooldownSeconds: number;
  /** Epoch milliseconds from which the fault can be triggered again. */
  availableAt: number;
  active: boolean;
}

export interface LogEntry {
  id: number;
  ts: number;
  source: 'kubernetes' | 'controller';
  level: 'info' | 'warn';
  reason: string;
  object?: string;
  message: string;
}

/** Ten minutes of traffic as the load generator saw it. A null value is a gap. */
export interface MetricsView {
  timestamps: number[];
  rps: (number | null)[];
  successRate: (number | null)[];
  p95Ms: (number | null)[];
}

export interface Snapshot {
  /** Server clock, so browsers can correct for skew when showing cooldowns. */
  now: number;
  pods: PodView[];
  rollout: RolloutView | null;
  faults: FaultView[];
  incidents: Incident[];
  watchers: number;
}
