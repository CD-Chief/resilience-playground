import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { memoryStore, openStore, type IncidentStore } from './store.js';
import type { Incident } from './types.js';

function incident(id: string, startedAt: number, overrides: Partial<Incident> = {}): Incident {
  return {
    id,
    fault: 'crash-pod',
    pod: 'a',
    status: 'recovered',
    startedAt,
    endedAt: startedAt + 5000,
    recoveryMs: 5000,
    steps: [{ key: 'injected', at: startedAt, detail: 'crash' }, { key: 'detected' }, { key: 'mitigated' }, { key: 'recovered' }],
    ...overrides,
  };
}

const stores: [string, () => IncidentStore][] = [
  ['sqlite store', () => openStore(':memory:')],
  ['memory store', () => memoryStore()],
];

for (const [name, make] of stores) {
  describe(name, () => {
    it('returns what was saved, newest first', () => {
      const store = make();
      const older = incident('inc-1', 1000);
      const newer = incident('inc-2', 2000, { failedRequests: 7 });
      store.save(older);
      store.save(newer);
      assert.deepEqual(store.load(10), [newer, older]);
      assert.deepEqual(store.load(1), [newer]);
    });

    it('replaces an incident saved twice with the same id', () => {
      const store = make();
      store.save(incident('inc-1', 1000, { status: 'active' }));
      store.save(incident('inc-1', 1000, { status: 'recovered' }));
      const loaded = store.load(10);
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0]!.status, 'recovered');
    });

    it('prunes to the newest N by startedAt', () => {
      const store = make();
      store.save(incident('inc-2', 2000));
      store.save(incident('inc-1', 1000));
      store.save(incident('inc-3', 3000));
      store.prune(2);
      assert.deepEqual(store.load(10).map((i) => i.id), ['inc-3', 'inc-2']);
    });

    it('round-trips quotes and SQL text unchanged', () => {
      const store = make();
      const nasty = incident("inc-1'; DROP TABLE incidents; --", 1000, {
        steps: [{ key: 'injected', at: 1000, detail: `it's "quoted"'; DROP TABLE incidents; --` }],
      });
      store.save(nasty);
      store.save(incident('inc-2', 2000));
      assert.deepEqual(store.load(10).map((i) => i.id), ['inc-2', nasty.id]);
      assert.deepEqual(store.load(10)[1], nasty);
    });
  });
}
