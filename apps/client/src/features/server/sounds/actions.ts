import {
  getMasterVolumeMultiplier,
  getSelectedSoundVariant,
  isCategoryEnabledForSound
} from '@/hooks/use-sound-notification-settings';
import { SoundType } from '../types';

const audioCtx = new (window.AudioContext ||
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).webkitAudioContext)();

const SOUNDS_VOLUME = 5;

const now = () => audioCtx.currentTime;

const createOsc = (type: OscillatorType, freq: number) => {
  const osc = audioCtx.createOscillator();

  osc.type = type;
  osc.frequency.setValueAtTime(freq, now());

  return osc;
};

const createGain = (value = 1) => {
  const gain = audioCtx.createGain();

  gain.gain.setValueAtTime(
    value * SOUNDS_VOLUME * getMasterVolumeMultiplier(),
    now()
  );

  return gain;
};

// MESSAGE_RECEIVED — warm Bb5 ping with soft major-7th shimmer
const sfxMessageReceived = () => {
  const osc = createOsc('sine', 932); // Bb5
  const gain = createGain(0.05);

  gain.gain.exponentialRampToValueAtTime(0.0001, now() + 0.06);

  osc.connect(gain).connect(audioCtx.destination);
  osc.start();
  osc.stop(now() + 0.06);

  // Subtle A5 shimmer (major 7th against Bb)
  const osc2 = createOsc('triangle', 1760); // A6
  const gain2 = createGain(0.015);

  gain2.gain.exponentialRampToValueAtTime(0.0001, now() + 0.04);

  osc2.connect(gain2).connect(audioCtx.destination);
  osc2.start(now() + 0.01);
  osc2.stop(now() + 0.05);
};

// MESSAGE_SENT — bright D6 with F#6 overtone (lydian color)
const sfxMessageSent = () => {
  const osc = createOsc('sine', 1175); // D6
  const gain = createGain(0.04);

  gain.gain.exponentialRampToValueAtTime(0.0001, now() + 0.05);

  osc.connect(gain).connect(audioCtx.destination);
  osc.start();
  osc.stop(now() + 0.05);

  const osc2 = createOsc('triangle', 1480); // F#6
  const gain2 = createGain(0.012);

  gain2.gain.exponentialRampToValueAtTime(0.0001, now() + 0.035);

  osc2.connect(gain2).connect(audioCtx.destination);
  osc2.start();
  osc2.stop(now() + 0.04);
};

// OWN_USER_JOINED_VOICE_CHANNEL — Bbmaj9 chord (lush, welcoming)
const sfxOwnUserJoinedVoiceChannel = () => {
  // Bbmaj9: Bb-D-F-A-C
  const chord1 = [
    { freq: 466, gain: 0.09 }, // Bb4
    { freq: 587, gain: 0.07 }, // D5
    { freq: 698, gain: 0.06 }, // F5
    { freq: 880, gain: 0.04 } // A5 (major 7th)
  ];

  chord1.forEach(({ freq, gain: g }) => {
    const osc = createOsc('sine', freq);
    const gain = createGain(g);

    gain.gain.exponentialRampToValueAtTime(0.0001, now() + 0.25);

    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(now() + 0.25);
  });

  // Upper shimmer — C6 (9th) and F6 with triangle wave
  const chord2 = [
    { freq: 1047, gain: 0.03 }, // C6 (9th)
    { freq: 1397, gain: 0.02 } // F6 (5th, octave up)
  ];

  chord2.forEach(({ freq, gain: g }) => {
    const osc = createOsc('triangle', freq);
    const gain = createGain(g);

    gain.gain.exponentialRampToValueAtTime(0.0001, now() + 0.3);

    osc.connect(gain).connect(audioCtx.destination);
    osc.start(now() + 0.08);
    osc.stop(now() + 0.3);
  });
};

// OWN_USER_LEFT_VOICE_CHANNEL — Gm9 chord (warm, gentle farewell)
const sfxOwnUserLeftVoiceChannel = () => {
  // Gm9: G-Bb-D-F-A
  const chord1 = [
    { freq: 392, gain: 0.09 }, // G4
    { freq: 466, gain: 0.07 }, // Bb4
    { freq: 587, gain: 0.05 } // D5
  ];

  chord1.forEach(({ freq, gain: g }) => {
    const osc = createOsc('sine', freq);
    const gain = createGain(g);

    gain.gain.exponentialRampToValueAtTime(0.0001, now() + 0.3);

    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(now() + 0.3);
  });

  // F5 (minor 7th) and A5 (9th) — adds depth
  const osc2 = createOsc('triangle', 698); // F5
  const gain2 = createGain(0.035);

  gain2.gain.exponentialRampToValueAtTime(0.0001, now() + 0.25);

  osc2.connect(gain2).connect(audioCtx.destination);
  osc2.start(now() + 0.05);
  osc2.stop(now() + 0.3);

  const osc3 = createOsc('triangle', 880); // A5
  const gain3 = createGain(0.02);

  gain3.gain.exponentialRampToValueAtTime(0.0001, now() + 0.2);

  osc3.connect(gain3).connect(audioCtx.destination);
  osc3.start(now() + 0.05);
  osc3.stop(now() + 0.25);
};

// MUTED_MIC — Eb4 with quick Db4 grace note (darker, distinct)
const sfxOwnUserMutedMic = () => {
  const osc = createOsc('sine', 311); // Eb4
  const gain = createGain(0.05);

  gain.gain.exponentialRampToValueAtTime(0.0001, now() + 0.06);

  osc.connect(gain).connect(audioCtx.destination);
  osc.start();
  osc.stop(now() + 0.06);

  const osc2 = createOsc('sine', 277); // Db4
  const gain2 = createGain(0.02);

  gain2.gain.exponentialRampToValueAtTime(0.0001, now() + 0.03);

  osc2.connect(gain2).connect(audioCtx.destination);
  osc2.start();
  osc2.stop(now() + 0.03);
};

