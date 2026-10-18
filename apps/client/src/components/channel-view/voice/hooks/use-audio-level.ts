import { useOwnVoiceUser } from '@/features/server/hooks';
import { useEffect, useState } from 'react';
import {
  acquireAnalyserContext,
  levelFromFrequencyData,
  quantizeSpeakingLevel,
  releaseAnalyserContext,
  SpeakingIntensity
} from './speaking-level';

const ANALYZER_FFT_SIZE = 512;
const ANALYZER_MIN_DECIBELS = -90;
const ANALYZER_MAX_DECIBELS = -10;
const ANALYZER_SMOOTHING_TIME_CONSTANT = 0.85;
// The ring only has four states, so sampling the analyser at ~20 Hz is
// plenty; the frame loop skips frames in between.
const SAMPLE_INTERVAL_MS = 50;

/**
 * Speaking indicator for one audio stream. State changes only when the
 * quantized intensity does — the analyser loop itself never commits to
 * React, so a quiet call renders nothing per frame.
 */
const useAudioLevel = (audioStream: MediaStream | undefined) => {
  const [speakingIntensity, setSpeakingIntensity] = useState(
    SpeakingIntensity.Silent
  );
  const ownVoiceUser = useOwnVoiceUser();
  const soundMuted = ownVoiceUser?.state.soundMuted === true;

  useEffect(() => {
    if (!audioStream || soundMuted) {
      setSpeakingIntensity(SpeakingIntensity.Silent);
      return;
    }

    let analyser: AnalyserNode;
    let source: MediaStreamAudioSourceNode;
    let acquired = false;

    try {
      const audioContext = acquireAnalyserContext();
      acquired = true;
      analyser = audioContext.createAnalyser();
      analyser.fftSize = ANALYZER_FFT_SIZE;
      analyser.minDecibels = ANALYZER_MIN_DECIBELS;
      analyser.maxDecibels = ANALYZER_MAX_DECIBELS;
      analyser.smoothingTimeConstant = ANALYZER_SMOOTHING_TIME_CONSTANT;
      source = audioContext.createMediaStreamSource(audioStream);
      source.connect(analyser);
    } catch (error) {
      // No Web Audio, or the stream cannot be analysed: the card simply
      // shows no ring. Surfaced in development only.
      if (acquired) releaseAnalyserContext({ failed: true });
      if (import.meta.env.DEV) {
        console.warn('Speaking indicator unavailable:', error);
      }
      setSpeakingIntensity(SpeakingIntensity.Silent);
      return;
    }

    const data = new Uint8Array(analyser.frequencyBinCount);
    let frame: number | null = null;
    let lastSampleAt = 0;
    let last = SpeakingIntensity.Silent;

    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      if (now - lastSampleAt < SAMPLE_INTERVAL_MS) return;
      lastSampleAt = now;

      analyser.getByteFrequencyData(data);
      const next = quantizeSpeakingLevel(levelFromFrequencyData(data));
      if (next !== last) {
        last = next;
        setSpeakingIntensity(next);
      }
    };

    frame = requestAnimationFrame(tick);

    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      source.disconnect();
      analyser.disconnect();
      releaseAnalyserContext();
      setSpeakingIntensity(SpeakingIntensity.Silent);
    };
  }, [audioStream, soundMuted]);

  return {
    isSpeaking: speakingIntensity !== SpeakingIntensity.Silent,
    speakingIntensity
  };
};

export { useAudioLevel };
