type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
/** One JSON line per event, so logs are greppable locally and parseable in hosting dashboards. */
export function log(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  const threshold = ORDER[(process.env.LOG_LEVEL as Level) || 'info'] ?? ORDER.info;
  if (ORDER[level] < threshold) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, event, ...fields });
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}
