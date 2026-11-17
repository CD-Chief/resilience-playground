import type { MetricsView } from './types.js';

const WINDOW_SECONDS = 600;
const STEP_SECONDS = 5;

// All three graphs are drawn from the load generator's numbers, so they show
// what a caller experienced, including requests that never reached a pod.
const QUERIES = {
  rps: 'sum(rate(loadgen_requests_total[20s]))',
  successRate:
    '100 * sum(rate(loadgen_requests_total{result="ok"}[20s])) / sum(rate(loadgen_requests_total[20s]))',
  p95Ms:
    '1000 * histogram_quantile(0.95, sum by (le) (rate(loadgen_request_duration_seconds_bucket[20s])))',
};
const FAILED_TOTAL = 'sum(loadgen_requests_total{result="failed"})';

interface RangeResponse {
  status: string;
  data?: { result?: { values?: [number, string][] }[] };
}

interface InstantResponse {
  status: string;
  data?: { result?: { value?: [number, string] }[] };
}

/** Read-only queries against the in-cluster Prometheus. */
export class Prometheus {
  constructor(
    private readonly baseUrl: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async get<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = `${this.baseUrl}${path}?${new URLSearchParams(params)}`;
    const res = await this.fetcher(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`Prometheus answered ${res.status}`);
    return (await res.json()) as T;
  }

  /** The last ten minutes of each graph, on a shared time axis. */
  async graphs(nowMs: number): Promise<MetricsView> {
    // Aligned to the step so every query, and every refresh, shares timestamps.
    const end = Math.floor(nowMs / 1000 / STEP_SECONDS) * STEP_SECONDS;
    const start = end - WINDOW_SECONDS;
    const timestamps: number[] = [];
    for (let t = start; t <= end; t += STEP_SECONDS) timestamps.push(t * 1000);

    const series = async (query: string): Promise<(number | null)[]> => {
      const body = await this.get<RangeResponse>('/api/v1/query_range', {
        query,
        start: String(start),
        end: String(end),
        step: String(STEP_SECONDS),
      });
      const byTime = new Map<number, number>();
      for (const [t, raw] of body.data?.result?.[0]?.values ?? []) {
        const value = Number(raw);
        if (Number.isFinite(value)) byTime.set(t * 1000, value);
      }
      return timestamps.map((t) => byTime.get(t) ?? null);
    };

    const [rps, successRate, p95Ms] = await Promise.all([
      series(QUERIES.rps),
      series(QUERIES.successRate),
      series(QUERIES.p95Ms),
    ]);
    return { timestamps, rps, successRate, p95Ms };
  }

  /** Failed requests counted by the load generator since it started. */
  async failedTotal(): Promise<number | null> {
    const body = await this.get<InstantResponse>('/api/v1/query', { query: FAILED_TOTAL });
    const raw = body.data?.result?.[0]?.value?.[1];
    const value = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(value) ? value : null;
  }
}
