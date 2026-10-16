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
// exposing them. Truncation takes precedence over full redaction so
// that operators can still distinguish "two different tokens" in
// debug output.
const TRUNCATE_PREFIX_CHARS = 6;
const TRUNCATE_KEYS = new Set(['federationtoken']);

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

// ── String-level redaction ───────────────────────────────────────────
//
// Key-based redaction only sees structured fields; the dominant logging
// style in this codebase is printf-style splat (`'... token=%s', t`),
// which lands as one opaque string. These patterns scrub the shapes a
// secret takes inside free text. They run on every log line, so each
// is anchored to a cheap literal prefix (the JWT and blob rules need a
// run of token characters first).
//
//   1. `Bearer <token>` / `Basic <credentials>` — authorization schemes
//   2. `authorization: <value>` headers, with or without a scheme word
//   3. `token=`, `password=`, `secret=`, `apiKey:` … key/value pairs
//      (any key ENDING in one of the words; separator `=` or `:`,
//      optional quotes, value runs to the next delimiter)
//   4. JWT-shaped strings — three base64url segments joined by dots
//   5. long base64-ish blobs — key material, ciphertext, session blobs
//      (the floor is above a hex SHA-256 so content hashes stay legible)
const SECRET_KEY_WORDS =
  'token|password|passwd|secret|api[_-]?key|private[_-]?key|credentials?';

// Order matters: the header rule runs before the scheme rule so
// `authorization: Bearer x` collapses to one marker instead of the
// scheme rule redacting the token first and the header rule then
// swallowing the marker. Plural keys (`tokens=5`) are counts, not
// secrets, and are deliberately NOT matched.
const STRING_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  {
    pattern: /\b(authorization["']?\s*[:=]\s*["']?)(?!\[REDACTED\])(?:(?:bearer|basic)\s+)?[^\s,;"'}\]]+/gi,
    replacement: '$1[REDACTED]'
  },
  {
    pattern: /\b(bearer|basic)\s+(?!\[REDACTED\])[A-Za-z0-9\-._~+/=]{4,}/gi,
    replacement: '$1 [REDACTED]'
  },
  {
    pattern: new RegExp(
      `\\b([\\w-]*(?:${SECRET_KEY_WORDS})["']?\\s*[=:]\\s*["']?)(?!\\[REDACTED\\])[^\\s,;&"'}\\]]+`,
      'gi'
    ),
    replacement: '$1[REDACTED]'
  },
  {
    pattern: /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replacement: '[REDACTED]'
  },
  {
    pattern: /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{80,}={0,2}(?![A-Za-z0-9+/_-])/g,
    replacement: '[REDACTED]'
  }
];

/**
 * Scrub secret-shaped substrings out of free text. Idempotent: a line
 * that already carries `[REDACTED]` comes back unchanged.
 */
export function redactString(text: string): string {
  let out = text;
  for (const { pattern, replacement } of STRING_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * The winston-side pass: scrubs a log record IN PLACE so every
 * transport downstream (console, app.log, error.log, the admin ring,
 * debug.log) sees the same sanitized line. Covers the printf template
 * and the already-substituted message, the splat arguments (strings by
 * pattern, objects by key), the error stack, and every meta field.
 * Winston's own `level` is left alone.
 */
export function redactLogRecord<T extends object>(info: T): T {
  const record = info as Record<string | symbol, unknown>;
  const extra = new Set(config.server.redactExtra.map((s) => s.toLowerCase()));
  const seen = new WeakSet<object>();

  if (typeof record.message === 'string') {
    record.message = redactString(record.message);
  }
  if (typeof record.stack === 'string') {
    record.stack = redactString(record.stack);
  }

  const splatKey = Symbol.for('splat');
  const splat = record[splatKey];
  if (Array.isArray(splat)) {
    record[splatKey] = splat.map((arg) => walk(arg, extra, seen));
  }

  for (const key of Object.keys(record)) {
    if (key === 'level' || key === 'message' || key === 'stack') continue;
    if (/^\d+$/.test(key)) continue; // winston splat residue, dropped later
    record[key] = walk(record[key], extra, seen);
  }

  return info;
}

/**
 * Returns a deep clone of `input` with sensitive fields redacted or
 * truncated. Non-objects pass through (strings are pattern-scrubbed).
 * Cycles are replaced with `[Circular]`.
 */
export function redact<T>(input: T): T {
  const extra = new Set(config.server.redactExtra.map((s) => s.toLowerCase()));
  const seen = new WeakSet<object>();
  return walk(input, extra, seen) as T;
}

function walk(value: unknown, extra: Set<string>, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
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
      message: redactString(value.message),
      stack: value.stack === undefined ? undefined : redactString(value.stack)
    };
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (shouldTruncate(k)) {
      out[k] = truncateValue(v);
    } else if (shouldRedact(k, extra)) {
      out[k] = REDACTED_MARKER;
    } else {
      out[k] = walk(v, extra, seen);
    }
  }
  return out;
}