// UNMUTED_MIC — Bb4 with F5 fifth (open, alive)
const sfxOwnUserUnmutedMic = () => {
  const osc = createOsc('sine', 466); // Bb4
  const gain = createGain(0.05);

  gain.gain.exponentialRampToValueAtTime(0.0001, now() + 0.06);

  osc.connect(gain).connect(audioCtx.destination);
  osc.start();
  osc.stop(now() + 0.06);

  const osc2 = createOsc('sine', 698); // F5
  const gain2 = createGain(0.02);

  gain2.gain.exponentialRampToValueAtTime(0.0001, now() + 0.05);

  osc2.connect(gain2).connect(audioCtx.destination);
  osc2.start();
  osc2.stop(now() + 0.05);
};

// MUTED_SOUND — Ab4 dropping to Gb4 (subdued, closing feel)
const sfxOwnUserMutedSound = () => {
  const osc = createOsc('sine', 415); // Ab4
  const gain = createGain(0.05);

  osc.frequency.exponentialRampToValueAtTime(370, now() + 0.06); // slide to Gb4
  gain.gain.exponentialRampToValueAtTime(0.0001, now() + 0.06);

  osc.connect(gain).connect(audioCtx.destination);
  osc.start();
  osc.stop(now() + 0.06);
};

// UNMUTED_SOUND — F5 rising to G5 (opening up)
const sfxOwnUserUnmutedSound = () => {
  const osc = createOsc('sine', 698); // F5
  const gain = createGain(0.05);

  osc.frequency.exponentialRampToValueAtTime(784, now() + 0.06); // slide to G5
  gain.gain.exponentialRampToValueAtTime(0.0001, now() + 0.06);

  osc.connect(gain).connect(audioCtx.destination);
  osc.start();
  osc.stop(now() + 0.06);
};

// STARTED_WEBCAM — F#5 to A5 (tritone resolution, bright activation)
const sfxOwnUserStartedWebcam = () => {
  const osc1 = createOsc('sine', 740); // F#5
  const gain1 = createGain(0.07);

  gain1.gain.exponentialRampToValueAtTime(0.0001, now() + 0.12);

  osc1.connect(gain1).connect(audioCtx.destination);
  osc1.start();
  osc1.stop(now() + 0.12);

  const osc2 = createOsc('sine', 880); // A5
  const gain2 = createGain(0.04);

  gain2.gain.exponentialRampToValueAtTime(0.0001, now() + 0.1);

  osc2.connect(gain2).connect(audioCtx.destination);
  osc2.start(now() + 0.04);
  osc2.stop(now() + 0.12);

  // Subtle D6 triangle shimmer (adds lydian sparkle)
  const osc3 = createOsc('triangle', 1175); // D6
  const gain3 = createGain(0.015);

  gain3.gain.exponentialRampToValueAtTime(0.0001, now() + 0.08);

  osc3.connect(gain3).connect(audioCtx.destination);
  osc3.start(now() + 0.06);
  osc3.stop(now() + 0.12);
};

// STOPPED_WEBCAM — A5 sliding down to Eb5 (tritone descent, winding down)
const sfxOwnUserStoppedWebcam = () => {
  const osc1 = createOsc('sine', 880); // A5
  const gain1 = createGain(0.07);

  osc1.frequency.exponentialRampToValueAtTime(622, now() + 0.12); // slide to Eb5
  gain1.gain.exponentialRampToValueAtTime(0.0001, now() + 0.14);

  osc1.connect(gain1).connect(audioCtx.destination);
  osc1.start();
  osc1.stop(now() + 0.14);
};

// STARTED_SCREENSHARE — Ascending Eb-G-Bb arpeggio + D6 shimmer
const sfxOwnUserStartedScreenshare = () => {
  const pulses = [
    { freq: 622, delay: 0 }, // Eb5
    { freq: 784, delay: 0.06 }, // G5
    { freq: 932, delay: 0.12 } // Bb5
  ];

  pulses.forEach(({ freq, delay }) => {
    const t = now() + delay;
    const osc = createOsc('sine', freq);
    const gain = createGain(0.08);

    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);

    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.1);
  });

  // D6 shimmer (major 7th of Eb — lydian color)
  const osc2 = createOsc('triangle', 1175); // D6
  const gain2 = createGain(0.03);

  gain2.gain.exponentialRampToValueAtTime(0.0001, now() + 0.2);

  osc2.connect(gain2).connect(audioCtx.destination);
  osc2.start(now() + 0.08);
  osc2.stop(now() + 0.22);
};

// STOPPED_SCREENSHARE — Descending Ab5 to Db5 + Eb5 to Bb4
const sfxOwnUserStoppedScreenshare = () => {
  const osc1 = createOsc('sine', 831); // Ab5
  const gain1 = createGain(0.08);

  osc1.frequency.exponentialRampToValueAtTime(554, now() + 0.18); // slide to Db5
  gain1.gain.exponentialRampToValueAtTime(0.0001, now() + 0.2);

  osc1.connect(gain1).connect(audioCtx.destination);
  osc1.start();
  osc1.stop(now() + 0.2);

  const osc2 = createOsc('triangle', 622); // Eb5
  const gain2 = createGain(0.03);

  osc2.frequency.exponentialRampToValueAtTime(466, now() + 0.18); // slide to Bb4
  gain2.gain.exponentialRampToValueAtTime(0.0001, now() + 0.2);

  osc2.connect(gain2).connect(audioCtx.destination);
  osc2.start(now() + 0.05);
  osc2.stop(now() + 0.2);
};

