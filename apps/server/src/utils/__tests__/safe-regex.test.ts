import { describe, expect, test } from 'bun:test';
import { validateSafeRegex } from '../safe-regex';

describe('validateSafeRegex', () => {
  test('accepts a benign keyword regex', () => {
    expect(validateSafeRegex('^hello$').ok).toBe(true);
    expect(validateSafeRegex('foo|bar|baz').ok).toBe(true);
    expect(validateSafeRegex('\\d{3}-\\d{4}').ok).toBe(true);
  });

  test('accepts a moderately complex but non-pathological regex', () => {
    expect(validateSafeRegex('https?://[\\w.-]+/\\S*').ok).toBe(true);
  });

  test('rejects the canonical ReDoS pattern (a+)+', () => {
    const r = validateSafeRegex('^(a+)+$');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.toLowerCase()).toContain('redos');
  });

  test('rejects (a*)*', () => {
    const r = validateSafeRegex('^(a*)*$');
    expect(r.ok).toBe(false);
  });

  test('rejects (.+)+', () => {
    const r = validateSafeRegex('(.+)+!');
    expect(r.ok).toBe(false);
  });

  test('rejects nested star with alternation (a|aa)+', () => {
    const r = validateSafeRegex('^(a|aa)+$');
    expect(r.ok).toBe(false);
  });

  test('rejects patterns over the length cap', () => {
    const longPattern = 'a'.repeat(300);
    const r = validateSafeRegex(longPattern);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('length');
  });

  test('rejects syntactically invalid regex', () => {
    const r = validateSafeRegex('([a-z');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.toLowerCase()).toContain('invalid');
  });
});
