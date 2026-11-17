type Level = 'info' | 'warn' | 'error';

const base: Record<string, unknown> = {
  app: 'target',
  pod: process.env.POD_NAME ?? process.env.HOSTNAME ?? 'local',
  version: process.env.VERSION ?? 'dev',
};

let silent = false;

export function setSilent(value: boolean): void {
  silent = value;
}

// One JSON object per line on stdout, so `kubectl logs` output is machine-readable.
export function log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  if (silent) return;
  process.stdout.write(
    JSON.stringify({ ts: new Date().toISOString(), level, msg, ...base, ...fields }) + '\n',
  );
}
