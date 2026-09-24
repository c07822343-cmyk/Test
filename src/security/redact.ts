// Secret redaction applied to every log line, stored error, API response and
// n8n-visible payload. Known secret values are registered at boot; generic
// credential shapes are masked as a second line of defence.

const registered = new Set<string>();

const PATTERNS: RegExp[] = [
  /nvapi-[A-Za-z0-9_\-]{8,}/g,
  /\b(Bearer)\s+[A-Za-z0-9._\-~+/=]{12,}/gi,
  /\b(api[_-]?key|authorization|x-api-key|token|secret|password)(["']?\s*[:=]\s*["']?)[^\s"',}]{6,}/gi,
];

export function registerSecret(value: string | null | undefined): void {
  if (value && value.length >= 8) registered.add(value);
}

export function maskSecret(value: string): string {
  if (value.length <= 8) return '****';
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

export function redactString(input: string): string {
  let out = input;
  for (const secret of registered) {
    if (out.includes(secret)) out = out.split(secret).join('[REDACTED]');
  }
  out = out.replace(PATTERNS[0], '[REDACTED_NVIDIA_KEY]');
  out = out.replace(PATTERNS[1], '$1 [REDACTED]');
  out = out.replace(PATTERNS[2], '$1$2[REDACTED]');
  return out;
}

/** Deep-redacts any JSON-like value. Keys that look secret are blanked entirely. */
export function redact<T>(value: T, depth = 0): T {
  if (depth > 12) return value;
  if (typeof value === 'string') return redactString(value) as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as T;
  if (value && typeof value === 'object') {
    if (value instanceof Date || Buffer.isBuffer(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/^(secret|api_?key|apikey|password|authorization|token)$/i.test(k) && typeof v === 'string') {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redact(v, depth + 1);
      }
    }
    return out as T;
  }
  return value;
}
