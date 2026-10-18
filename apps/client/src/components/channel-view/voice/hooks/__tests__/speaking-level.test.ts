/**
 * Speaking indicator: the level→band quantizer the cards re-render on,
 * and the single shared analyser context behind every card.
 *
 * Run via:
 *   bun test apps/client/src/components/channel-view/voice/hooks/__tests__/speaking-level.test.ts
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  acquireAnalyserContext,
  levelFromFrequencyData,
  NORMAL_MAX_LEVEL,
  QUIET_MAX_LEVEL,
  quantizeSpeakingLevel,
  releaseAnalyserContext,
  SPEAKING_THRESHOLD,
  SpeakingIntensity
} from '../speaking-level';

describe('levelFromFrequencyData', () => {
  test('silence is 0, full scale is 100, empty is 0', () => {
    expect(levelFromFrequencyData(new Uint8Array(8))).toBe(0);
    expect(levelFromFrequencyData(new Uint8Array(8).fill(255))).toBe(100);
    expect(levelFromFrequencyData(new Uint8Array(0))).toBe(0);
  });

  test('is the RMS scaled to 0..100', () => {
    // rms of [0, 255] = 255/sqrt(2)
    const level = levelFromFrequencyData(new Uint8Array([0, 255]));
    expect(level).toBeCloseTo(100 / Math.SQRT2, 5);
  });
});

describe('quantizeSpeakingLevel', () => {
  test('bands with their boundaries', () => {
    expect(quantizeSpeakingLevel(0)).toBe(SpeakingIntensity.Silent);
    expect(quantizeSpeakingLevel(SPEAKING_THRESHOLD)).toBe(SpeakingIntensity.Silent);
    expect(quantizeSpeakingLevel(SPEAKING_THRESHOLD + 0.01)).toBe(SpeakingIntensity.Quiet);
    expect(quantizeSpeakingLevel(QUIET_MAX_LEVEL - 0.01)).toBe(SpeakingIntensity.Quiet);
    expect(quantizeSpeakingLevel(QUIET_MAX_LEVEL)).toBe(SpeakingIntensity.Normal);
    expect(quantizeSpeakingLevel(NORMAL_MAX_LEVEL - 0.01)).toBe(SpeakingIntensity.Normal);
    expect(quantizeSpeakingLevel(NORMAL_MAX_LEVEL)).toBe(SpeakingIntensity.Loud);
    expect(quantizeSpeakingLevel(100)).toBe(SpeakingIntensity.Loud);
  });

  test('NaN is silent, never a stuck ring', () => {
    expect(quantizeSpeakingLevel(Number.NaN)).toBe(SpeakingIntensity.Silent);
  });
});

describe('shared analyser context', () => {
  type WithCtor = { AudioContext?: unknown };
  let created = 0;
  let closed = 0;
  let resumed = 0;
  class FakeContext {
    state = 'suspended';
    constructor() {
      created++;
    }
    resume() {
      resumed++;
      this.state = 'running';
      return Promise.resolve();
    }
    close() {
      closed++;
      this.state = 'closed';
      return Promise.resolve();
    }
  }
  let previous: unknown;
  beforeEach(() => {
    created = closed = resumed = 0;
    previous = (window as unknown as WithCtor).AudioContext;
    (window as unknown as WithCtor).AudioContext = FakeContext;
  });
  afterEach(() => {
    (window as unknown as WithCtor).AudioContext = previous;
  });

  test('every holder gets the same context; a plain release keeps it', () => {
    const a = acquireAnalyserContext();
    const b = acquireAnalyserContext();
    expect(b).toBe(a);
    expect(created).toBe(1);
    expect(resumed).toBeGreaterThan(0);
    releaseAnalyserContext();
    releaseAnalyserContext();
    expect(closed).toBe(0);
    expect(acquireAnalyserContext()).toBe(a);
    releaseAnalyserContext();
  });

  test('a failed wiring with no other holder closes it and the next acquire starts fresh', () => {
    const a = acquireAnalyserContext();
    const b = acquireAnalyserContext();
    releaseAnalyserContext({ failed: true });
    // b still holds it — not closed.
    expect(closed).toBe(0);
    releaseAnalyserContext({ failed: true });
    expect(closed).toBe(1);
    const c = acquireAnalyserContext();
    expect(c).not.toBe(a);
    expect(c).not.toBe(b);
    releaseAnalyserContext({ failed: true });
  });

  test('throws when Web Audio is unavailable', () => {
    (window as unknown as WithCtor).AudioContext = undefined;
    expect(() => acquireAnalyserContext()).toThrow();
  });
});
