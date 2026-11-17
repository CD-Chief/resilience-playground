import { createServer, type Server } from 'node:http';
import { Counter, Histogram, Registry } from 'prom-client';

/**
 * What the traffic looked like from the caller's side. These are the numbers
 * the page graphs: they include requests that never reached a pod at all.
 */
export function createMetrics() {
  const registry = new Registry();

  const requests = new Counter({
    name: 'loadgen_requests_total',
    help: 'Requests sent to the target, by outcome.',
    labelNames: ['result'],
    registers: [registry],
  });
  // Present from the first scrape, so rates and ratios never start from nothing.
  requests.inc({ result: 'ok' }, 0);
  requests.inc({ result: 'failed' }, 0);

  const duration = new Histogram({
    name: 'loadgen_request_duration_seconds',
    help: 'Time from sending a request to its outcome.',
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [registry],
  });

  const server: Server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/metrics') {
      void registry.metrics().then((body) => {
        res.writeHead(200, { 'content-type': registry.contentType });
        res.end(body);
      });
      return;
    }
    res.writeHead(404).end();
  });

  return {
    server,
    record: (ok: boolean, ms: number) => {
      requests.inc({ result: ok ? 'ok' : 'failed' });
      duration.observe(ms / 1000);
    },
  };
}
