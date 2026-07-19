import { logVoice } from '@/helpers/browser-logger';
import type { NoiseSuppressionMode } from '@/types';

export const NOISE_GATE_MIN_DB = -90;
export const NOISE_GATE_MAX_DB = 0;
export const DEFAULT_NOISE_GATE_THRESHOLD_DB = -50;

/** Map a dBFS level onto a 0-100 meter percentage. */
export const dbToMeterPercent = (db: number) =>
  Math.min(
    100,
    Math.max(
      0,
      ((db - NOISE_GATE_MIN_DB) / (NOISE_GATE_MAX_DB - NOISE_GATE_MIN_DB)) * 100
    )
  );

export type TMicConstraintSettings = {
  deviceId: string | undefined;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
};

/** The one place microphone getUserMedia constraints are built. */
export const buildMicConstraints = (
  settings: TMicConstraintSettings
): MediaStreamConstraints => ({
  audio: {
    deviceId: settings.deviceId ? { exact: settings.deviceId } : undefined,
    autoGainControl: settings.autoGainControl,
    echoCancellation: settings.echoCancellation,
    noiseSuppression: settings.noiseSuppression,
    sampleRate: 48000,
    channelCount: 2
  },
  video: false
});

// Gate envelope: fast open so the first syllable isn't clipped, a hold so
// natural inter-word pauses don't flutter the gate, and a gentle close.
const GATE_ATTACK_TIME_CONSTANT = 0.008; // ~25ms to fully open
const GATE_RELEASE_TIME_CONSTANT = 0.06; // ~180ms to fully close
const GATE_HOLD_SECONDS = 0.25;
const LEVEL_EMIT_INTERVAL_MS = 50;
// ScriptProcessor over AudioWorklet: the analysis runs on the audio render
// quantum, so gating keeps working when the tab is backgrounded (regular
// timers get throttled to >=1s there, which would chop speech).
const ANALYSIS_BUFFER_SIZE = 1024;

/**
 * WebAudio noise gate: source -> gain (the gate) -> MediaStream destination,
 * with a ScriptProcessor tap measuring input level in dBFS. Also usable as a
 * bare level probe (settings meter) via the onLevel callback.
 */
export class MicNoiseGate {
  private ctx: AudioContext;
  private source: MediaStreamAudioSourceNode | null = null;
  private gateGain: GainNode;
  private analysisNode: ScriptProcessorNode;
  private destination: MediaStreamAudioDestinationNode;
  private thresholdDb: number;
  private holdUntil = 0;
  private open = false;
  private smoothedDb = NOISE_GATE_MIN_DB;
  private lastLevelEmit = 0;

  onLevel: ((db: number, gateOpen: boolean) => void) | null = null;

  constructor(thresholdDb: number) {
    this.thresholdDb = thresholdDb;
    this.ctx = new AudioContext();

    this.gateGain = this.ctx.createGain();
    this.gateGain.gain.value = 0; // gate starts closed
    this.destination = this.ctx.createMediaStreamDestination();
    this.gateGain.connect(this.destination);

    this.analysisNode = this.ctx.createScriptProcessor(
      ANALYSIS_BUFFER_SIZE,
      2,
      2
    );
    this.analysisNode.onaudioprocess = this.processBlock;
    // Output buffers are never written, so this contributes silence — the
    // destination connection only exists to keep the node processing.
    this.analysisNode.connect(this.ctx.destination);
  }

  private processBlock = (event: AudioProcessingEvent) => {
    const input = event.inputBuffer;
    let sum = 0;
    let count = 0;

    for (let channel = 0; channel < input.numberOfChannels; channel++) {
      const samples = input.getChannelData(channel);
      for (let i = 0; i < samples.length; i += 4) {
        sum += samples[i] * samples[i];
        count++;
      }
    }

    const rms = Math.sqrt(sum / Math.max(1, count));
    const db =
      rms > 0
        ? Math.max(NOISE_GATE_MIN_DB, 20 * Math.log10(rms))
        : NOISE_GATE_MIN_DB;

    // Fast-attack / slow-release envelope for the meter readout
    this.smoothedDb =
      db > this.smoothedDb
        ? db
        : this.smoothedDb + (db - this.smoothedDb) * 0.25;

    const now = this.ctx.currentTime;

    if (db >= this.thresholdDb) {
      this.holdUntil = now + GATE_HOLD_SECONDS;
      if (!this.open) {
        this.open = true;
        this.gateGain.gain.cancelScheduledValues(now);
        this.gateGain.gain.setTargetAtTime(1, now, GATE_ATTACK_TIME_CONSTANT);
      }
    } else if (this.open && now > this.holdUntil) {
      this.open = false;
      this.gateGain.gain.cancelScheduledValues(now);
      this.gateGain.gain.setTargetAtTime(0, now, GATE_RELEASE_TIME_CONSTANT);
    }

    if (this.onLevel) {
      const wallClock = performance.now();
      if (wallClock - this.lastLevelEmit >= LEVEL_EMIT_INTERVAL_MS) {
        this.lastLevelEmit = wallClock;
        this.onLevel(this.smoothedDb, this.open);
      }
    }
  };

