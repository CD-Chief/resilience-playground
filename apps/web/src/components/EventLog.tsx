import type { LogEntry } from '../types';

const time = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

export function EventLog({ entries }: { entries: LogEntry[] }) {
  if (entries.length === 0) {
    return <p className="empty">Quiet so far. Cluster events will appear here as they happen.</p>;
  }

  // Newest first, so the latest event is always in view.
  const newestFirst = [...entries].reverse();

  return (
    <ul className="log" aria-live="polite">
      {newestFirst.map((entry) => (
        <li key={entry.id} className={`log-row log-${entry.source} log-${entry.level}`}>
          <time className="log-time">{time.format(entry.ts)}</time>
          <span className="log-source">{entry.source === 'controller' ? 'controller' : 'k8s'}</span>
          <span className="log-text">
            <span className="log-reason">{entry.reason}</span>
            {entry.object && <span className="log-object">{entry.object}</span>}
            <span className="log-message">{entry.message}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