// REMOTE JOIN — Ascending Eb5-G5-Bb5 (Eb major, bright & distinct)
const sfxRemoteUserJoinedVoiceChannel = () => {
  const tones = [
    { freq: 622, gain: 0.06, delay: 0 }, // Eb5
    { freq: 784, gain: 0.05, delay: 0.06 }, // G5
    { freq: 932, gain: 0.04, delay: 0.12 } // Bb5
  ];

  tones.forEach(({ freq, gain: g, delay }) => {
    const t = now() + delay;
    const osc = createOsc('sine', freq);
    const gain = createGain(g);

    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);

    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.2);
  });
};

// REMOTE LEAVE — Descending F5-D5-Bb4 (gentle fall)
const sfxRemoteUserLeftVoiceChannel = () => {
  const tones = [
    { freq: 698, gain: 0.06, delay: 0 }, // F5
    { freq: 587, gain: 0.05, delay: 0.06 }, // D5
    { freq: 466, gain: 0.04, delay: 0.12 } // Bb4
  ];

  tones.forEach(({ freq, gain: g, delay }) => {
    const t = now() + delay;
    const osc = createOsc('sine', freq);
    const gain = createGain(g);

    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);

    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.2);
  });
};

// REMOTE STARTED_SCREENSHARE — two-note Bb5-Eb6 "incoming" chirp; brighter
// and shorter than the sharer's own ascending arpeggio so the two are
// distinguishable when sharer and viewer sit in the same room.
const sfxRemoteUserStartedScreenshare = () => {
  const tones = [
    { freq: 932, gain: 0.06, delay: 0 }, // Bb5
    { freq: 1245, gain: 0.05, delay: 0.08 } // Eb6
  ];

  tones.forEach(({ freq, gain: g, delay }) => {
    const t = now() + delay;
    const osc = createOsc('sine', freq);
    const gain = createGain(g);

    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);

    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.12);
  });
};

// ---------------------------------------------------------------------------
// Selectable sound variants
// ---------------------------------------------------------------------------

// --- Space bus: shared reverb (generated impulse) + feedback delay.
// Notes opt in with a send level; dry signal stays untouched.

const makeImpulse = (seconds: number, decay: number) => {
  const rate = audioCtx.sampleRate;
  const len = Math.floor(rate * seconds);
  const buf = audioCtx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
};

let spaceBus: GainNode | null = null;
const getSpaceBus = () => {
  if (spaceBus) return spaceBus;
  spaceBus = audioCtx.createGain();

  // Dotted-ish feedback delay for rhythmic space
  const delay = audioCtx.createDelay(1);
  delay.delayTime.value = 0.29;
  const feedback = audioCtx.createGain();
  feedback.gain.value = 0.3;
  const delayWet = audioCtx.createGain();
  delayWet.gain.value = 0.4;
  spaceBus.connect(delay);
  delay.connect(feedback);
  feedback.connect(delay);
  delay.connect(delayWet);
  delayWet.connect(audioCtx.destination);

  // Hall-ish tail
  const conv = audioCtx.createConvolver();
  conv.buffer = makeImpulse(2.2, 2.6);
  const revWet = audioCtx.createGain();
  revWet.gain.value = 0.55;
  spaceBus.connect(conv);
  conv.connect(revWet);
  revWet.connect(audioCtx.destination);

  return spaceBus;
};

/** Tone helper for the variant synths: one enveloped oscillator. */
const tone = (opts: {
  type?: OscillatorType;
  freq: number;
  /** Optional pitch glide target. */
  glideTo?: number;
  gain: number;
  delay?: number;
  attack?: number;
  duration: number;
  /** Send level into the reverb/delay space bus (0..1). */
  space?: number;
}) => {
  const t0 = now() + (opts.delay ?? 0);
  const attack = opts.attack ?? 0.008;
  const osc = createOsc(opts.type ?? 'sine', opts.freq);
  if (opts.glideTo) {
    osc.frequency.setValueAtTime(opts.freq, t0);
    osc.frequency.exponentialRampToValueAtTime(
      opts.glideTo,
      t0 + opts.duration * 0.8
    );
  }
  const gain = audioCtx.createGain();
  const peak = opts.gain * SOUNDS_VOLUME * getMasterVolumeMultiplier();
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.linearRampToValueAtTime(peak, t0 + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.duration);
  osc.connect(gain).connect(audioCtx.destination);
  if (opts.space) {
    const send = audioCtx.createGain();
    send.gain.value = opts.space;
    gain.connect(send).connect(getSpaceBus());
  }
  osc.start(t0);
  osc.stop(t0 + opts.duration + 0.02);
};

// MESSAGE_RECEIVED / Chime — the NEW default: a proper two-note
// "ding-dong" (G5→C6) with octave harmonics, ~0.45s and loud enough to
// register from another window. The old 60ms ping lives on as Classic.
const sfxReceivedChime = () => {
  tone({ freq: 784, gain: 0.11, duration: 0.3 }); // G5
  tone({ freq: 1568, gain: 0.03, duration: 0.22 }); // G6 harmonic
  tone({ freq: 1047, gain: 0.12, delay: 0.14, duration: 0.42 }); // C6
  tone({ freq: 2093, gain: 0.035, delay: 0.14, duration: 0.3 }); // C7
  tone({ type: 'triangle', freq: 1319, gain: 0.02, delay: 0.2, duration: 0.35 }); // E6 sparkle
};

// MESSAGE_RECEIVED / Bell — one clear strike with inharmonic shimmer.
const sfxReceivedBell = () => {
  tone({ freq: 1319, gain: 0.12, duration: 0.65, attack: 0.004 }); // E6
  tone({ freq: 1319 * 2.76, gain: 0.03, duration: 0.35, attack: 0.004 });
  tone({ freq: 1319 * 5.4, gain: 0.012, duration: 0.18, attack: 0.004 });
};

