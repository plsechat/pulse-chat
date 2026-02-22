import {
  getMasterVolumeMultiplier,
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

export const playSound = (type: SoundType) => {
  if (!isCategoryEnabledForSound(type)) return;

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

    default:
      return;
  }
};

/** Play a sound for the settings preview buttons (skips category gate). */
export const playSoundForPreview = (type: SoundType) => {
  // Resume AudioContext if suspended (browsers require user gesture)
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
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
    default:
      return;
  }
};
