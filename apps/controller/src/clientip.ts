import type { IncomingMessage } from 'node:http';

/**
 * The caller's address. The header is trusted only when the deployment puts a
 * proxy in front that sets it and nothing else can reach this process.
 */
export function clientIp(req: IncomingMessage, header: string): string {
  if (header !== '') {
    const raw = req.headers[header];
    const first = (Array.isArray(raw) ? raw[0] : raw)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}
