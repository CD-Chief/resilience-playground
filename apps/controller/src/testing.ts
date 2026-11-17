import type { ClusterState, PodView, RolloutView } from './types.js';

export const STABLE_IMAGE = 'resilience-playground/target:v1';
export const BROKEN_IMAGE = 'resilience-playground/target:v2-broken';
export const FLAKY_IMAGE = 'resilience-playground/target:v2-flaky';

export function pod(name: string, overrides: Partial<PodView> = {}): PodView {
  return {
    name,
    ip: `10.0.0.${name.charCodeAt(name.length - 1)}`,
    state: 'ready',
    ready: true,
    inService: true,
    restarts: 0,
    image: STABLE_IMAGE,
    version: 'v1',
    hash: 'stable',
    role: 'stable',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function rollout(overrides: Partial<RolloutView> = {}): RolloutView {
  return {
    phase: 'Healthy',
    message: '',
    aborted: false,
    image: STABLE_IMAGE,
    stableHash: 'stable',
    replicas: 3,
    readyReplicas: 3,
    updatedReplicas: 3,
    step: 2,
    stepCount: 2,
    ...overrides,
  };
}

export function healthy(): ClusterState {
  return { pods: [pod('a'), pod('b'), pod('c')], rollout: rollout(), analysis: null };
}

/** A copy of `state` with one pod changed. */
export function withPod(state: ClusterState, name: string, overrides: Partial<PodView>): ClusterState {
  return { ...state, pods: state.pods.map((p) => (p.name === name ? { ...p, ...overrides } : p)) };
}