// MESSAGE_RECEIVED / Marimba — two woody hits, A5 then D6.
const sfxReceivedMarimba = () => {
  tone({ freq: 880, gain: 0.13, duration: 0.16, attack: 0.003 });
  tone({ freq: 3520, gain: 0.025, duration: 0.06, attack: 0.003 });
  tone({ freq: 1175, gain: 0.13, delay: 0.12, duration: 0.24, attack: 0.003 });
  tone({ freq: 4700, gain: 0.02, delay: 0.12, duration: 0.07, attack: 0.003 });
};

// MESSAGE_RECEIVED / Bubble — a bright upward pop.
const sfxReceivedBubble = () => {
  tone({ freq: 620, glideTo: 1400, gain: 0.12, duration: 0.12 });
  tone({ freq: 1400, gain: 0.05, delay: 0.1, duration: 0.14 });
};

// MESSAGE_SENT / Pop — single soft blip.
const sfxSentPop = () => {
  tone({ freq: 1047, gain: 0.06, duration: 0.07 });
};

// MESSAGE_SENT / Whoosh — quick rising gliss, reads as "away it goes".
const sfxSentWhoosh = () => {
  tone({ freq: 520, glideTo: 1100, gain: 0.05, duration: 0.11 });
  tone({ type: 'triangle', freq: 1560, gain: 0.015, delay: 0.06, duration: 0.08 });
};

// VOICE JOIN / Rise — bright ascending C-E-G-C.
const sfxJoinRise = () => {
  [523, 659, 784, 1047].forEach((freq, i) =>
    tone({ freq, gain: 0.09 - i * 0.01, delay: i * 0.06, duration: 0.22 })
  );
};

// VOICE JOIN / Soft — gentle two-note F5→C6.
const sfxJoinSoft = () => {
  tone({ freq: 698, gain: 0.09, duration: 0.25 });
  tone({ freq: 1047, gain: 0.07, delay: 0.1, duration: 0.3 });
};

// VOICE LEAVE / Fall — descending C6-G5-E5-C5.
const sfxLeaveFall = () => {
  [1047, 784, 659, 523].forEach((freq, i) =>
    tone({ freq, gain: 0.09 - i * 0.01, delay: i * 0.06, duration: 0.22 })
  );
};

// VOICE LEAVE / Soft — gentle two-note C6→F5.
const sfxLeaveSoft = () => {
  tone({ freq: 1047, gain: 0.08, duration: 0.22 });
  tone({ freq: 698, gain: 0.08, delay: 0.1, duration: 0.3 });
};

// Plucked-string note: sawtooth through a lowpass whose cutoff decays
// fast (pick attack -> palm-muted body), plus a strike transient so the
// low register still reads on laptop speakers.
const pluck = (
  freq: number,
  delay: number,
  gain: number,
  dur = 0.16,
  bright = 2200,
  space = 0
) => {
  const t0 = now() + delay;
  const osc = audioCtx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(freq, t0);

  const filt = audioCtx.createBiquadFilter();
  filt.type = 'lowpass';
  filt.Q.value = 1.1;
  filt.frequency.setValueAtTime(bright, t0);
  filt.frequency.exponentialRampToValueAtTime(
    Math.max(freq * 2, 180),
    t0 + dur
  );

  const g = audioCtx.createGain();
  const peak = gain * SOUNDS_VOLUME * getMasterVolumeMultiplier();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

  osc.connect(filt).connect(g).connect(audioCtx.destination);
  if (space) {
    const send = audioCtx.createGain();
    send.gain.value = space;
    g.connect(send).connect(getSpaceBus());
  }
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);

  // thumb-strike click
  tone({
    type: 'triangle',
    freq: Math.min(freq * 8, 3200),
    gain: gain * 0.1,
    delay,
    duration: 0.018,
    attack: 0.001
  });
};

// INCOMING_CALL / Groove — a dark, syncopated thumb-thump riff on a
// low E: palm-muted low hits with a phrygian b5 color, rests where a
// straight ring would put beats, and popped high accents answering the
// lows. ~2.3s, sized for the modal's 2.5s replay loop.
const sfxCallGroove = () => {
  const S = 0.135; // one sixteenth at ~111 BPM
  const lo = (step: number, freq: number, gain = 0.12) =>
    pluck(freq, step * S, gain, 0.14, 1600);
  const pop = (step: number, freq: number, gain = 0.07) =>
    pluck(freq, step * S, gain, 0.11, 5200);

  const E2 = 82.4,
    G2 = 98,
    Bb2 = 116.5,
    B2 = 123.5,
    D3 = 146.8;
  const E4 = 329.6,
    Fs4 = 370,
    G4 = 392;

  lo(0, E2, 0.14); // accented downbeat
  lo(1, E2, 0.05); // ghost
  pop(2, G4);
  // rest
  lo(4, E2, 0.12);
  lo(5, Bb2, 0.12); // b5 — the dark color note
  // rest
  pop(7, E4);
  lo(8, E2, 0.13);
  // rest
  lo(10, D3, 0.11);
  lo(11, B2, 0.11);
  lo(12, G2, 0.13); // accent
  // rest
  pop(14, Fs4);
  pop(15, E4, 0.06); // quick two-note fill
  pluck(E2, 16 * S, 0.15, 0.34, 1400); // closing hit, longer ring
  pluck(E2 * 2, 16 * S, 0.04, 0.3, 1400); // octave body on the close
};

