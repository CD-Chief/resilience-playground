import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { config as baseConfig } from './config.js';
import { FaultService } from './faults.js';
import { IncidentTracker } from './incidents.js';
import { Prometheus } from './metrics.js';
import { BROKEN_IMAGE, FLAKY_IMAGE, STABLE_IMAGE, healthy, pod, rollout } from './testing.js';
import type { AnalysisView, ClusterState } from './types.js';
import { latestAnalysis } from './views.js';

const context = { fault: 'flaky-deploy', brokenImage: FLAKY_IMAGE, restoreImage: STABLE_IMAGE } as const;
const canary = pod('x', { image: FLAKY_IMAGE, version: 'v2-flaky', role: 'canary', hash: 'new' });
const releasing = rollout({ phase: 'Progressing', image: FLAKY_IMAGE, step: 1 });
const aborted = rollout({ phase: 'Degraded', image: FLAKY_IMAGE, aborted: true, step: 1 });

function analysis(overrides: Partial<AnalysisView>): AnalysisView {
  return { name: 'target-new-2', phase: 'Running', startedAt: 6000, successful: 0, failed: 0, ...overrides };
}

describe('flaky-deploy incident', () => {
  it('is detected by a failed analysis measurement, mitigated by the abort, then recovers', () => {
    const tracker = new IncidentTracker(120_000);
    const incident = tracker.start(context, 'flaky deploy', 0);
    const serving: ClusterState = { pods: [...healthy().pods, canary], rollout: releasing, analysis: analysis({}) };

    // A ready canary taking traffic is not, on its own, a detection.
    assert.deepEqual(tracker.observe(serving, 8000).transitions, []);

    const measured = { ...serving, analysis: analysis({ failed: 1 }) };
    assert.deepEqual(tracker.observe(measured, 17_000).transitions.map((t) => t.step), ['detected']);

    const stopped = { pods: healthy().pods, rollout: aborted, analysis: analysis({ failed: 2, phase: 'Failed' }) };
    const mitigated = tracker.observe(stopped, 22_000);
    assert.deepEqual(mitigated.transitions.map((t) => t.step), ['mitigated']);
    assert.deepEqual(mitigated.effects, [{ type: 'restore-image', image: STABLE_IMAGE }]);

    assert.deepEqual(tracker.observe(healthy(), 25_000).transitions.map((t) => t.step), ['recovered']);
    assert.equal(incident.recoveryMs, 25_000);
  });

  it('ignores a failed analysis left over from an earlier release', () => {
    const tracker = new IncidentTracker(120_000);
    const incident = tracker.start(context, 'flaky deploy', 100_000);
    const stale = analysis({ startedAt: 50_000, failed: 2, phase: 'Failed' });
    tracker.observe({ pods: [...healthy().pods, canary], rollout: releasing, analysis: stale }, 105_000);
    assert.equal(incident.steps.find((s) => s.key === 'detected')?.at, undefined);
  });

  it('records failed requests against the incident', () => {
    const tracker = new IncidentTracker(120_000);
    const incident = tracker.start(context, 'flaky deploy', 0);
    tracker.setFailedRequests(incident.id, 31);
    assert.equal(tracker.list()[0]!.failedRequests, 31);
    tracker.setFailedRequests('inc-unknown', 5);
  });
});

describe('flaky-deploy fault', () => {
  const config = { ...baseConfig, brokenImage: BROKEN_IMAGE, flakyImage: FLAKY_IMAGE, stableImage: STABLE_IMAGE };

  function setup(state: ClusterState) {
    const calls: string[] = [];
    const tracker = new IncidentTracker(120_000);
    const faults = new FaultService(config, tracker, () => state, {
      crashPod: async () => {},
      failReadiness: async () => {},
      setRolloutImage: async (image) => void calls.push(image),
    });
    return { faults, calls };
  }

  it('releases the flaky image', async () => {
    const { faults, calls } = setup(healthy());
    const result = await faults.inject('flaky-deploy', 0);
    assert.equal(result.ok, true);
    assert.deepEqual(calls, [FLAKY_IMAGE]);
  });

  it('is refused while the other deploy fault has the Rollout busy', async () => {
    for (const busy of [rollout({ phase: 'Progressing', image: BROKEN_IMAGE }), rollout({ image: FLAKY_IMAGE })]) {
      const { faults, calls } = setup({ ...healthy(), rollout: busy });
      assert.equal((await faults.inject('flaky-deploy', 0)).ok, false);
      assert.equal((await faults.inject('bad-deploy', 0)).ok, false);
      assert.deepEqual(calls, []);
    }
  });
});

describe('latestAnalysis', () => {
  it('picks the newest run and totals its measurements', () => {
    const view = latestAnalysis([
      { metadata: { name: 'old', creationTimestamp: '2026-01-01T00:00:00Z' }, status: { phase: 'Successful' } },
      {
        metadata: { name: 'new', creationTimestamp: '2026-01-01T00:05:00Z' },
        status: { phase: 'Failed', metricResults: [{ successful: 1, failed: 2 }] },
      },
    ]);
    assert.equal(view?.name, 'new');
    assert.equal(view?.failed, 2);
    assert.equal(view?.successful, 1);
    assert.equal(latestAnalysis([]), null);
  });
});

describe('Prometheus client', () => {
  function fakeFetch(handler: (url: URL) => unknown): typeof fetch {
    return (async (input: string | URL | Request) =>
      new Response(JSON.stringify(handler(new URL(String(input)))), { status: 200 })) as typeof fetch;
  }

  it('lines the three graphs up on one time axis and leaves gaps as null', async () => {
    const prometheus = new Prometheus(
      'http://prometheus:9090',
      fakeFetch((url) => {
        const end = Number(url.searchParams.get('end'));
        const query = url.searchParams.get('query') ?? '';
        // Only the last two points exist; p95 has no data at all.
        const values = query.includes('histogram_quantile')
          ? []
          : [
              [end - 5, '9.8'],
              [end, 'NaN'],
            ];
        return { status: 'success', data: { result: [{ values }] } };
      }),
    );

    const graphs = await prometheus.graphs(1_000_000_500);
    assert.equal(graphs.timestamps.length, 121);
    assert.equal(graphs.timestamps.at(-1), 1_000_000_000);
    assert.equal(graphs.timestamps[1]! - graphs.timestamps[0]!, 5000);
    assert.equal(graphs.rps.at(-2), 9.8);
    assert.equal(graphs.rps.at(-1), null);
    assert.equal(graphs.rps[0], null);
    assert.ok(graphs.p95Ms.every((v) => v === null));
  });

  it('reads the failed-request total, or null when there is none yet', async () => {
    const withValue = new Prometheus('http://p', fakeFetch(() => ({ status: 'success', data: { result: [{ value: [1, '42'] }] } })));
    assert.equal(await withValue.failedTotal(), 42);
    const empty = new Prometheus('http://p', fakeFetch(() => ({ status: 'success', data: { result: [] } })));
    assert.equal(await empty.failedTotal(), null);
  });
});