  setSource(stream: MediaStream) {
    this.source?.disconnect();
    this.source = this.ctx.createMediaStreamSource(stream);
    this.source.connect(this.gateGain);
    this.source.connect(this.analysisNode);

    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  setThreshold(db: number) {
    this.thresholdDb = db;
  }

  /**
   * The gated track to hand to the producer. mediasoup stops replaced
   * tracks, so a dead destination track (e.g. after a mute) is transparently
   * replaced with a fresh destination node.
   */
  getOutputTrack(): MediaStreamTrack | null {
    let track = this.destination.stream.getAudioTracks()[0] ?? null;

    if (!track || track.readyState !== 'live') {
      this.gateGain.disconnect(this.destination);
      this.destination = this.ctx.createMediaStreamDestination();
      this.gateGain.connect(this.destination);
      track = this.destination.stream.getAudioTracks()[0] ?? null;
    }

    return track;
  }

  suspend() {
    this.ctx.suspend().catch(() => {});
  }

  destroy() {
    this.onLevel = null;
    this.analysisNode.onaudioprocess = null;
    try {
      this.source?.disconnect();
      this.analysisNode.disconnect();
      this.gateGain.disconnect();
    } catch {
      // nodes may already be disconnected
    }
    this.ctx.close().catch(() => {});
  }
}

/**
 * Owns the microphone capture end-to-end: the raw getUserMedia stream, the
 * optional noise-gate graph, and the single output track the audio producer
 * sends. Every mic transition (join, unmute, device/setting change,
 * screen-share EC handoff) acquires through here, and the producer is always
 * created with stopTracks:false — the pipeline is the only owner of track
 * lifecycle.
 */
export class MicPipeline {
  private rawStream: MediaStream | null = null;
  private gate: MicNoiseGate | null = null;
  private mode: NoiseSuppressionMode;
  private thresholdDb: number;

  onRawTrackEnded: (() => void) | null = null;

  constructor(mode: NoiseSuppressionMode, thresholdDb: number) {
    this.mode = mode;
    this.thresholdDb = thresholdDb;
  }

  get stream(): MediaStream | null {
    return this.rawStream;
  }

  /** Acquire (or re-acquire) the microphone. Stops any previous capture. */
  async acquire(settings: TMicConstraintSettings): Promise<MediaStream> {
    this.stopRawTracks();

    const stream = await navigator.mediaDevices.getUserMedia(
      buildMicConstraints(settings)
    );
    this.rawStream = stream;

    const rawTrack = stream.getAudioTracks()[0];
    if (rawTrack) {
      // Fires on device unplug / OS-level capture revocation, NOT on our own
      // track.stop() calls.
      rawTrack.onended = () => {
        logVoice('Raw microphone track ended');
        this.onRawTrackEnded?.();
      };
    }

    this.syncGraph();
    return stream;
  }

  setMode(mode: NoiseSuppressionMode) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.syncGraph();
  }

  setThreshold(db: number) {
    this.thresholdDb = db;
    this.gate?.setThreshold(db);
  }

  private syncGraph() {
    if (this.mode === 'manual') {
      if (this.rawStream) {
        if (!this.gate) {
          this.gate = new MicNoiseGate(this.thresholdDb);
        }
        this.gate.setThreshold(this.thresholdDb);
        this.gate.setSource(this.rawStream);
      }
    } else if (this.gate) {
      this.gate.destroy();
      this.gate = null;
    }
  }

  /** The track to produce/replaceTrack with (gated in manual mode, raw otherwise). */
  getOutputTrack(): MediaStreamTrack | null {
    if (!this.rawStream) return null;

    if (this.mode === 'manual' && this.gate) {
      return this.gate.getOutputTrack();
    }

    return this.rawStream.getAudioTracks()[0] ?? null;
  }

  /** Release the microphone (turns the device indicator off). Keeps the gate graph for reuse. */
  release() {
    this.stopRawTracks();
    this.rawStream = null;
    this.gate?.suspend();
  }

  private stopRawTracks() {
    this.rawStream?.getAudioTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
  }

  destroy() {
    this.release();
    this.gate?.destroy();
    this.gate = null;
    this.onRawTrackEnded = null;
  }
}
