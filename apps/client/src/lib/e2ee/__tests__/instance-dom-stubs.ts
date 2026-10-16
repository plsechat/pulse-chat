/**
 * Globals that lib/e2ee's import graph touches at module-evaluation
 * time but happy-dom does not provide. `lib/e2ee` imports `lib/trpc`,
 * which reaches `features/server/sounds/actions` — that constructs an
 * AudioContext on load. Import this module FIRST in any test that
 * imports `@/lib/e2ee` or `@/lib/trpc`; static imports evaluate in
 * source order, so the stub is installed before the sounds module runs.
 *
 * Kept free of imports on purpose: anything imported here would
 * evaluate before the stub is installed.
 */

class FakeAudioParam {
  value = 1;
  setValueAtTime() {
    return this;
  }
  linearRampToValueAtTime() {
    return this;
  }
  exponentialRampToValueAtTime() {
    return this;
  }
}

class FakeAudioNode {
  gain = new FakeAudioParam();
  frequency = new FakeAudioParam();
  buffer: unknown = null;
  type = 'sine';
  connect() {
    return this;
  }
  disconnect() {}
  start() {}
  stop() {}
}

class FakeAudioContext {
  destination = new FakeAudioNode();
  currentTime = 0;
  state = 'running';
  createGain() {
    return new FakeAudioNode();
  }
  createOscillator() {
    return new FakeAudioNode();
  }
  createBufferSource() {
    return new FakeAudioNode();
  }
  decodeAudioData() {
    return Promise.resolve({});
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
}

type WithAudioContext = { AudioContext?: unknown };

(globalThis as WithAudioContext).AudioContext ??= FakeAudioContext;
if (typeof window !== 'undefined') {
  (window as unknown as WithAudioContext).AudioContext ??= FakeAudioContext;
}
