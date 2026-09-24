// Structured JSON logger. Every line passes through the redactor so a secret
// can never reach stdout, container logs or n8n execution data via our API.
import { redact, redactString } from '../security/redact.ts';

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = ORDER[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? 20;

function emit(level: Level, component: string, msg: string, fields?: Record<string, unknown>) {
  if (ORDER[level] < threshold) return;
  if (process.env.LOG_SILENT === '1') return;
  const line = {
    t: new Date().toISOString(),
    level,
    component,
    msg: redactString(msg),
    ...(fields ? redact(fields) : {}),
  };
  const text = JSON.stringify(line);
  if (level === 'error' || level === 'warn') process.stderr.write(text + '\n');
  else process.stdout.write(text + '\n');
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function logger(component: string): Logger {
  return {
    debug: (m, f) => emit('debug', component, m, f),
    info: (m, f) => emit('info', component, m, f),
    warn: (m, f) => emit('warn', component, m, f),
    error: (m, f) => emit('error', component, m, f),
  };
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return redactString(err.message);
  return redactString(String(err));
}
