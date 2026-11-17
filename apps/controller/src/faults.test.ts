import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { config as baseConfig, type Config } from './config.js';
import { FaultService, type FaultActions } from './faults.js';
import { IncidentTracker } from './incidents.js';
import { BROKEN_IMAGE, STABLE_IMAGE, healthy, pod, rollout, withPod } from './testing.js';
import type { ClusterState } from './types.js';

const config: Config = { ...baseConfig, brokenImage: BROKEN_IMAGE, stableImage: STABLE_IMAGE };

function setup(initial: ClusterState = healthy(), overrides: Partial<FaultActions> = {}) {
  const calls: string[] = [];
  const tracker = new IncidentTracker(120_000);
  const world = { state: initial };
  const actions: FaultActions = {
    crashPod: async (ip) => void calls.push(`crash ${ip}`),
    failReadiness: async (ip, seconds) => void calls.push(`unready ${ip} ${seconds}`),
    setRolloutImage: async (image) => void calls.push(`image ${image}`),
    ...overrides,
  };
  // random() = 0 always picks the first candidate.
  const faults = new FaultService(config, tracker, () => world.state, actions, () => 0);
  return { faults, tracker, calls, world };
}

describe('pod faults', () => {
  it('crashes one serving pod and opens an incident', async () => {
    const { faults, calls } = setup();
    const result = await faults.inject('crash-pod', 1000);
    assert.equal(result.ok, true);
    assert.deepEqual(calls, [`crash ${pod('a').ip}`]);
    if (result.ok) {
      assert.equal(result.incident.pod, 'a');
      assert.equal(result.incident.fault, 'crash-pod');
    }
  });

  it('passes the configured duration to fail-readiness', async () => {
    const { faults, calls } = setup();
    assert.equal((await faults.inject('fail-readiness', 0)).ok, true);
    assert.deepEqual(calls, [`unready ${pod('a').ip} ${config.unreadySeconds}`]);
  });

  it('refuses when too few pods would be left serving', async () => {
    const { faults, calls } = setup(withPod(healthy(), 'c', { ready: false, inService: false }));
    const result = await faults.inject('crash-pod', 0);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 409);
    assert.deepEqual(calls, []);
  });

  it('never targets a canary pod', async () => {
    const state = healthy();
    state.pods.unshift(pod('x', { role: 'canary', hash: 'new' }));
    const { faults, calls } = setup(state);
    await faults.inject('crash-pod', 0);
    assert.deepEqual(calls, [`crash ${pod('a').ip}`]);
  });

  it('reports a failed admin call and does not start a cooldown', async () => {
    let fail = true;
    const { faults, tracker } = setup(healthy(), {
      crashPod: async () => {
        if (fail) throw new Error('connection refused');
      },
    });
    const failed = await faults.inject('crash-pod', 0);
    assert.equal(failed.ok, false);
    if (!failed.ok) assert.equal(failed.status, 502);
    assert.equal(tracker.list().length, 0);

    fail = false;
    assert.equal((await faults.inject('crash-pod', 1)).ok, true);
  });
});

describe('cooldowns and overlap', () => {
  it('refuses the same fault while its incident is active, then while cooling down', async () => {
    const { faults, tracker, world } = setup();
    assert.equal((await faults.inject('crash-pod', 0)).ok, true);

    const whileActive = await faults.inject('crash-pod', 1000);
    assert.equal(whileActive.ok, false);
    if (!whileActive.ok) assert.equal(whileActive.status, 409);

    world.state = withPod(healthy(), 'a', { restarts: 1 });
    tracker.observe(world.state, 5000);

    const cooling = await faults.inject('crash-pod', 10_000);
    assert.equal(cooling.ok, false);
    if (!cooling.ok) {
      assert.equal(cooling.status, 429);
      assert.equal(cooling.retryAfterSeconds, 20);
    }

    assert.equal((await faults.inject('crash-pod', 30_000)).ok, true);
  });

  it('lets only one of two simultaneous requests through', async () => {
    const { faults, calls } = setup();
    const results = await Promise.all([faults.inject('crash-pod', 0), faults.inject('crash-pod', 0)]);
    assert.deepEqual(results.map((r) => r.ok).sort(), [false, true]);
    assert.equal(calls.length, 1);
  });

  it('keeps cooldowns separate per fault', async () => {
    const { faults } = setup();
    assert.equal((await faults.inject('bad-deploy', 0)).ok, true);
    assert.equal((await faults.inject('crash-pod', 0)).ok, true);
  });

  it('shows availability in the fault views', async () => {
    const { faults } = setup();
    await faults.inject('crash-pod', 5000);
    const view = faults.views().find((f) => f.id === 'crash-pod')!;
    assert.equal(view.active, true);
    assert.equal(view.availableAt, 5000 + config.cooldownMs['crash-pod']);
    assert.equal(faults.views().find((f) => f.id === 'bad-deploy')!.active, false);
  });
});

describe('bad deploy', () => {
  it('releases the broken image and remembers the image to go back to', async () => {
    const state = healthy();
    state.rollout = rollout({ image: 'resilience-playground/target:v7' });
    const { faults, tracker, calls } = setup(state);
    assert.equal((await faults.inject('bad-deploy', 0)).ok, true);
    assert.deepEqual(calls, [`image ${BROKEN_IMAGE}`]);

    const aborted = { ...state, rollout: rollout({ phase: 'Degraded', aborted: true, image: BROKEN_IMAGE }) };
    assert.deepEqual(tracker.observe(aborted, 30_000).effects, [
      { type: 'restore-image', image: 'resilience-playground/target:v7' },
    ]);
  });

  it('refuses unless the Rollout is healthy', async () => {
    for (const bad of [null, rollout({ phase: 'Progressing' }), rollout({ image: BROKEN_IMAGE })]) {
      const { faults, calls } = setup({ ...healthy(), rollout: bad });
      const result = await faults.inject('bad-deploy', 0);
      assert.equal(result.ok, false);
      assert.deepEqual(calls, []);
    }
  });
});
