import { EventLog } from './components/EventLog';
import { FaultButtons } from './components/FaultButtons';
import { Graphs } from './components/Graphs';
import { IncidentPanel } from './components/IncidentPanel';
import { PodGrid } from './components/PodGrid';
import { useServerNow, useStream } from './useStream';

export function App() {
  const { snapshot, log, metrics, connected, clockOffset } = useStream();
  const now = useServerNow(clockOffset);

  const rollout = snapshot?.rollout ?? null;
  const targeted = new Set(
    (snapshot?.incidents ?? []).filter((i) => i.status === 'active' && i.pod).map((i) => i.pod!),
  );

  return (
    <div className="page">
      <header className="header">
        <div>
          <h1>Resilience Playground</h1>
          <p className="tagline">
            Break a live Kubernetes cluster on purpose, then watch it heal itself.
          </p>
        </div>
        <div className="status">
          <span className={`pill ${connected ? 'pill-ok' : 'pill-bad'}`}>
            <span className="dot" />
            {connected ? 'Live' : 'Reconnecting…'}
          </span>
          {snapshot && (
            <span className="pill">
              {snapshot.watchers} watching
            </span>
          )}
          {rollout && (
            <span className={`pill ${rollout.phase === 'Healthy' ? 'pill-ok' : 'pill-warn'}`}>
              Rollout: {rollout.phase}
            </span>
          )}
        </div>
      </header>

      {!snapshot ? (
        <p className="empty">Connecting to the cluster…</p>
      ) : (
        <main className="layout">
          <section className="panel area-pods">
            <h2>
              Pods
              <span className="count">
                {snapshot.pods.filter((p) => p.inService).length} of {snapshot.pods.length} serving traffic
              </span>
            </h2>
            <PodGrid pods={snapshot.pods} targeted={targeted} />
          </section>

          <section className="panel area-graphs">
            <h2>
              Traffic
              <span className="count">last 10 minutes, as the load generator saw it</span>
            </h2>
            <Graphs metrics={metrics} incidents={snapshot.incidents} />
          </section>

          <section className="panel area-faults">
            <h2>Inject a fault</h2>
            <FaultButtons faults={snapshot.faults} now={now} />
          </section>

          <section className="panel area-incident">
            <h2>Incidents</h2>
            <IncidentPanel incidents={snapshot.incidents} now={now} />
          </section>

          <section className="panel area-log">
            <h2>Event log</h2>
            <EventLog entries={log} />
          </section>
        </main>
      )}
    </div>
  );
}
