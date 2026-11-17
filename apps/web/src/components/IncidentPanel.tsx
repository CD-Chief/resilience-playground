import type { FaultId, Incident, StepKey } from '../types';

const FAULT_LABEL: Record<FaultId, string> = {
  'crash-pod': 'Pod crash',
  'fail-readiness': 'Readiness failure',
  'bad-deploy': 'Bad deploy',
  'flaky-deploy': 'Flaky deploy',
};

const STEP_LABEL: Record<StepKey, string> = {
  injected: 'Fault injected',
  detected: 'Detected',
  mitigated: 'Mitigated',
  recovered: 'Recovered',
};

const seconds = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(1)}s`;

function shortPod(name: string | undefined): string {
  return name ? name.slice(name.lastIndexOf('-') + 1) : '';
}

/** Time from injection to a step, or a dash while it has not happened. */
function since(incident: Incident, key: StepKey): string {
  const at = incident.steps.find((s) => s.key === key)?.at;
  return at === undefined ? '–' : seconds(at - incident.startedAt);
}

function Timeline({ incident, now }: { incident: Incident; now: number }) {
  const active = incident.status === 'active';
  const elapsed = (incident.endedAt ?? now) - incident.startedAt;

  return (
    <article className={`incident incident-${incident.status}`}>
      <header className="incident-head">
        <div>
          <span className="incident-title">{FAULT_LABEL[incident.fault]}</span>
          {incident.pod && <span className="incident-pod">pod {shortPod(incident.pod)}</span>}
        </div>
        <div className="timer">
          <span className="timer-value">{seconds(incident.recoveryMs ?? elapsed)}</span>
          <span className="timer-label">
            {active ? 'recovering' : incident.status === 'recovered' ? 'time to recover' : 'timed out'}
          </span>
        </div>
      </header>
      <dl className="measures">
        <div>
          <dt>Time to detect</dt>
          <dd>{since(incident, 'detected')}</dd>
        </div>
        <div>
          <dt>Time to mitigate</dt>
          <dd>{since(incident, 'mitigated')}</dd>
        </div>
        <div>
          <dt>Failed requests</dt>
          <dd className={incident.failedRequests ? 'measure-bad' : undefined}>{incident.failedRequests ?? '–'}</dd>
        </div>
      </dl>
      <ol className="steps">
        {incident.steps.map((step) => {
          const done = step.at !== undefined;
          return (
            <li key={step.key} className={`step ${done ? 'step-done' : 'step-waiting'} step-${step.key}`}>
              <span className="step-marker" />
              <div className="step-body">
                <div className="step-line">
                  <span className="step-label">{STEP_LABEL[step.key]}</span>
                  <span className="step-time">{done ? `+${seconds(step.at! - incident.startedAt)}` : 'waiting'}</span>
                </div>
                {step.detail && <p className="step-detail">{step.detail}</p>}
              </div>
            </li>
          );
        })}
      </ol>
    </article>
  );
}

export function IncidentPanel({ incidents, now }: { incidents: Incident[]; now: number }) {
  if (incidents.length === 0) {
    return <p className="empty">Nothing has gone wrong yet. Inject a fault to start an incident.</p>;
  }

  const active = incidents.filter((i) => i.status === 'active');
  // With nothing in progress, keep the latest incident on show.
  const shown = active.length > 0 ? active : incidents.slice(0, 1);
  const history = incidents.filter((i) => !shown.includes(i));

  return (
    <div className="incidents">
      {shown.map((incident) => (
        <Timeline key={incident.id} incident={incident} now={now} />
      ))}
      {history.length > 0 && (
        <table className="history">
          <caption>Earlier incidents</caption>
          <tbody>
            {history.map((incident) => (
              <tr key={incident.id}>
                <td>{FAULT_LABEL[incident.fault]}</td>
                <td className="muted">{shortPod(incident.pod)}</td>
                <td className="history-failed">
                  {incident.failedRequests === undefined ? '' : `${incident.failedRequests} failed`}
                </td>
                <td className={`history-result history-${incident.status}`}>
                  {incident.recoveryMs !== undefined ? `recovered in ${seconds(incident.recoveryMs)}` : 'timed out'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
