import { useState } from 'react';
import type { Incident, MetricsView } from '../types';

const WIDTH = 320;
const HEIGHT = 120;
const PAD = { top: 8, right: 8, bottom: 18, left: 34 };
const PLOT_W = WIDTH - PAD.left - PAD.right;
const PLOT_H = HEIGHT - PAD.top - PAD.bottom;

interface ChartSpec {
  key: 'rps' | 'successRate' | 'p95Ms';
  title: string;
  /** How a value reads in the header and tooltip. */
  format: (value: number) => string;
  /** The y-axis range for the values on show. */
  domain: (values: number[]) => [number, number];
}

const CHARTS: ChartSpec[] = [
  {
    key: 'rps',
    title: 'Requests per second',
    format: (v) => v.toFixed(1),
    domain: (values) => [0, Math.max(12, Math.ceil(Math.max(...values) / 4) * 4)],
  },
  {
    key: 'successRate',
    title: 'Success rate',
    format: (v) => `${v.toFixed(v >= 99.95 ? 0 : 1)}%`,
    // Zoomed in on the top of the scale, widening only as far as the worst dip.
    domain: (values) => [Math.min(90, Math.floor(Math.min(...values) / 10) * 10), 100],
  },
  {
    key: 'p95Ms',
    title: 'p95 latency',
    format: (v) => `${v.toFixed(0)} ms`,
    domain: (values) => [0, Math.max(50, Math.ceil(Math.max(...values) / 50) * 50)],
  },
];

const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

function Chart({
  spec,
  metrics,
  incidents,
  hover,
  onHover,
}: {
  spec: ChartSpec;
  metrics: MetricsView;
  incidents: Incident[];
  hover: number | null;
  onHover: (index: number | null) => void;
}) {
  const { timestamps } = metrics;
  const series = metrics[spec.key];
  const present = series.filter((v): v is number => v !== null);
  const start = timestamps[0]!;
  const end = timestamps[timestamps.length - 1]!;
  const [low, high] = present.length > 0 ? spec.domain(present) : [0, 1];

  const x = (t: number) => PAD.left + ((t - start) / (end - start)) * PLOT_W;
  const y = (v: number) => PAD.top + (1 - (v - low) / (high - low || 1)) * PLOT_H;

  // One path, lifted off the page wherever a sample is missing.
  let path = '';
  let drawing = false;
  series.forEach((value, i) => {
    if (value === null) {
      drawing = false;
      return;
    }
    path += `${drawing ? 'L' : 'M'}${x(timestamps[i]!).toFixed(1)},${y(value).toFixed(1)}`;
    drawing = true;
  });

  const latest = present[present.length - 1];
  const shown = hover !== null ? series[hover] : latest;
  const bands = incidents
    .map((incident) => ({ id: incident.id, from: Math.max(incident.startedAt, start), to: Math.min(incident.endedAt ?? end, end) }))
    .filter((band) => band.to > band.from);

  function pointer(event: React.PointerEvent<SVGRectElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    onHover(Math.round(ratio * (timestamps.length - 1)));
  }

  return (
    <figure className="chart">
      <figcaption>
        <span className="chart-title">{spec.title}</span>
        <span className="chart-value">{shown === null || shown === undefined ? '–' : spec.format(shown)}</span>
      </figcaption>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={`${spec.title} over the last ten minutes`}>
        {bands.map((band) => (
          <rect key={band.id} className="chart-incident" x={x(band.from)} y={PAD.top} width={Math.max(1.5, x(band.to) - x(band.from))} height={PLOT_H} />
        ))}
        <line className="chart-grid" x1={PAD.left} x2={WIDTH - PAD.right} y1={y(high)} y2={y(high)} />
        <line className="chart-grid" x1={PAD.left} x2={WIDTH - PAD.right} y1={y((low + high) / 2)} y2={y((low + high) / 2)} />
        <line className="chart-axis" x1={PAD.left} x2={WIDTH - PAD.right} y1={y(low)} y2={y(low)} />
        <text className="chart-tick" x={PAD.left - 5} y={y(high) + 3} textAnchor="end">{high}</text>
        <text className="chart-tick" x={PAD.left - 5} y={y(low) + 3} textAnchor="end">{low}</text>
        <text className="chart-tick" x={PAD.left} y={HEIGHT - 4}>10 min ago</text>
        <text className="chart-tick" x={WIDTH - PAD.right} y={HEIGHT - 4} textAnchor="end">now</text>

        <path className="chart-line" d={path} />

        {hover !== null && (
          <>
            <line className="chart-crosshair" x1={x(timestamps[hover]!)} x2={x(timestamps[hover]!)} y1={PAD.top} y2={PAD.top + PLOT_H} />
            {series[hover] !== null && series[hover] !== undefined && (
              <circle className="chart-dot" cx={x(timestamps[hover]!)} cy={y(series[hover]!)} r={4} />
            )}
          </>
        )}
        <rect
          className="chart-hit"
          x={PAD.left}
          y={PAD.top}
          width={PLOT_W}
          height={PLOT_H}
          onPointerMove={pointer}
          onPointerDown={pointer}
          onPointerLeave={() => onHover(null)}
        />
      </svg>
    </figure>
  );
}

export function Graphs({ metrics, incidents }: { metrics: MetricsView | null; incidents: Incident[] }) {
  // Shared by all three charts, so one pointer reads the same moment on each.
  const [hover, setHover] = useState<number | null>(null);

  if (!metrics) {
    return <p className="empty">Waiting for the first measurements from Prometheus…</p>;
  }

  return (
    <div>
      <div className="charts">
        {CHARTS.map((spec) => (
          <Chart key={spec.key} spec={spec} metrics={metrics} incidents={incidents} hover={hover} onHover={setHover} />
        ))}
      </div>
      <p className="chart-note">
        <span className="chart-swatch" /> Shaded bands are incidents.{' '}
        {hover !== null ? `Showing ${clock.format(metrics.timestamps[hover]!)}.` : 'Hover a graph to read a moment in time.'}
      </p>
    </div>
  );
}
