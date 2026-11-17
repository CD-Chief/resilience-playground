import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { V1ContainerStatus, V1Pod } from '@kubernetes/client-node';
import { displayVersion, imageTag, servingIps, toPodView, toRolloutView } from './views.js';

function k8sPod(container: Partial<V1ContainerStatus> | undefined, ready: boolean, extra: Partial<V1Pod['metadata']> = {}): V1Pod {
  return {
    metadata: {
      name: 'target-abc-1',
      labels: { 'rollouts-pod-template-hash': 'abc' },
      creationTimestamp: new Date('2026-01-01T00:00:00Z'),
      ...extra,
    },
    spec: { containers: [{ name: 'target', image: 'resilience-playground/target:v1' }] },
    status: {
      podIP: '10.0.0.5',
      conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }],
      containerStatuses: container
        ? [{ name: 'target', image: '', imageID: '', ready, restartCount: 0, started: true, ...container }]
        : undefined,
    },
  };
}

describe('toPodView', () => {
  const serving = new Set(['10.0.0.5']);

  it('describes a ready, serving, stable pod', () => {
    const view = toPodView(k8sPod({ state: { running: {} } }, true), 'abc', serving);
    assert.equal(view.state, 'ready');
    assert.equal(view.inService, true);
    assert.equal(view.role, 'stable');
    assert.equal(view.version, 'v1');
    assert.equal(view.hash, 'abc');
  });

  it('maps container status to a pod state', () => {
    const state = (c: Partial<V1ContainerStatus> | undefined, ready = false, meta = {}) =>
      toPodView(k8sPod(c, ready, meta), 'abc', serving).state;

    assert.equal(state(undefined), 'pending');
    assert.equal(state({ state: { waiting: { reason: 'ContainerCreating' } }, started: false }), 'pending');
    assert.equal(state({ state: { running: {} }, started: false }), 'starting');
    assert.equal(state({ state: { running: {} } }), 'not-ready');
    assert.equal(state({ state: { terminated: { exitCode: 1 } } }), 'crashed');
    assert.equal(state({ state: { waiting: { reason: 'CrashLoopBackOff' } }, restartCount: 2 }), 'crashed');
    assert.equal(state({ state: { running: {} } }, true, { deletionTimestamp: new Date() }), 'terminating');
  });

  it('marks a pod from another ReplicaSet as a canary, and one outside the Service as not serving', () => {
    const view = toPodView(k8sPod({ state: { running: {} } }, false), 'other', new Set());
    assert.equal(view.role, 'canary');
    assert.equal(view.inService, false);
  });
});

describe('helpers', () => {
  it('reads the tag from an image reference', () => {
    assert.equal(imageTag('resilience-playground/target:v2-broken'), 'v2-broken');
    assert.equal(imageTag('ghcr.io/someone/target:v1'), 'v1');
    assert.equal(imageTag('localhost:5000/target'), 'latest');
  });

  it('collects only ready endpoint addresses', () => {
    const ips = servingIps([
      {
        addressType: 'IPv4',
        endpoints: [
          { addresses: ['10.0.0.1'], conditions: { ready: true } },
          { addresses: ['10.0.0.2'], conditions: { ready: false } },
          { addresses: ['10.0.0.3'] },
        ],
      },
    ]);
    assert.deepEqual([...ips].sort(), ['10.0.0.1', '10.0.0.3']);
  });

  it('reads an aborted Rollout', () => {
    const view = toRolloutView({
      spec: {
        template: { spec: { containers: [{ image: 'resilience-playground/target:v2-broken' }] } },
        strategy: { canary: { steps: [{}, {}] } },
      },
      status: { phase: 'Degraded', abort: true, stableRS: 'abc', currentStepIndex: 0, readyReplicas: 3 },
    });
    assert.equal(view.aborted, true);
    assert.equal(view.phase, 'Degraded');
    assert.equal(view.stableHash, 'abc');
    assert.equal(view.stepCount, 2);
    assert.equal(view.image, 'resilience-playground/target:v2-broken');
  });

  it('tolerates a Rollout with no status yet', () => {
    const view = toRolloutView({});
    assert.equal(view.phase, 'Unknown');
    assert.equal(view.aborted, false);
  });
});

describe('displayVersion', () => {
  it('strips a trailing commit id', () => {
    assert.equal(displayVersion('ghcr.io/cd-chief/resilience-playground/target:v2-broken-1a2b3c4'), 'v2-broken');
    assert.equal(displayVersion('ghcr.io/cd-chief/resilience-playground/target:v1-abcdef0'), 'v1');
  });
  it('leaves local tags unchanged', () => {
    assert.equal(displayVersion('resilience-playground/target:v1'), 'v1');
  });
  it('leaves uppercase suffixes unchanged', () => {
    assert.equal(displayVersion('ghcr.io/cd-chief/resilience-playground/target:v1-ABCDEF0'), 'v1-ABCDEF0');
  });
});
