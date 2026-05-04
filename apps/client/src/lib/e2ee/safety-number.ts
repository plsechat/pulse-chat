/**
 * Signal numeric-fingerprint (a.k.a. "safety number") generation.
 *
 * Mirrors libsignal-protocol-java's NumericFingerprintGenerator v1:
 *   https://signal.org/docs/specifications/safety-numbers/
 *
 * Both sides of a conversation hash their own (identityKey, stableId)
 * 5200 times with SHA-512, mixing in the identity key on every round,
 * then truncate to the first 30 bytes. Each 30-byte fingerprint encodes
 * to a 30-digit string (six 5-byte chunks → six 5-digit groups via
 * `int(chunk_be) mod 100000`). The displayed safety number is the two
 * 30-digit halves concatenated in a deterministic order (lexicographic
 * smaller-first) so the two endpoints render the same string.
 *
 * No protocol break: this only computes a comparison string from public
 * inputs. Stays Signal-compatible — anyone with the same identity keys
 * and stable ids will produce the same digits.
 */

const FINGERPRINT_VERSION = 0;
const ITERATIONS = 5200;
const TRUNCATED_BYTES = 30;
const CHUNK_BYTES = 5;
const CHUNK_MOD = 100_000n;
const HALF_DIGITS = 30;
const TOTAL_DIGITS = HALF_DIGITS * 2;

export type SafetyNumberInputs = {
  localUserId: number | string;
  localIdentityKey: Uint8Array;
  remoteUserId: number | string;
  remoteIdentityKey: Uint8Array;
};

export async function computeSafetyNumber(inputs: SafetyNumberInputs): Promise<string> {
  if (!inputs.localIdentityKey?.length || !inputs.remoteIdentityKey?.length) {
    throw new Error('safety number inputs require non-empty identity keys');
  }
  const local = await fingerprintFor(String(inputs.localUserId), inputs.localIdentityKey);
  const remote = await fingerprintFor(String(inputs.remoteUserId), inputs.remoteIdentityKey);
  const localDigits = chunksToDigits(local);
  const remoteDigits = chunksToDigits(remote);
  return localDigits <= remoteDigits
    ? localDigits + remoteDigits
    : remoteDigits + localDigits;
}

/**
 * Render 60 contiguous digits as 12 space-separated groups of 5.
 * Throws if the input isn't exactly 60 decimal digits.
 */
export function formatForDisplay(digits: string): string {
  if (digits.length !== TOTAL_DIGITS || !/^\d{60}$/.test(digits)) {
    throw new Error(`expected ${TOTAL_DIGITS} decimal digits, got ${JSON.stringify(digits)}`);
  }
  const groups: string[] = [];
  for (let i = 0; i < TOTAL_DIGITS; i += 5) {
    groups.push(digits.slice(i, i + 5));
  }
  return groups.join(' ');
}

async function fingerprintFor(stableId: string, identityKey: Uint8Array): Promise<Uint8Array> {
  const versionBytes = u16BE(FINGERPRINT_VERSION);
  const idBytes = new TextEncoder().encode(stableId);
  let hash = concat(versionBytes, identityKey, idBytes);
  for (let i = 0; i < ITERATIONS; i++) {
    hash = await sha512(concat(hash, identityKey));
  }
  return hash.slice(0, TRUNCATED_BYTES);
}

function chunksToDigits(fingerprint: Uint8Array): string {
  if (fingerprint.length !== TRUNCATED_BYTES) {
    throw new Error(`fingerprint must be ${TRUNCATED_BYTES} bytes`);
  }
  let out = '';
  for (let offset = 0; offset < TRUNCATED_BYTES; offset += CHUNK_BYTES) {
    let chunk = 0n;
    for (let j = 0; j < CHUNK_BYTES; j++) {
      chunk = (chunk << 8n) | BigInt(fingerprint[offset + j]);
    }
    out += (chunk % CHUNK_MOD).toString().padStart(5, '0');
  }
  return out;
}

async function sha512(data: Uint8Array): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest('SHA-512', data);
  return new Uint8Array(buf);
}

function concat(...arrs: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrs) total += a.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrs) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

function u16BE(n: number): Uint8Array {
  return new Uint8Array([(n >> 8) & 0xff, n & 0xff]);
}

export const __testing = {
  fingerprintFor,
  chunksToDigits,
  ITERATIONS,
  TRUNCATED_BYTES,
  HALF_DIGITS,
  TOTAL_DIGITS
};
