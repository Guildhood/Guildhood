/**
 * Client diagnostics. Structured, and redacted: passwords, tokens, auth links, and email addresses
 * never reach the console (which iPad Safari's Web Inspector and crash tooling can capture).
 */
// Exact field names that carry secrets. (Not a substring match: safe_error_code must survive.)
const SECRET_KEYS = /^(password|new_?password|current_?password|token|token_hash|access_token|refresh_token|provider_token|id_token|secret|authorization|apikey|api_key|code|otp|nonce)$/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const JWT = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const URL_QUERY = /(https?:\/\/[^\s?#"]+)[?#][^\s"]*/g;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[…]';
  if (typeof value === 'string') return value.replace(JWT, '[token]').replace(URL_QUERY, '$1?[redacted]').replace(EMAIL, '[email]');
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
    return out;
  }
  return value;
}

let requestCounter = 0;
export const newRequestId = () => `c${Date.now().toString(36)}${(requestCounter++).toString(36)}`;

export function logEvent(event_type: string, fields: { request_id?: string; safe_error_code?: string | null; duration_ms?: number; [k: string]: unknown } = {}): void {
  const line = redact({ event_type, timestamp: new Date().toISOString(), environment: import.meta.env.MODE, ...fields });
  console.info(JSON.stringify(line));
}