// INCOMING_CALL / Ascent — E harmonic minor on the pluck engine, set
// in a reverb/delay space. The centerpiece is a rising
// 6th->octave->12th->double-octave arpeggio (C4 E4 B4 E5), answered by
// a leaned-on 6->5 sigh (C5->B4), a 3->2 step (G4->F#4), the raised
// 7th (D#) pulling home, and a 5->2->root close (B3->F#3->E3).
// Underneath, a soft droning bass DESCENDS its lament — 6 -> b2 ->
// root (C3 -> F2 -> E2), the final half-step drop landing with the
// melody's root.
const sfxCallAscent = () => {
  const S = 0.14;
  // Lead is the velvet voice (hollow beating partial stack), sent
  // deep into the reverb/delay space.
  const n = (step: number, freq: number, gain = 0.05, dur = 0.6) =>
    velvet(freq, step * S, gain, dur, 0.7);

  // Soft pad chord, voices listed ascending; swells with its bass note.
  const pad = (freqs: number[], delay: number, dur: number, gain = 0.034) =>
    freqs.forEach((f, i) =>
      tone({
        freq: f,
        gain: gain - i * 0.004,
        delay,
        duration: dur,
        attack: 0.1,
        space: 0.6
      })
    );

  // D minor. One chord per bass note: Bb D A over the 6, Eb G D over
  // the b2, and an open D A C E at the close.
  pad([233.1, 293.7, 440], 0, 1.15); // Bb3 D4 A4
  pad([155.6, 196, 293.7], 1.05, 1.2); // Eb3 G3 D4
  pad([146.8, 220, 261.6, 329.6], 2.2, 1.0); // D3 A3 C4 E4

  // Soft descending bass drones (slow attacks, sine) — each handing
  // off to the next: Bb2 under the climb, Eb2 under the descent, D2
  // at the close via the b2->1 half-step.
  tone({ freq: 116.5, gain: 0.05, duration: 1.2, attack: 0.1, space: 0.4 }); // Bb2
  tone({
    freq: 77.8,
    gain: 0.055,
    delay: 1.05,
    duration: 1.25,
    attack: 0.1,
    space: 0.4
  }); // Eb2
  tone({
    freq: 73.4,
    gain: 0.06,
    delay: 2.2,
    duration: 1.0,
    attack: 0.07,
    space: 0.5
  }); // D2 — root lands with the close

  // The climb: 6 -> 8 -> 12 -> 15 — short enough that each note hands
  // off instead of stacking into a cluster
  n(1, 233.1, 0.05, 0.3); // Bb3 (b6)
  n(2, 293.7, 0.05, 0.3); // D4 (octave)
  n(3, 440, 0.055, 0.35); // A4 (12th)
  n(4, 587.3, 0.065, 1.0); // D5 (double octave) — arrival, long ring
  // breath at 6

  // The answer: one spaced falling line — 3 -> 2 -> 1 stepping down,
  // then 5 -> 2 -> root an octave below, the last pair landing tight.
  n(7, 349.2, 0.055, 0.45); // F4 (3)
  n(9, 329.6, 0.05, 0.45); // E4 (2)
  n(11, 293.7, 0.05, 0.45); // D4 (1)
  n(13, 220, 0.048, 0.45); // A3 (5)
  n(15, 164.8, 0.05, 0.42); // E3 (2) — leans in...
  velvet(146.8, 16 * S, 0.06, 1.7, 0.75); // ...D root lands right on its heels
};

// Chip voice: gated envelope (attack, hold, quick release) instead of
// a natural decay — the sound of a hardware channel being switched.
const chip = (
  freq: number,
  delay: number,
  gain: number,
  dur = 0.16,
  type: OscillatorType = 'square'
) => {
  const t0 = now() + delay;
  const osc = createOsc(type, freq);
  const g = audioCtx.createGain();
  const peak = gain * SOUNDS_VOLUME * getMasterVolumeMultiplier();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + 0.005);
  g.gain.setValueAtTime(peak, t0 + Math.max(0.005, dur - 0.035));
  g.gain.linearRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(audioCtx.destination);
  const send = audioCtx.createGain();
  send.gain.value = 0.3;
  g.connect(send).connect(getSpaceBus());
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
};

// Chord as a rapid cycling arpeggio — the classic single-channel-chord
// workaround, ~42ms per step.
const chipArp = (
  freqs: number[],
  delay: number,
  dur: number,
  gain = 0.026,
  step = 0.042
) => {
  for (let t = 0, i = 0; t + step <= dur; t += step, i++) {
    chip(freqs[i % freqs.length], delay + t, gain, step * 0.9);
  }
};

// INCOMING_CALL / Aimless '84 — the same D-minor piece as Aimless
// (climb, spaced falling answer, Bb->Eb->D descending bass, the three
// chords) re-rendered as retro hardware: square lead, triangle bass,
// chords as cycling chip arps, light echo for the sheen.
const sfxCallAscent84 = () => {
  const S = 0.14;
  const lead = (step: number, freq: number, gain = 0.05, dur = 0.15) =>
    chip(freq, step * S, gain, dur);

  // Triangle bass descent: 6 -> b2 -> root
  chip(116.5, 0, 0.12, 1.05, 'triangle'); // Bb2
  chip(77.8, 1.05, 0.13, 1.15, 'triangle'); // Eb2
  chip(73.4, 2.2, 0.13, 0.9, 'triangle'); // D2

  // Chord arps riding each bass note
  chipArp([233.1, 293.7, 440], 0.02, 1.0); // Bb D A
  chipArp([155.6, 196, 293.7], 1.07, 1.1); // Eb G D
  chipArp([146.8, 220, 261.6, 329.6], 2.22, 0.75); // D A C E

  // The climb: 6 -> 8 -> 12 -> 15
  lead(1, 233.1); // Bb3
  lead(2, 293.7); // D4
  lead(3, 440, 0.055); // A4
  lead(4, 587.3, 0.06, 0.34); // D5 arrival, held

  // The spaced falling answer: 3 . 2 . 1 . 5 . 2, close on the root
  lead(7, 349.2, 0.05, 0.22); // F4 (3)
  lead(9, 329.6, 0.048, 0.22); // E4 (2)
  lead(11, 293.7, 0.048, 0.22); // D4 (1)
  lead(13, 220, 0.045, 0.22); // A3 (5)
  lead(15, 164.8, 0.048, 0.2); // E3 (2)
  chip(146.8, 16 * S, 0.055, 0.45); // D3 close, held gate
  chip(293.7, 16 * S, 0.02, 0.45); // octave shimmer above
};


