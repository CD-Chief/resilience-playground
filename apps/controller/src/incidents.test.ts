import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IncidentTracker } from './incidents.js';
import { BROKEN_IMAGE, STABLE_IMAGE, healthy, pod, rollout, withPod } from './testing.js';
import type { Incident, StepKey } from './types.js';

const at = (incident: Incident, key: StepKey) => incident.steps.find((s) => s.key === key)?.at;

describe('crash-pod incident', () => {
  it('goes detected, mitigated, recovered as the container dies and comes back', () => {
    const tracker = new IncidentTracker(120_000);
    const incident = tracker.start({ fault: 'crash-pod', pod: 'a', restarts: 0 }, 'crash', 1000);
    assert.equal(at(incident, 'injected'), 1000);

    assert.deepEqual(tracker.observe(healthy(), 1100).transitions, []);

    const down = withPod(healthy(), 'a', { ready: false, inService: false, state: 'crashed' });
    assert.deepEqual(tracker.observe(down, 1500).transitions.map((t) => t.step), ['detected']);

    const restarting = withPod(healthy(), 'a', { ready: false, inService: false, state: 'starting', restarts: 1 });
    assert.deepEqual(tracker.observe(restarting, 2000).transitions.map((t) => t.step), ['mitigated']);
    assert.equal(incident.status, 'active');

    const back = withPod(healthy(), 'a', { restarts: 1 });
    assert.deepEqual(tracker.observe(back, 6000).transitions.map((t) => t.step), ['recovered']);
    assert.equal(incident.status, 'recovered');
    assert.equal(incident.recoveryMs, 5000);
    assert.equal(at(incident, 'detected'), 1500);
    assert.equal(at(incident, 'mitigated'), 2000);
  });

  it('fills in every step when the restart is seen in a single update', () => {
    const tracker = new IncidentTracker(120_000);
    const incident = tracker.start({ fault: 'crash-pod', pod: 'a', restarts: 2 }, 'crash', 0);
    const result = tracker.observe(withPod(healthy(), 'a', { restarts: 3 }), 4000);
    assert.deepEqual(result.transitions.map((t) => t.step), ['detected', 'mitigated', 'recovered']);
    assert.equal(incident.recoveryMs, 4000);
  });

  it('is not recovered by a pod that was ready all along', () => {
    const tracker = new IncidentTracker(120_000);
    const incident = tracker.start({ fault: 'crash-pod', pod: 'a', restarts: 0 }, 'crash', 0);
    tracker.observe(healthy(), 5000);
    assert.equal(incident.status, 'active');
  });
});

describe('fail-readiness incident', () => {
  it('recovers only after the pod has left and rejoined the Service', () => {
    const tracker = new IncidentTracker(120_000);
    const incident = tracker.start({ fault: 'fail-readiness', pod: 'b', seconds: 45 }, 'unready', 0);

    tracker.observe(healthy(), 1000);
    assert.equal(at(incident, 'detected'), undefined);

    const notReady = withPod(healthy(), 'b', { ready: false, state: 'not-ready' });
    assert.deepEqual(tracker.observe(notReady, 4000).transitions.map((t) => t.step), ['detected']);

    const removed = withPod(notReady, 'b', { inService: false });
    assert.deepEqual(tracker.observe(removed, 4200).transitions.map((t) => t.step), ['mitigated']);

    // Ready again, but the Service has not caught up yet.
    tracker.observe(withPod(healthy(), 'b', { inService: false }), 46_000);
    assert.equal(incident.status, 'active');

    assert.deepEqual(tracker.observe(healthy(), 47_000).transitions.map((t) => t.step), ['recovered']);
    assert.equal(incident.recoveryMs, 47_000);
  });
});

