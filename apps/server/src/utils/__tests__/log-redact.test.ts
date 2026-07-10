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
import { config } from '../../config';
import { redact } from '../log-redact';

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
