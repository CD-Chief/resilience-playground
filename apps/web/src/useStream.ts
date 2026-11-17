import { useEffect, useState } from 'react';
import type { LogEntry, Snapshot } from './types';

const LOG_LIMIT = 200;

export interface Stream {
  snapshot: Snapshot | null;
  log: LogEntry[];
  connected: boolean;
  /** Add to Date.now() to get the server's clock. */
  clockOffset: number;
}

/** Subscribes to the controller's event stream. The browser reconnects by itself. */
export function useStream(): Stream {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [clockOffset, setClockOffset] = useState(0);

  useEffect(() => {
    const source = new EventSource('/api/stream');
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);

    source.addEventListener('state', (event) => {
      const next = JSON.parse((event as MessageEvent<string>).data) as Snapshot;
      setSnapshot(next);
      setClockOffset(next.now - Date.now());
    });
    // Sent once per connection, so it replaces whatever was shown before.
    source.addEventListener('backlog', (event) => {
      setLog(JSON.parse((event as MessageEvent<string>).data) as LogEntry[]);
    });
    source.addEventListener('log', (event) => {
      const entry = JSON.parse((event as MessageEvent<string>).data) as LogEntry;
      setLog((current) => [...current, entry].slice(-LOG_LIMIT));
    });

    return () => source.close();
  }, []);

  return { snapshot, log, connected, clockOffset };
}

/** The server's current time, refreshed several times a second for countdowns. */
export function useServerNow(clockOffset: number): number {
  const [now, setNow] = useState(() => Date.now() + clockOffset);
  useEffect(() => {
    const tick = () => setNow(Date.now() + clockOffset);
    tick();
    const timer = setInterval(tick, 200);
    return () => clearInterval(timer);
  }, [clockOffset]);
  return now;
}
