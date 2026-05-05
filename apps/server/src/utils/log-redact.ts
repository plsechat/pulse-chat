/**
 * Redaction for structured logs.
 *
 * Two policies fold together:
 *
 *   1. **Strip whole keys** whose name appears on the denylist —
 *      passwords, raw key material, ciphertext payloads. Names match
 *      case-insensitively.
 *
 *   2. **Truncate** known-token-like fields (`federationToken`, etc.)
 *      to a short prefix so the log can still distinguish "two
 *      different tokens" without exposing the secret.
 *
 * Operates recursively on nested objects/arrays. Cycle-safe via a
 * WeakSet.
 *
 * Operators can add custom denylist keys at runtime via the
 * `REDACT_EXTRA` env var (comma-separated). Useful when an
 * application-specific shape carries a sensitive field this module
 * doesn't know about.
 */
import { config } from '../config';

const ALWAYS_REDACT = new Set(
  [
    // auth secrets
    'password',
    'newpassword',
    'oldpassword',
    'currentpassword',
    'passwordhash',
    'token',
    'accesstoken',
    'refreshtoken',
    'sessiontoken',
    'authtoken',
    'apikey',
    // federation
    'federationtoken',
    'signature',
    // signal / crypto
    'privatekey',
    'identitykey',
    'identityprivatekey',
    'signedprekey',
    'onetimeprekey',
    'prekey',
    'senderkey',
    'chainkey',
    'rootkey',
    'distributionmessage',
    'ciphertext',
    'plaintext',
    'encryptedcontent'
  ].map((k) => k.toLowerCase())
);

// Suffix-matched: any key ending in one of these (case-insensitive)
// is redacted. Catches `someSecret`, `passwordHash`, etc.
const REDACT_SUFFIXES = ['secret', 'hash'];

// Truncation: log the first `TRUNCATE_PREFIX_CHARS` characters and a
// trailing ellipsis. Lets debugging compare two values without
// exposing them.
const TRUNCATE_PREFIX_CHARS = 6;
const TRUNCATE_KEYS = new Set(
  ['federationtoken', 'token', 'accesstoken', 'refreshtoken'].map((k) =>
    k.toLowerCase()
  )
);

const REDACTED_MARKER = '[REDACTED]';

function shouldRedact(key: string, extra: Set<string>): boolean {
  const lower = key.toLowerCase();
  if (ALWAYS_REDACT.has(lower)) return true;
  if (extra.has(lower)) return true;
  for (const suffix of REDACT_SUFFIXES) {
    if (lower.endsWith(suffix) && lower.length > suffix.length) return true;
  }
  return false;
}

function shouldTruncate(key: string): boolean {
  return TRUNCATE_KEYS.has(key.toLowerCase());
}

function truncateValue(value: unknown): string {
  if (typeof value !== 'string') return REDACTED_MARKER;
  if (value.length <= TRUNCATE_PREFIX_CHARS) return REDACTED_MARKER;
  return `${value.slice(0, TRUNCATE_PREFIX_CHARS)}…`;
}

/**
 * Returns a deep clone of `input` with sensitive fields redacted or
 * truncated. Non-objects pass through. Cycles are replaced with
 * `[Circular]`.
 */
export function redact<T>(input: T): T {
  const extra = new Set(config.server.redactExtra.map((s) => s.toLowerCase()));
  const seen = new WeakSet<object>();
  return walk(input, extra, seen) as T;
}

function walk(value: unknown, extra: Set<string>, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;

  if (seen.has(value as object)) return '[Circular]';
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((v) => walk(v, extra, seen));
  }

  // Buffer / Uint8Array — log shape, not contents.
  if (value instanceof Uint8Array) {
    return `[Uint8Array len=${value.byteLength}]`;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack
    };
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (shouldRedact(k, extra)) {
      out[k] = REDACTED_MARKER;
    } else if (shouldTruncate(k)) {
      out[k] = truncateValue(v);
    } else {
      out[k] = walk(v, extra, seen);
    }
  }
  return out;
}
