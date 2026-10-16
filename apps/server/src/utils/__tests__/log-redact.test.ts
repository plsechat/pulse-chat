/**
 * Phase debug-logging / Phase 1 — redact() helper.
 *
 * Verifies that the structured-log redactor strips or truncates every
 * sensitive shape we know about before serialization, including:
 *   - Always-redacted whole-keys (passwords, signal key material, ciphertext)
 *   - Suffix-matched whole-keys (anything ending in `Secret` or `Hash`)
 *   - Truncated tokens (first 6 chars + `…`)
 *   - Recursive walking through nested objects / arrays
 *   - Cycle safety (no stack overflow on self-referencing inputs)
 *   - Configurable extension via `REDACT_EXTRA`
 */
import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { transports } from 'winston';
import { config } from '../../config';
import { LOGS_PATH } from '../../helpers/paths';
import { redact, redactLogRecord, redactString } from '../log-redact';

describe('redact()', () => {
  const originalRedactExtra = [...config.server.redactExtra];

  afterEach(() => {
    config.server.redactExtra = [...originalRedactExtra];
  });

  test('strips canonical sensitive whole-keys', () => {
    const out = redact({
      password: 'hunter2',
      newPassword: 'hunter3',
      identityKey: '0x012345abcdef',
      signedPreKey: '0xabc',
      senderKey: '0xdef',
      chainKey: '0x111',
      distributionMessage: '0x222',
      ciphertext: '0x333',
      plaintext: 'hello',
      apiKey: 'live_secret_xyz'
    });

    for (const v of Object.values(out)) {
      expect(v).toBe('[REDACTED]');
    }
  });

  test('matches case-insensitively', () => {
    const out = redact({ Password: 'a', PRIVATEKEY: 'b', cipherText: 'c' });
    expect(out.Password).toBe('[REDACTED]');
    expect(out.PRIVATEKEY).toBe('[REDACTED]');
    expect(out.cipherText).toBe('[REDACTED]');
  });

  test('strips suffix-matched keys (Secret / Hash)', () => {
    const out = redact({
      apiSecret: 'shh',
      passwordHash: 'argon2-blob',
      // Keys ending in 'hash' / 'secret' that aren't sensitive — we tolerate
      // false positives here; the rule is intentionally aggressive.
      myhash: 'something'
    });
    expect(out.apiSecret).toBe('[REDACTED]');
    expect(out.passwordHash).toBe('[REDACTED]');
    expect(out.myhash).toBe('[REDACTED]');
  });

  test('truncates federation tokens to a short prefix', () => {
    const out = redact({ federationToken: 'abcdef0123456789' });
    expect(out.federationToken).toBe('abcdef…');
  });

  test('truncates tokens that are barely longer than the prefix', () => {
    const out = redact({ federationToken: 'abcdef' });
    // Same length as the prefix → falls back to full redaction
    expect(out.federationToken).toBe('[REDACTED]');
  });

  test('walks nested objects and arrays', () => {
    const out = redact({
      user: { id: 1, password: 'p', name: 'alice' },
      items: [{ ciphertext: 'x' }, { plaintext: 'y' }]
    });
    expect((out.user as Record<string, unknown>).password).toBe('[REDACTED]');
    expect((out.user as Record<string, unknown>).name).toBe('alice');
    expect((out.items as Array<Record<string, unknown>>)[0]!.ciphertext).toBe('[REDACTED]');
  });

  test('preserves non-sensitive primitives', () => {
    const out = redact({
      id: 42,
      name: 'pulse',
      active: true,
      list: [1, 2, 3],
      empty: null
    });
    expect(out).toEqual({
      id: 42,
      name: 'pulse',
      active: true,
      list: [1, 2, 3],
      empty: null
    });
  });

  test('shapes Uint8Array as length-only marker', () => {
    const out = redact({ blob: new Uint8Array(32) }) as Record<string, unknown>;
    expect(out.blob).toBe('[Uint8Array len=32]');
  });

  test('Error instances become serializable', () => {
    const out = redact({ err: new Error('boom') }) as Record<string, unknown>;
    const serialized = out.err as { name: string; message: string; stack: string };
    expect(serialized.name).toBe('Error');
    expect(serialized.message).toBe('boom');
    expect(typeof serialized.stack).toBe('string');
  });

  test('cycle-safe', () => {
    const a: Record<string, unknown> = { name: 'a' };
    const b: Record<string, unknown> = { name: 'b', ref: a };
    a.ref = b;
    const out = redact(a);
    expect((out.ref as Record<string, unknown>).name).toBe('b');
    // Either side of the cycle gets replaced with [Circular]
    expect(((out.ref as Record<string, unknown>).ref as unknown)).toBe('[Circular]');
  });

  test('REDACT_EXTRA adds runtime-configured keys', () => {
    config.server.redactExtra = ['internalCookie', 'csrfToken'];
    const out = redact({ internalCookie: 'val', csrfToken: 'val', plain: 'kept' });
    expect(out.internalCookie).toBe('[REDACTED]');
    expect(out.csrfToken).toBe('[REDACTED]');
    expect(out.plain).toBe('kept');
  });
});