describe('bad-deploy incident', () => {
  const context = { fault: 'bad-deploy', brokenImage: BROKEN_IMAGE, restoreImage: STABLE_IMAGE } as const;
  const canary = pod('x', { image: BROKEN_IMAGE, version: 'v2-broken', role: 'canary', hash: 'new', ready: false, inService: false, state: 'not-ready' });
  const releasing = rollout({ phase: 'Progressing', image: BROKEN_IMAGE, step: 0 });
  const aborted = rollout({ phase: 'Degraded', image: BROKEN_IMAGE, aborted: true, step: 0 });

  it('detects the unready canary, restores the image on abort, then recovers', () => {
    const tracker = new IncidentTracker(120_000);
    const incident = tracker.start(context, 'bad deploy', 0);

    const starting = { pods: [...healthy().pods, { ...canary, state: 'starting' as const }], rollout: releasing, analysis: null };
    assert.deepEqual(tracker.observe(starting, 1000).transitions, []);

    const failing = { pods: [...healthy().pods, canary], rollout: releasing, analysis: null };
    const detected = tracker.observe(failing, 4000);
    assert.deepEqual(detected.transitions.map((t) => t.step), ['detected']);
    assert.deepEqual(detected.effects, []);

    const abortedState = { pods: [...healthy().pods, { ...canary, state: 'terminating' as const }], rollout: aborted, analysis: null };
    const mitigated = tracker.observe(abortedState, 30_000);
    assert.deepEqual(mitigated.transitions.map((t) => t.step), ['mitigated']);
    assert.deepEqual(mitigated.effects, [{ type: 'restore-image', image: STABLE_IMAGE }]);

    // The restore is asked for once only.
    assert.deepEqual(tracker.observe(abortedState, 30_500).effects, []);
    assert.equal(incident.status, 'active');

    const recovered = tracker.observe(healthy(), 33_000);
    assert.deepEqual(recovered.transitions.map((t) => t.step), ['recovered']);
    assert.equal(incident.recoveryMs, 33_000);
  });

  it('does not treat the healthy Rollout from before the release as recovery', () => {
    const tracker = new IncidentTracker(120_000);
    const incident = tracker.start(context, 'bad deploy', 0);
    tracker.observe(healthy(), 500);
    assert.equal(incident.status, 'active');
    assert.equal(at(incident, 'detected'), undefined);
  });

  it('restores the image if the incident times out first', () => {
    const tracker = new IncidentTracker(60_000);
    const incident = tracker.start(context, 'bad deploy', 0);
    const stuck = { pods: [...healthy().pods, canary], rollout: releasing, analysis: null };
    tracker.observe(stuck, 5000);
    const result = tracker.observe(stuck, 61_000);
    assert.deepEqual(result.transitions.map((t) => t.step), ['timed-out']);
    assert.deepEqual(result.effects, [{ type: 'restore-image', image: STABLE_IMAGE }]);
    assert.equal(incident.status, 'timed-out');
  });
});

describe('tracker bookkeeping', () => {
  it('reports active faults and targeted pods, and frees them on recovery', () => {
    const tracker = new IncidentTracker(120_000);
    tracker.start({ fault: 'crash-pod', pod: 'a', restarts: 0 }, 'crash', 0);
    assert.equal(tracker.isActive('crash-pod'), true);
    assert.equal(tracker.isActive('fail-readiness'), false);
    assert.deepEqual([...tracker.targetedPods()], ['a']);

    tracker.observe(withPod(healthy(), 'a', { restarts: 1 }), 1000);
    assert.equal(tracker.isActive('crash-pod'), false);
    assert.deepEqual([...tracker.targetedPods()], []);
  });

  it('times out an incident that never recovers', () => {
    const tracker = new IncidentTracker(10_000);
    const incident = tracker.start({ fault: 'crash-pod', pod: 'gone', restarts: 0 }, 'crash', 0);
    assert.deepEqual(tracker.observe(healthy(), 10_001).transitions.map((t) => t.step), ['timed-out']);
    assert.equal(incident.status, 'timed-out');
    assert.equal(incident.recoveryMs, undefined);
  });

  it('keeps the newest 20 incidents, newest first', () => {
    const tracker = new IncidentTracker(120_000);
    for (let i = 0; i < 25; i++) {
      tracker.start({ fault: 'crash-pod', pod: 'a', restarts: i }, 'crash', i);
      tracker.observe(withPod(healthy(), 'a', { restarts: i + 1 }), i);
    }
    const list = tracker.list();
    assert.equal(list.length, 20);
    assert.equal(list[0]!.id, 'inc-25');
    assert.equal(list[19]!.id, 'inc-6');
  });
});