// Velvet voice — modeled on an analyzed vintage-character patch: a
// HOLLOW partial stack (harmonics 2/3/4/5 with the 4th strongest, no
// fundamental), each partial a pair detuned by a fixed ±1.15 Hz so the
// whole note beats at ~2.3Hz like two drifting analog oscillators,
// everything lowpassed at ~1.5kHz, instant attack, long ring.
const velvet = (
  f0: number,
  delay: number,
  gain: number,
  dur: number,
  space = 0.35
) => {
  const t0 = now() + delay;
  const filt = audioCtx.createBiquadFilter();
  filt.type = 'lowpass';
  filt.frequency.value = 1500;
  filt.Q.value = 0.5;

  // Flute-shaped envelope: soft swell in, HELD at full voice, then a
  // gentle taper — no strike, no click. The beating partial stack does
  // its breathing across the sustained body.
  const g = audioCtx.createGain();
  const peak = gain * SOUNDS_VOLUME * getMasterVolumeMultiplier();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + Math.min(0.07, dur * 0.2));
  g.gain.setValueAtTime(peak, t0 + dur * 0.45);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  filt.connect(g).connect(audioCtx.destination);

  const send = audioCtx.createGain();
  send.gain.value = space;
  g.connect(send).connect(getSpaceBus());

  // Held tones need a fundamental-dominant spectrum — the original
  // hollow stack un-fuses into separate audible pitches when
  // sustained. Beating pairs stay on the low partials only (the
  // breathing), single clean oscillators above.
  const partials: [number, number][] = [
    [1, 1.0],
    [2, 0.5],
    [3, 0.15],
    [4, 0.08]
  ];
  for (const [mult, level] of partials) {
    const f = f0 * mult;
    if (f > 4000) continue;
    if (mult <= 2) {
      for (const [off, split] of [
        [-1.15, 0.6],
        [1.15, 0.4]
      ] as const) {
        const osc = createOsc('sine', f + off);
        const og = audioCtx.createGain();
        og.gain.value = level * split * 0.5;
        osc.connect(og).connect(filt);
        osc.start(t0);
        osc.stop(t0 + dur + 0.05);
      }
    } else {
      const osc = createOsc('sine', f);
      const og = audioCtx.createGain();
      og.gain.value = level * 0.5;
      osc.connect(og).connect(filt);
      osc.start(t0);
      osc.stop(t0 + dur + 0.05);
    }
  }
};

// INCOMING_CALL / Nocturne — the same harmonic-minor vocabulary as
// sustained sighs over a quiet root drone: 6->5, then 3->2, then the
// raised 7th resolving up to the octave. Slow, dark, patient.
const sfxCallNocturne = () => {
  // Root drone
  tone({ freq: 164.8, gain: 0.05, duration: 2.3, attack: 0.05 }); // E3
  tone({ freq: 246.9, gain: 0.025, duration: 2.3, attack: 0.05 }); // B3 (5th)

  // 6 -> 5 sigh
  tone({ freq: 523.3, gain: 0.085, duration: 0.55, attack: 0.03 }); // C5
  tone({ freq: 493.9, gain: 0.075, delay: 0.38, duration: 0.6, attack: 0.03 }); // B4

  // 3 -> 2
  tone({ freq: 392, gain: 0.07, delay: 0.95, duration: 0.5, attack: 0.03 }); // G4
  tone({ freq: 370, gain: 0.065, delay: 1.28, duration: 0.55, attack: 0.03 }); // F#4

  // Raised 7th rising home — the harmonic-minor pull
  tone({ freq: 622.3, gain: 0.07, delay: 1.7, duration: 0.35, attack: 0.02 }); // D#5
  tone({ freq: 659.3, gain: 0.09, delay: 1.95, duration: 0.5, attack: 0.02 }); // E5
  tone({ freq: 329.6, gain: 0.04, delay: 1.95, duration: 0.5, attack: 0.02 }); // E4 body
};

// INCOMING_CALL / Retro — square-wave dual-tone telephone ring bursts.
const sfxCallRetro = () => {
  for (const burst of [0, 0.55]) {
    for (let i = 0; i < 8; i++) {
      tone({
        type: 'square',
        freq: 440,
        gain: 0.02,
        delay: burst + i * 0.045,
        duration: 0.035
      });
      tone({
        type: 'square',
        freq: 480,
        gain: 0.02,
        delay: burst + i * 0.045,
        duration: 0.035
      });
    }
  }
};

// INCOMING_CALL / Digital — rising marimba triplet, twice.
const sfxCallDigital = () => {
  for (const burst of [0, 0.5]) {
    [784, 988, 1319].forEach((freq, i) =>
      tone({
        freq,
        gain: 0.1,
        delay: burst + i * 0.09,
        duration: 0.16,
        attack: 0.003
      })
    );
  }
};

