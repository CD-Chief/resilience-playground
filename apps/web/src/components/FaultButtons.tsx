import { useState } from 'react';
import type { FaultId, FaultView } from '../types';

interface Notice {
  fault: FaultId;
  message: string;
}

export function FaultButtons({ faults, now }: { faults: FaultView[]; now: number }) {
  const [pending, setPending] = useState<FaultId | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  async function inject(fault: FaultId) {
    setPending(fault);
    setNotice(null);
    try {
      const res = await fetch(`/api/faults/${fault}`, { method: 'POST' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setNotice({ fault, message: body.error ?? `The controller answered ${res.status}.` });
      }
    } catch {
      setNotice({ fault, message: 'Could not reach the controller.' });
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="faults">
      {faults.map((fault) => {
        const remaining = Math.ceil((fault.availableAt - now) / 1000);
        const cooling = remaining > 0;
        const disabled = fault.active || cooling || pending !== null;
        const total = fault.cooldownSeconds;
        // Shrinks from full to empty over the cooldown.
        const progress = cooling ? Math.min(1, (fault.availableAt - now) / (total * 1000)) : 0;

        let buttonText = fault.label;
        if (fault.active) buttonText = 'Recovering…';
        else if (cooling) buttonText = `Available in ${remaining}s`;

        return (
          <div key={fault.id} className="fault">
            <button type="button" className={`fault-button fault-${fault.id}`} disabled={disabled} onClick={() => inject(fault.id)}>
              <span className="fault-progress" style={{ transform: `scaleX(${progress})` }} />
              <span className="fault-label">{buttonText}</span>
            </button>
            <p className="fault-what">{fault.description}</p>
            <p className="fault-heals">
              <strong>What heals it:</strong> {fault.heals}
            </p>
            {notice?.fault === fault.id && <p className="fault-notice">{notice.message}</p>}
          </div>
        );
      })}
    </div>
  );
}
