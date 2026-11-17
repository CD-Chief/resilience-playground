import type { PodState, PodView } from '../types';

const STATE_LABEL: Record<PodState, string> = {
  ready: 'Ready',
  'not-ready': 'Not ready',
  starting: 'Starting',
  crashed: 'Crashed',
  pending: 'Pending',
  terminating: 'Terminating',
};

/** "target-7d49d86784-kwd66" -> "kwd66": the part that tells pods apart. */
function shortName(name: string): string {
  return name.slice(name.lastIndexOf('-') + 1);
}

export function PodGrid({ pods, targeted }: { pods: PodView[]; targeted: Set<string> }) {
  if (pods.length === 0) return <p className="empty">No pods yet.</p>;

  return (
    <div className="pod-grid">
      {pods.map((pod) => (
        <article
          key={pod.name}
          className={`pod pod-${pod.state} ${targeted.has(pod.name) ? 'pod-targeted' : ''}`}
          title={pod.name}
        >
          <div className="pod-top">
            <span className="pod-name">{shortName(pod.name)}</span>
            {pod.role === 'canary' && <span className="badge">canary</span>}
          </div>
          <div className="pod-state">{STATE_LABEL[pod.state]}</div>
          <div className="pod-traffic">{pod.inService ? 'Receiving traffic' : 'Out of the Service'}</div>
          <dl className="pod-meta">
            <div>
              <dt>Version</dt>
              <dd>{pod.version}</dd>
            </div>
            <div>
              <dt>Restarts</dt>
              <dd key={pod.restarts} className={pod.restarts > 0 ? 'bump' : undefined}>
                {pod.restarts}
              </dd>
            </div>
          </dl>
        </article>
      ))}
    </div>
  );
}