// --- The Ascent family: the call tone's harmonic-minor language
// (velvet voice, 6->5 sighs, climbs, spaced descents) distilled into a
// short motif per event, each in its OWN key so overlapping
// notifications never clash. Messages are deliberately brief gestures.

// MESSAGE_RECEIVED — A minor: just the 6->5 sigh (F->E) over a root
// touch. ~0.6s.
const sfxReceivedAscent = () => {
  // A compact sigh — two notes, done in ~0.3s. The space send stays
  // low; the deep wash belongs to the call tone.
  velvet(698.5, 0, 0.09, 0.18, 0.2); // F5 (6)
  velvet(659.3, 0.12, 0.085, 0.3, 0.22); // E5 (5)
};

// MESSAGE_SENT — G minor: the shortest gesture in the family, a
// ~0.2s flick up from 5 to root.
const sfxSentAscent = () => {
  velvet(587.3, 0, 0.05, 0.1, 0.12); // D5 (5)
  velvet(784, 0.07, 0.055, 0.18, 0.15); // G5 (root)
};

// JOIN VOICE — B minor: the climb's first three steps (6 -> 8 -> 12),
// compacted to ~0.6s.
const sfxJoinAscent = () => {
  velvet(123.5, 0, 0.04, 0.5, 0.12); // B2 root under
  velvet(392, 0.01, 0.05, 0.2, 0.18); // G4 (6)
  velvet(493.9, 0.12, 0.05, 0.2, 0.18); // B4 (8)
  velvet(740, 0.23, 0.055, 0.42, 0.22); // F#5 (12)
};

// LEAVE VOICE — F# minor: join's mirror — a falling 5 -> 3 -> 1
// arpeggio settling on the root. ~0.6s.
const sfxLeaveAscent = () => {
  velvet(92.5, 0, 0.04, 0.55, 0.12); // F#2 root under
  velvet(554.4, 0, 0.05, 0.2, 0.18); // C#5 (5)
  velvet(440, 0.12, 0.05, 0.2, 0.18); // A4 (3)
  velvet(370, 0.24, 0.055, 0.45, 0.22); // F#4 (1)
};

export type TSoundVariant = {
  id: string;
  label: string;
  play: () => void;
};

/**
 * Selectable variants per event — index 0 is the default. The old
 * synths stay available as "Classic" so nobody's muscle memory breaks;
 * MESSAGE_RECEIVED defaults to the new Chime (the classic ping was too
 * short and quiet to notice).
 */
export const SOUND_VARIANTS: Partial<Record<SoundType, TSoundVariant[]>> = {
  [SoundType.MESSAGE_RECEIVED]: [
    { id: 'aimless', label: 'Aimless', play: sfxReceivedAscent },
    { id: 'chime', label: 'Chime', play: sfxReceivedChime },
    { id: 'classic', label: 'Classic', play: () => sfxMessageReceived() },
    { id: 'bell', label: 'Bell', play: sfxReceivedBell },
    { id: 'marimba', label: 'Marimba', play: sfxReceivedMarimba },
    { id: 'bubble', label: 'Bubble', play: sfxReceivedBubble }
  ],
  [SoundType.MESSAGE_SENT]: [
    { id: 'aimless', label: 'Aimless', play: sfxSentAscent },
    { id: 'classic', label: 'Classic', play: () => sfxMessageSent() },
    { id: 'pop', label: 'Pop', play: sfxSentPop },
    { id: 'whoosh', label: 'Whoosh', play: sfxSentWhoosh }
  ],
  [SoundType.OWN_USER_JOINED_VOICE_CHANNEL]: [
    { id: 'aimless', label: 'Aimless', play: sfxJoinAscent },
    { id: 'classic', label: 'Classic', play: () => sfxOwnUserJoinedVoiceChannel() },
    { id: 'rise', label: 'Rise', play: sfxJoinRise },
    { id: 'soft', label: 'Soft', play: sfxJoinSoft }
  ],
  [SoundType.OWN_USER_LEFT_VOICE_CHANNEL]: [
    { id: 'aimless', label: 'Aimless', play: sfxLeaveAscent },
    { id: 'classic', label: 'Classic', play: () => sfxOwnUserLeftVoiceChannel() },
    { id: 'fall', label: 'Fall', play: sfxLeaveFall },
    { id: 'soft', label: 'Soft', play: sfxLeaveSoft }
  ],
  [SoundType.INCOMING_CALL]: [
    { id: 'aimless', label: 'Aimless', play: sfxCallAscent },
    { id: 'groove', label: 'Groove', play: sfxCallGroove },
    { id: 'aimless84', label: "Aimless '84", play: sfxCallAscent84 },
    { id: 'nocturne', label: 'Nocturne', play: sfxCallNocturne },
    { id: 'classic', label: 'Classic', play: () => sfxIncomingCall() },
    { id: 'retro', label: 'Retro Ring', play: sfxCallRetro },
    { id: 'digital', label: 'Digital', play: sfxCallDigital }
  ]
};

/** Resolve the selected (or default) variant for an event. */
const resolveVariant = (type: SoundType): TSoundVariant | undefined => {
  const variants = SOUND_VARIANTS[type];
  if (!variants) return undefined;
  const selected = getSelectedSoundVariant(type);
  return variants.find((v) => v.id === selected) ?? variants[0];
};

