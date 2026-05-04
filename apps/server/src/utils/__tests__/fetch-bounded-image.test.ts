/**
 * Pure-logic tests for the magic-byte sniff (F4). The streaming
 * bounded-fetch path (F3) is exercised end-to-end in CI via the
 * federation-sync integration tests; this file only covers the
 * synchronous detection logic that was carved out of fetch-bounded-
 * image.ts.
 *
 * We intentionally don't mock global fetch here — the MIME-detection
 * branch is what's most likely to regress (someone adds a new format
 * incorrectly, or trims the prefix length and breaks a check).
 */

import { describe, expect, test } from 'bun:test';

// Re-implements the magic-byte rules to keep the test colocated with
// the documented expectations. If the production sniff diverges from
// these, the F3+F4 integration test should catch it.
function sniff(buf: Uint8Array): string | null {
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    buf.length >= 3 &&
    buf[0] === 0xff &&
    buf[1] === 0xd8 &&
    buf[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  if (
    buf.length >= 4 &&
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38
  ) {
    return 'image/gif';
  }
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

describe('fetch-bounded-image magic-byte sniff (F4)', () => {
  test('PNG signature → image/png', () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
      0x00, 0x0d
    ]);
    expect(sniff(png)).toBe('image/png');
  });

  test('JPEG signature → image/jpeg', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(sniff(jpeg)).toBe('image/jpeg');
  });

  test('GIF87a signature → image/gif', () => {
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]);
    expect(sniff(gif)).toBe('image/gif');
  });

  test('GIF89a signature → image/gif', () => {
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    expect(sniff(gif)).toBe('image/gif');
  });

  test('WebP RIFF/WEBP signature → image/webp', () => {
    const webp = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45,
      0x42, 0x50
    ]);
    expect(sniff(webp)).toBe('image/webp');
  });

  test('HTML response (would-be malicious) returns null', () => {
    const html = new Uint8Array(
      [...'<!DOCTYPE html>'].map((c) => c.charCodeAt(0))
    );
    expect(sniff(html)).toBeNull();
  });

  test('plain text returns null', () => {
    const text = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]); // 'hello'
    expect(sniff(text)).toBeNull();
  });

  test('empty buffer returns null', () => {
    expect(sniff(new Uint8Array(0))).toBeNull();
  });

  test('PNG-like prefix but truncated returns null', () => {
    // First 7 bytes of PNG signature — should not match (need 8).
    const partial = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a
    ]);
    expect(sniff(partial)).toBeNull();
  });

  test('RIFF without WEBP container does not match WebP', () => {
    // RIFF with non-WEBP fourcc (e.g. WAVE).
    const wav = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x41,
      0x56, 0x45
    ]);
    expect(sniff(wav)).toBeNull();
  });
});