describe('redactString()', () => {
  const JWT =
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c';

  test('scrubs bearer / basic authorization schemes', () => {
    expect(redactString('Authorization header was Bearer abc.def-123')).toBe(
      'Authorization header was Bearer [REDACTED]'
    );
    expect(redactString('basic dXNlcjpwYXNz')).toBe('basic [REDACTED]');
  });

  test('scrubs authorization header values with or without a scheme', () => {
    expect(redactString('authorization: Bearer s3cr3t-value')).toBe(
      'authorization: [REDACTED]'
    );
    expect(redactString('{"Authorization":"tok-123"}')).toBe(
      '{"Authorization":"[REDACTED]"}'
    );
  });

  test('scrubs key=value and key: value pairs for secret-shaped keys', () => {
    expect(redactString('login ok token=abcdef123456 user=42')).toBe(
      'login ok token=[REDACTED] user=42'
    );
    expect(redactString("body { password: 'hunter2', name: 'a' }")).toBe(
      "body { password: '[REDACTED]', name: 'a' }"
    );
    expect(redactString('client_secret=xyz&grant_type=code')).toBe(
      'client_secret=[REDACTED]&grant_type=code'
    );
    expect(redactString('federationToken: abcdef0123456789')).toBe(
      'federationToken: [REDACTED]'
    );
    expect(redactString('apiKey="k-1"')).toBe('apiKey="[REDACTED]"');
    expect(redactString('{"password":"hunter2","id":7}')).toBe(
      '{"password":"[REDACTED]","id":7}'
    );
    expect(redactString('refresh_token=abc.def rotated')).toBe(
      'refresh_token=[REDACTED] rotated'
    );
  });

  test('scrubs JWT-shaped strings and long base64 blobs', () => {
    expect(redactString(`session ${JWT} resumed`)).toBe(
      'session [REDACTED] resumed'
    );
    const blob = 'A'.repeat(50) + 'b'.repeat(50) + '==';
    expect(redactString(`backup ${blob} stored`)).toBe('backup [REDACTED] stored');
  });

  test('leaves ordinary text, ids, hashes and short values alone', () => {
    const lines = [
      'user 42 joined the server',
      'tokens=5 remaining in bucket',
      'refresh_tokens=3 rotated',
      'md5=5d41402abc4b2a76b9719d911017c592',
      'sha256=' + 'a'.repeat(64),
      '[db/query] select "id" from "users" where "users"."id" = $1 params=[2]',
      'Bearer x'
    ];
    for (const line of lines) expect(redactString(line)).toBe(line);
  });

  test('is idempotent', () => {
    const once = redactString(
      'token=abcdef123456 Bearer abcdefgh authorization: Basic dXNlcjpwYXNz'
    );
    expect(once).toBe(
      'token=[REDACTED] Bearer [REDACTED] authorization: [REDACTED]'
    );
    expect(redactString(once)).toBe(once);
  });
});

describe('redactLogRecord()', () => {
  test('scrubs the message, splat args, stack and meta in place', () => {
    const splat = Symbol.for('splat');
    const info = {
      level: 'info',
      message: 'issued token=abcdef123456 for %s',
      stack: 'Error: Bearer abcdefgh\n    at x',
      requestId: 'r1',
      body: { password: 'hunter2', note: 'secret=shh' },
      [splat]: ['Bearer abcdefgh', { ciphertext: 'c' }]
    };

    const out = redactLogRecord(info) as typeof info;

    expect(out).toBe(info);
    expect(out.message).toBe('issued token=[REDACTED] for %s');
    expect(out.stack).toBe('Error: Bearer [REDACTED]\n    at x');
    expect(out.requestId).toBe('r1');
    expect(out.body).toEqual({ password: '[REDACTED]', note: 'secret=[REDACTED]' });
    expect(out[splat]).toEqual(['Bearer [REDACTED]', { ciphertext: '[REDACTED]' }]);
    expect(out.level).toBe('info');
  });
});

describe('logger default chain', () => {
  const readUntil = async (file: string, needle: string, times: number) => {
    for (let i = 0; i < 200; i++) {
      try {
        const content = await fs.readFile(file, 'utf8');
        if (content.split(needle).length - 1 >= times) return content;
      } catch {
        // not written yet
      }
      await Bun.sleep(10);
    }
    throw new Error(`${file} never received ${times}x ${needle}`);
  };

  test('string-level redaction reaches app.log and the admin ring', async () => {
    // The preload mocks `../logger`; the query suffix loads the REAL
    // module (same file, separate module instance) so the actual format
    // chain is under test. Its console transport is muted for the run.
    const modulePath = '../../logger.ts?real';
    const real = (await import(modulePath)) as typeof import('../../logger');
    for (const t of real.logger.transports) {
      if (t instanceof transports.Console) t.silent = true;
    }

    const marker = `redact-probe-${Date.now()}`;
    real.logger.info(`${marker} login token=%s`, 'abcdef123456');
    real.logger.info(`${marker} header %s %s`, 'Bearer', 'abcdefgh.ijklmnop');
    real.logger.warn(`${marker} body %o`, { password: 'hunter2' });

    const ring = real.getRecentLogs().filter((l) => l.message.includes(marker));
    expect(ring).toHaveLength(3);
    for (const line of ring) {
      expect(line.message).toContain('[REDACTED]');
      expect(line.message).not.toMatch(/abcdef123456|abcdefgh|hunter2/);
    }
    expect(ring[0]!.message).toBe(`${marker} login token=[REDACTED]`);

    const appLog = path.join(LOGS_PATH, 'app.log');
    const content = await readUntil(appLog, marker, 3);
    const lines = content.split('\n').filter((l) => l.includes(marker));
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).toContain('[REDACTED]');
      expect(line).not.toMatch(/abcdef123456|abcdefgh|hunter2/);
    }
  });
});