export const playSound = (type: SoundType) => {
  if (!isCategoryEnabledForSound(type)) return;

  // Events with selectable variants play the user's pick.
  const variant = resolveVariant(type);
  if (variant) return variant.play();

  switch (type) {
    case SoundType.MESSAGE_RECEIVED:
      return sfxMessageReceived();
    case SoundType.MESSAGE_SENT:
      return sfxMessageSent();

    case SoundType.OWN_USER_JOINED_VOICE_CHANNEL:
      return sfxOwnUserJoinedVoiceChannel();
    case SoundType.OWN_USER_LEFT_VOICE_CHANNEL:
      return sfxOwnUserLeftVoiceChannel();

    case SoundType.OWN_USER_MUTED_MIC:
      return sfxOwnUserMutedMic();
    case SoundType.OWN_USER_UNMUTED_MIC:
      return sfxOwnUserUnmutedMic();

    case SoundType.OWN_USER_MUTED_SOUND:
      return sfxOwnUserMutedSound();
    case SoundType.OWN_USER_UNMUTED_SOUND:
      return sfxOwnUserUnmutedSound();

    case SoundType.OWN_USER_STARTED_WEBCAM:
      return sfxOwnUserStartedWebcam();
    case SoundType.OWN_USER_STOPPED_WEBCAM:
      return sfxOwnUserStoppedWebcam();

    case SoundType.OWN_USER_STARTED_SCREENSHARE:
      return sfxOwnUserStartedScreenshare();
    case SoundType.OWN_USER_STOPPED_SCREENSHARE:
      return sfxOwnUserStoppedScreenshare();

    case SoundType.REMOTE_USER_JOINED_VOICE_CHANNEL:
      return sfxRemoteUserJoinedVoiceChannel();
    case SoundType.REMOTE_USER_LEFT_VOICE_CHANNEL:
      return sfxRemoteUserLeftVoiceChannel();
    case SoundType.REMOTE_USER_STARTED_SCREENSHARE:
      return sfxRemoteUserStartedScreenshare();

    case SoundType.INCOMING_CALL:
      return sfxIncomingCall();

    default:
      return;
  }
};

// INCOMING_CALL — classic two-tone "ring" pattern (Eb + Bb), repeated
// twice in quick succession to read as a phone ring rather than a
// notification ping. The IncomingCallModal calls playSound() on a
// 2.5s interval so the ring continues while the modal is open.
const sfxIncomingCall = () => {
  // Resume AudioContext if suspended (browsers require user gesture
  // and reload may suspend).
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }

  const ring = (offset: number) => {
    // First tone — Eb5
    const osc1 = createOsc('sine', 622);
    const gain1 = createGain(0.08);
    gain1.gain.setValueAtTime(0, now() + offset);
    gain1.gain.linearRampToValueAtTime(
      0.08 * SOUNDS_VOLUME * getMasterVolumeMultiplier(),
      now() + offset + 0.02
    );
    gain1.gain.exponentialRampToValueAtTime(0.0001, now() + offset + 0.18);
    osc1.connect(gain1).connect(audioCtx.destination);
    osc1.start(now() + offset);
    osc1.stop(now() + offset + 0.2);

    // Second tone — Bb5 (perfect fifth above)
    const osc2 = createOsc('sine', 932);
    const gain2 = createGain(0.07);
    gain2.gain.setValueAtTime(0, now() + offset + 0.18);
    gain2.gain.linearRampToValueAtTime(
      0.07 * SOUNDS_VOLUME * getMasterVolumeMultiplier(),
      now() + offset + 0.2
    );
    gain2.gain.exponentialRampToValueAtTime(0.0001, now() + offset + 0.36);
    osc2.connect(gain2).connect(audioCtx.destination);
    osc2.start(now() + offset + 0.18);
    osc2.stop(now() + offset + 0.38);
  };

  ring(0);
  ring(0.5);
};

/** Play a sound for the settings preview buttons (skips category gate).
 *  With `variantId`, previews that specific variant; otherwise plays
 *  whatever the user currently has selected (or the default). */
export const playSoundForPreview = (type: SoundType, variantId?: string) => {
  // Resume AudioContext if suspended (browsers require user gesture)
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }

  const variants = SOUND_VARIANTS[type];
  if (variants) {
    const variant = variantId
      ? variants.find((v) => v.id === variantId)
      : resolveVariant(type);
    if (variant) return variant.play();
  }

  switch (type) {
    case SoundType.MESSAGE_RECEIVED:
      return sfxMessageReceived();
    case SoundType.MESSAGE_SENT:
      return sfxMessageSent();
    case SoundType.OWN_USER_JOINED_VOICE_CHANNEL:
      return sfxOwnUserJoinedVoiceChannel();
    case SoundType.OWN_USER_LEFT_VOICE_CHANNEL:
      return sfxOwnUserLeftVoiceChannel();
    case SoundType.OWN_USER_MUTED_MIC:
      return sfxOwnUserMutedMic();
    case SoundType.OWN_USER_UNMUTED_MIC:
      return sfxOwnUserUnmutedMic();
    case SoundType.OWN_USER_MUTED_SOUND:
      return sfxOwnUserMutedSound();
    case SoundType.OWN_USER_UNMUTED_SOUND:
      return sfxOwnUserUnmutedSound();
    case SoundType.OWN_USER_STARTED_WEBCAM:
      return sfxOwnUserStartedWebcam();
    case SoundType.OWN_USER_STOPPED_WEBCAM:
      return sfxOwnUserStoppedWebcam();
    case SoundType.OWN_USER_STARTED_SCREENSHARE:
      return sfxOwnUserStartedScreenshare();
    case SoundType.OWN_USER_STOPPED_SCREENSHARE:
      return sfxOwnUserStoppedScreenshare();
    case SoundType.REMOTE_USER_JOINED_VOICE_CHANNEL:
      return sfxRemoteUserJoinedVoiceChannel();
    case SoundType.REMOTE_USER_LEFT_VOICE_CHANNEL:
      return sfxRemoteUserLeftVoiceChannel();
    case SoundType.REMOTE_USER_STARTED_SCREENSHARE:
      return sfxRemoteUserStartedScreenshare();
    default:
      return;
  }
};
