import { DatabaseSync } from 'node:sqlite';
import type { Incident } from './types.js';

export interface IncidentStore {
  /** Newest first, at most `limit`. */
  load(limit: number): Incident[];
  /** Insert or replace by id. */
  save(incident: Incident): void;
  /** Delete all but the newest `keep` incidents (by startedAt). */
  prune(keep: number): void;
  close(): void;
}

/** SQLite file, or ':memory:'. The incident is stored whole as JSON: it is only ever read back whole. */
export function openStore(path: string): IncidentStore {
  const db = new DatabaseSync(path);
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS incidents (
      id TEXT PRIMARY KEY,
      started_at INTEGER NOT NULL,
      body TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS incidents_started_at ON incidents (started_at);
  `);
  const selectNewest = db.prepare('SELECT body FROM incidents ORDER BY started_at DESC, rowid DESC LIMIT ?');
  const upsert = db.prepare('INSERT OR REPLACE INTO incidents (id, started_at, body) VALUES (?, ?, ?)');
  const deleteOld = db.prepare(
    `DELETE FROM incidents WHERE id NOT IN (
       SELECT id FROM incidents ORDER BY started_at DESC, rowid DESC LIMIT ?
     )`,
  );

  return {
    load: (limit) => selectNewest.all(limit).map((row) => JSON.parse(String(row.body)) as Incident),
    save: (incident) => {
      upsert.run(incident.id, incident.startedAt, JSON.stringify(incident));
    },
    prune: (keep) => {
      deleteOld.run(keep);
    },
    close: () => db.close(),
  };
}

/** No persistence; used when no database path is configured. */
export function memoryStore(): IncidentStore {
  let items: Incident[] = [];
  const newestFirst = (a: Incident, b: Incident): number => b.startedAt - a.startedAt;
  return {
    load: (limit) => items.slice(0, limit).map((i) => structuredClone(i)),
    save: (incident) => {
      items = [structuredClone(incident), ...items.filter((i) => i.id !== incident.id)].sort(newestFirst);
    },
    prune: (keep) => {
      items = items.slice(0, keep);
    },
    close: () => {},
  };
}

/**
 * Wraps a store so a failed write is reported instead of thrown. Writes happen
 * inside cluster-watch callbacks, where an exception would take the whole
 * controller down; losing one history write is the lesser harm.
 */
export function failSoft(store: IncidentStore, onError: (err: unknown) => void): IncidentStore {
  const guard =
    <A extends unknown[]>(fn: (...args: A) => void) =>
    (...args: A): void => {
      try {
        fn(...args);
      } catch (err) {
        onError(err);
      }
    };
  return {
    load: (limit) => store.load(limit),
    save: guard(store.save),
    prune: guard(store.prune),
    close: guard(store.close),
  };
}
