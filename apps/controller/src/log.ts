type Level = 'info' | 'warn' | 'error';

// One JSON object per line on stdout.
export function log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(
    JSON.stringify({ ts: new Date().toISOString(), level, msg, app: 'controller', ...fields }) + '\n',
  );
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
