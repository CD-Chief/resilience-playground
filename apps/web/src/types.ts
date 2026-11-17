// The shapes the controller sends. Kept in step with apps/controller/src/types.ts.

export type PodState = 'ready' | 'not-ready' | 'starting' | 'crashed' | 'pending' | 'terminating';

export interface PodView {
  name: string;
  state: PodState;
  ready: boolean;
  inService: boolean;
  restarts: number;
  version: string;
  role: 'stable' | 'canary';
  createdAt: string;
}

export interface RolloutView {
  phase: string;
  message: string;
  aborted: boolean;
  image: string;
  replicas: number;
  readyReplicas: number;
  step: number;
  stepCount: number;
}

export type FaultId = 'crash-pod' | 'fail-readiness' | 'bad-deploy' | 'flaky-deploy';
export type StepKey = 'injected' | 'detected' | 'mitigated' | 'recovered';

export interface IncidentStep {
  key: StepKey;
  at?: number;
  detail?: string;
}

export interface Incident {
  id: string;
  fault: FaultId;
  pod?: string;
  status: 'active' | 'recovered' | 'timed-out';
  startedAt: number;
  endedAt?: number;
  recoveryMs?: number;
  failedRequests?: number;
  steps: IncidentStep[];
}

export interface FaultView {
  id: FaultId;
  label: string;
  description: string;
  heals: string;
  cooldownSeconds: number;
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

export interface MetricsView {
  timestamps: number[];
  rps: (number | null)[];
  successRate: (number | null)[];
  p95Ms: (number | null)[];
}

export interface Snapshot {
  now: number;
  pods: PodView[];
  rollout: RolloutView | null;
  faults: FaultView[];
  incidents: Incident[];
  watchers: number;
}
