/**
 * Speaking-indicator maths and the one AudioContext every analyser
 * shares. Pure parts (level + quantizer) are unit-tested; the context
 * lives here so the hook stays a thin lifecycle wrapper.
 */

export enum SpeakingIntensity {
  Silent = 0,
  Quiet = 1,
  Normal = 2,
  Loud = 3
}

/** Normalised level (0..100) above which the user counts as speaking. */
export const SPEAKING_THRESHOLD = 8;
/** Upper bounds of the Quiet and Normal bands; above Normal is Loud. */
export const QUIET_MAX_LEVEL = 15;
export const NORMAL_MAX_LEVEL = 30;

/**
 * RMS of a byte frequency spectrum, scaled to 0..100. Smoothing is the
 * analyser's job (smoothingTimeConstant), not this function's.
 */
export const levelFromFrequencyData = (data: Uint8Array): number => {
  if (data.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data[i] * data[i];
  }
  const rms = Math.sqrt(sum / data.length);
  return Math.min(100, (rms / 255) * 100);
};

/**
 * Collapse a continuous level into the four bands the card styles.
 * Cards re-render only when this value changes, which turns the
 * per-frame analyser loop into a handful of commits per utterance.
 */
export const quantizeSpeakingLevel = (level: number): SpeakingIntensity => {
  if (!(level > SPEAKING_THRESHOLD)) return SpeakingIntensity.Silent;
  if (level < QUIET_MAX_LEVEL) return SpeakingIntensity.Quiet;
  if (level < NORMAL_MAX_LEVEL) return SpeakingIntensity.Normal;
  return SpeakingIntensity.Loud;
};

// ---------------------------------------------------------------------------
// Shared analyser context
// ---------------------------------------------------------------------------

type TAudioContextCtor = typeof AudioContext;

const audioContextCtor = (): TAudioContextCtor | undefined =>
  window.AudioContext ||
  (window as typeof window & { webkitAudioContext?: TAudioContextCtor })
    .webkitAudioContext;

let sharedContext: AudioContext | null = null;
let holders = 0;
let gestureListenersInstalled = false;

const resumeIfSuspended = () => {
  if (sharedContext && sharedContext.state === 'suspended') {
    sharedContext.resume().catch(() => {
      // Still blocked by autoplay policy — the next gesture retries.
    });
  }
};

// Browsers keep a context created outside a user gesture suspended; the
// first click or key anywhere resumes the shared one for every card.
const installGestureListeners = () => {
  if (gestureListenersInstalled || typeof window === 'undefined') return;
  gestureListenersInstalled = true;
  window.addEventListener('pointerdown', resumeIfSuspended, {
    capture: true,
    passive: true
  });
  window.addEventListener('keydown', resumeIfSuspended, {
    capture: true,
    passive: true
  });
};

/**
 * Borrow the shared analyser context. One context serves every card:
 * Safari caps the number of live contexts (later cards silently lost
 * their indicator), and per-card contexts were each resumed, closed and
 * re-created on every stream change. Throws when Web Audio is missing.
 */
export const acquireAnalyserContext = (): AudioContext => {
  if (!sharedContext || sharedContext.state === 'closed') {
    const Ctor = audioContextCtor();
    if (!Ctor) throw new Error('Web Audio is not available');
    sharedContext = new Ctor();
  }
  holders++;
  installGestureListeners();
  resumeIfSuspended();
  return sharedContext;
};

/**
 * Return the shared context. A failed wiring (`failed`) with nobody
 * else holding it closes and forgets the context, so the next card
 * starts from a fresh one instead of inheriting a broken instance.
 */
export const releaseAnalyserContext = (opts?: { failed?: boolean }): void => {
  holders = Math.max(0, holders - 1);
  if (opts?.failed && holders === 0 && sharedContext) {
    const ctx = sharedContext;
    sharedContext = null;
    ctx.close().catch(() => {
      // Already closing — nothing to recover.
    });
  }
};
