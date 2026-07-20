import { useCurrentVoiceChannelId } from '@/features/server/channels/hooks';
import { playSound } from '@/features/server/sounds/actions';
import { SoundType } from '@/features/server/types';
import { logVoice } from '@/helpers/browser-logger';
import { getResWidthHeight } from '@/helpers/get-res-with-height';
import { getTRPCClient } from '@/lib/trpc';
import { StreamKind } from '@pulse/shared';
import { Device } from 'mediasoup-client';
import type { RtpCapabilities } from 'mediasoup-client/types';
import {
  createContext,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import { useDevices } from '../devices-provider/hooks/use-devices';
import type { TDeviceSettings } from '@/types';
import { FloatingPinnedCard } from './floating-pinned-card';
import { useLocalStreams } from './hooks/use-local-streams';
import { MicPipeline } from './mic-pipeline';
import { useRemoteStreams } from './hooks/use-remote-streams';
import {
  useTransportStats,
  type TransportStatsData
} from './hooks/use-transport-stats';
import { useTransports } from './hooks/use-transports';
import { useVoiceControls } from './hooks/use-voice-controls';
import { useVoiceEvents } from './hooks/use-voice-events';
import { VolumeControlProvider } from './volume-control-context';

type AudioVideoRefs = {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  audioRef: React.RefObject<HTMLAudioElement | null>;
  screenShareRef: React.RefObject<HTMLVideoElement | null>;
  screenShareAudioRef: React.RefObject<HTMLAudioElement | null>;
  externalAudioRef: React.RefObject<HTMLAudioElement | null>;
  externalVideoRef: React.RefObject<HTMLVideoElement | null>;
};

export type { AudioVideoRefs };

enum ConnectionStatus {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  FAILED = 'failed'
}

export type TVoiceProvider = {
  loading: boolean;
  connectionStatus: ConnectionStatus;
  transportStats: TransportStatsData;
  sharingSystemAudio: boolean;
  realOutputSinkId: string | undefined;
  audioVideoRefsMap: Map<number, AudioVideoRefs>;
  getOrCreateRefs: (remoteId: number) => AudioVideoRefs;
  init: (
    routerRtpCapabilities: RtpCapabilities,
    channelId: number
  ) => Promise<void>;
} & Pick<
  ReturnType<typeof useLocalStreams>,
  'localAudioStream' | 'localVideoStream' | 'localScreenShareStream'
> &
  Pick<
    ReturnType<typeof useRemoteStreams>,
    'remoteUserStreams' | 'externalStreams'
  > &
  ReturnType<typeof useVoiceControls>;

const VoiceProviderContext = createContext<TVoiceProvider>({
  loading: false,
  connectionStatus: ConnectionStatus.DISCONNECTED,
  transportStats: {
    producer: null,
    consumer: null,
    totalBytesReceived: 0,
    totalBytesSent: 0,
    isMonitoring: false,
    currentBitrateReceived: 0,
    currentBitrateSent: 0,
    averageBitrateReceived: 0,
    averageBitrateSent: 0
  },
  audioVideoRefsMap: new Map(),
  getOrCreateRefs: () => ({
    videoRef: { current: null },
    audioRef: { current: null },
    screenShareRef: { current: null },
    screenShareAudioRef: { current: null },
    externalAudioRef: { current: null },
    externalVideoRef: { current: null }
  }),
  init: () => Promise.resolve(),
  toggleMic: () => Promise.resolve(),
  toggleSound: () => Promise.resolve(),
  toggleWebcam: () => Promise.resolve(),
  toggleScreenShare: () => Promise.resolve(),
  ownVoiceState: {
    micMuted: false,
    soundMuted: false,
    webcamEnabled: false,
    sharingScreen: false,
    serverMuted: false,
    serverDeafened: false
  },
  sharingSystemAudio: false,
  realOutputSinkId: undefined,
  localAudioStream: undefined,
  localVideoStream: undefined,
  localScreenShareStream: undefined,

  remoteUserStreams: {},
  externalStreams: {}
});

type TVoiceProviderProps = {
  children: React.ReactNode;
};

const VoiceProvider = memo(({ children }: TVoiceProviderProps) => {
  const [loading, setLoading] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>(
    ConnectionStatus.DISCONNECTED
  );
  const [sharingSystemAudio, setSharingSystemAudio] = useState(false);
  const [realOutputSinkId, setRealOutputSinkId] = useState<string | undefined>(undefined);
  // Ref mirrors for values read inside callbacks that are defined before
  // their state producers exist (attachMicStream is called from both the
  // control hooks and the screen-share paths).
  const sharingSystemAudioRef = useRef(false);
  const micMutedRef = useRef(false);

  const setSystemAudioActive = useCallback((active: boolean) => {
    sharingSystemAudioRef.current = active;
    setSharingSystemAudio(active);
  }, []);
  const routerRtpCapabilities = useRef<RtpCapabilities | null>(null);
  // Hold a ref to the loaded Device so screen-share produce can pull
  // the H264 codec entry off it (see screenShare codec selection
  // below). Without H264 we end up on VP8/VP9 which is software-only
  // on Apple Silicon — the laptop-heat issue users reported.
  const deviceRef = useRef<Device | null>(null);
  const audioVideoRefsMap = useRef<Map<number, AudioVideoRefs>>(new Map());
  const { devices } = useDevices();

  const getOrCreateRefs = useCallback((remoteId: number): AudioVideoRefs => {
    if (!audioVideoRefsMap.current.has(remoteId)) {
      audioVideoRefsMap.current.set(remoteId, {
        videoRef: { current: null },
        audioRef: { current: null },
        screenShareRef: { current: null },
        screenShareAudioRef: { current: null },
        externalAudioRef: { current: null },
        externalVideoRef: { current: null }
      });
    }

    return audioVideoRefsMap.current.get(remoteId)!;
  }, []);

  const {
    addExternalStreamTrack,
    removeExternalStreamTrack,
    removeExternalStream,
    clearExternalStreams,
    addRemoteUserStream,
    removeRemoteUserStream,
    clearRemoteUserStreamsForUser,
    clearRemoteUserStreams,
    externalStreams,
    remoteUserStreams
  } = useRemoteStreams();

  const {
    localAudioProducer,
    localVideoProducer,
    localAudioStream,
    localVideoStream,
    localScreenShareStream,
    localScreenShareProducer,
    localScreenShareAudioProducer,
    setLocalAudioStream,
    setLocalVideoStream,
    setLocalScreenShare,
    clearLocalStreams
  } = useLocalStreams();

  const {
    producerTransport,
    consumerTransport,
    createProducerTransport,
    createConsumerTransport,
    consume,
    consumeExistingProducers,
    cleanupTransports
  } = useTransports({
    addExternalStreamTrack,
    removeExternalStreamTrack,
    addRemoteUserStream,
    removeRemoteUserStream
  });

  const {
    stats: transportStats,
    startMonitoring,
    stopMonitoring,
    resetStats
  } = useTransportStats();

  const micPipelineRef = useRef<MicPipeline | null>(null);

  /**
   * Acquire the microphone through the pipeline and attach its output to
   * the audio producer (creating the producer on first use). The single
   * entry point for every mic transition: initial join, unmute,
   * device/setting hot-swap, and both system-audio screen-share handoffs.
   *
   * While system audio capture is live, browser EC/NS/AGC are forced ON and
   * the Pulse Audio virtual device is never selected as the mic — otherwise
   * the aggregate device's speaker output bleeds acoustically back into the
   * call. The configured mic is preferred, but a stale id NEVER skips the
   * forced-EC profile: any real mic beats an EC-less track feeding the
   * speakers back into the call.
   */
  const attachMicStream = useCallback(async () => {
    try {
      logVoice('Attaching microphone stream');

      if (!micPipelineRef.current) {
        micPipelineRef.current = new MicPipeline(
          devices.noiseSuppressionMode,
          devices.noiseGateThreshold
        );
      }
      const pipeline = micPipelineRef.current;
      pipeline.setMode(devices.noiseSuppressionMode);
      pipeline.setThreshold(devices.noiseGateThreshold);

      let deviceId = devices.microphoneId;
      let forceEcProfile = false;

      if (sharingSystemAudioRef.current) {
        const mediaDevices = await navigator.mediaDevices.enumerateDevices();
        const nonVirtualInputs = mediaDevices.filter(
          (d) => d.kind === 'audioinput' && !d.label.includes('Pulse Audio')
        );
        const realMic =
          nonVirtualInputs.find((d) => d.deviceId === deviceId) ??
          nonVirtualInputs[0];
        if (realMic) deviceId = realMic.deviceId;
        forceEcProfile = true;
      }

      const stream = await pipeline.acquire({
        deviceId,
        echoCancellation: forceEcProfile ? true : devices.echoCancellation,
        autoGainControl: forceEcProfile ? true : devices.autoGainControl,
        noiseSuppression: forceEcProfile
          ? true
          : devices.noiseSuppressionMode === 'automatic'
      });

      logVoice('Microphone stream obtained', { stream });

      pipeline.onRawTrackEnded = () => {
        // Device unplugged / capture revoked — drop the producer so the
        // next unmute re-acquires and re-produces.
        logVoice('Audio track ended, cleaning up microphone');
        pipeline.release();
        localAudioProducer.current?.close();
        localAudioProducer.current = undefined;
        setLocalAudioStream(undefined);
      };

      setLocalAudioStream(stream);

      const outputTrack = pipeline.getOutputTrack();
      if (!outputTrack) {
        throw new Error('Failed to obtain audio track from microphone');
      }

      const producer = localAudioProducer.current;
      if (producer && !producer.closed) {
        await producer.replaceTrack({ track: outputTrack });
        logVoice('Microphone track replaced on existing producer');
      } else {
        localAudioProducer.current = await producerTransport.current?.produce({
          track: outputTrack,
          // The pipeline owns track lifecycle; mediasoup must not stop
          // tracks on replaceTrack/close (it would kill the shared noise
          // gate output node).
          stopTracks: false,
          appData: { kind: StreamKind.AUDIO }
        });

        logVoice('Microphone audio producer created', {
          producer: localAudioProducer.current
        });

        localAudioProducer.current?.on('@close', async () => {
          logVoice('Audio producer closed');

          const trpc = getTRPCClient();
          if (!trpc) return;

          try {
            await trpc.voice.closeProducer.mutate({
              kind: StreamKind.AUDIO
            });
          } catch (error) {
            logVoice('Error closing audio producer', { error });
          }
        });
      }
    } catch (error) {
      logVoice('Error attaching microphone stream', { error });
    }
  }, [
    producerTransport,
    setLocalAudioStream,
    localAudioProducer,
    devices.microphoneId,
    devices.autoGainControl,
    devices.echoCancellation,
    devices.noiseSuppressionMode,
    devices.noiseGateThreshold
  ]);

  /**
   * Detach the producer track and release the mic (mute). replaceTrack(null)
   * instead of track.enabled: on macOS, disabling one getUserMedia audio
   * track can interfere with other concurrent captures (e.g. the Pulse
   * Audio virtual device during system-audio screen share).
   */
  const detachMicStream = useCallback(async () => {
    const producer = localAudioProducer.current;
    if (producer && !producer.closed) {
      try {
        await producer.replaceTrack({ track: null });
      } catch (error) {
        logVoice('Error detaching producer track', { error });
      }
    }
    micPipelineRef.current?.release();
    setLocalAudioStream(undefined);
  }, [localAudioProducer, setLocalAudioStream]);

  const startWebcamStream = useCallback(async () => {
    try {
      logVoice('Starting webcam stream');

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          deviceId: { ideal: devices?.webcamId },
          frameRate: devices.webcamFramerate,
          ...getResWidthHeight(devices?.webcamResolution)
        }
      });

      logVoice('Webcam stream obtained', { stream });

      setLocalVideoStream(stream);

      const videoTrack = stream.getVideoTracks()[0];

      if (videoTrack) {
        logVoice('Obtained video track', { videoTrack });

        localVideoProducer.current = await producerTransport.current?.produce({
          track: videoTrack,
          appData: { kind: StreamKind.VIDEO }
        });

        logVoice('Webcam video producer created', {
          producer: localVideoProducer.current
        });

        localVideoProducer.current?.on('@close', async () => {
          logVoice('Video producer closed');

          const trpc = getTRPCClient();
          if (!trpc) return;

          try {
            await trpc.voice.closeProducer.mutate({
              kind: StreamKind.VIDEO
            });
          } catch (error) {
            logVoice('Error closing video producer', { error });
          }
        });

        videoTrack.onended = () => {
          logVoice('Video track ended, cleaning up webcam');

          localVideoStream?.getVideoTracks().forEach((track) => {
            track.stop();
          });
          localVideoProducer.current?.close();

          setLocalVideoStream(undefined);
        };
      } else {
        throw new Error('Failed to obtain video track from webcam');
      }
    } catch (error) {
      logVoice('Error starting webcam stream', { error });
      throw error;
    }
  }, [
    setLocalVideoStream,
    localVideoProducer,
    producerTransport,
    localVideoStream,
    devices.webcamId,
    devices.webcamFramerate,
    devices.webcamResolution
  ]);

  const stopWebcamStream = useCallback(() => {
    logVoice('Stopping webcam stream');

    localVideoStream?.getVideoTracks().forEach((track) => {
      logVoice('Stopping video track', { track });

      track.stop();
      localVideoStream.removeTrack(track);
    });

    localVideoProducer.current?.close();
    localVideoProducer.current = undefined;

    setLocalVideoStream(undefined);
  }, [localVideoStream, setLocalVideoStream, localVideoProducer]);

  const stopScreenShareStream = useCallback(async () => {
    logVoice('Stopping screen share stream');

    localScreenShareStream?.getTracks().forEach((track) => {
      logVoice('Stopping screen share track', { track });

      track.stop();
      localScreenShareStream.removeTrack(track);
    });

    localScreenShareProducer.current?.close();
    localScreenShareProducer.current = undefined;

    localScreenShareAudioProducer.current?.close();
    localScreenShareAudioProducer.current = undefined;

    // Stop macOS system audio capture if active
    window.pulseDesktop?.audioCapture?.stop();

    // Restore the microphone to original settings (echo cancellation was
    // forced ON during system audio capture to prevent acoustic bleed).
    // Skipped while muted: the mic is released, and re-attaching would
    // silently unmute the producer.
    const restoreMic =
      sharingSystemAudio &&
      localAudioProducer.current &&
      !localAudioProducer.current.closed &&
      !micMutedRef.current;

    // Clear BEFORE re-attaching so the forced-EC profile is off.
    setSystemAudioActive(false);
    setLocalScreenShare(undefined);
    setRealOutputSinkId(undefined);

    if (restoreMic) {
      logVoice('Restoring mic to original settings after system-audio share');
      await attachMicStream();
    }
  }, [localScreenShareStream, setLocalScreenShare, localScreenShareProducer, localScreenShareAudioProducer, sharingSystemAudio, localAudioProducer, attachMicStream, setSystemAudioActive]);

  const startScreenShareStream = useCallback(async () => {
    try {
      logVoice('Starting screen share stream');

      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          ...getResWidthHeight(devices?.screenResolution),
          frameRate: devices?.screenFramerate
        },
        audio: {
          autoGainControl: false,
          echoCancellation: false,
          noiseSuppression: true,
          channelCount: 2,
          sampleRate: 48000
        },
        // Prevent sharing the app's own tab (major source of audio echo)
        selfBrowserSurface: 'exclude',
        preferCurrentTab: false
      } as DisplayMediaStreamOptions);

      logVoice('Screen share stream obtained', { stream });
      setLocalScreenShare(stream);

      const videoTrack = stream.getVideoTracks()[0];

      if (videoTrack) {
        // Detect if sharing screen/window (system audio) vs tab (isolated audio)
        const displaySurface = videoTrack.getSettings().displaySurface;
        const hasAudio = stream.getAudioTracks().length > 0;
        const isSystemAudio = hasAudio && displaySurface !== 'browser';

        logVoice('Screen share surface type', { displaySurface, hasAudio, isSystemAudio });
        setSystemAudioActive(isSystemAudio);

        // Prefer H264 for screen share. On Apple Silicon (and most
        // recent x86 chips) H264 has dedicated hardware encoding;
        // VP8/VP9 fall back to software, which pegs the CPU and
        // turns the fan into a leaf-blower during a screen share.
        // The router lists H264 first in its mediaCodecs, but
        // mediasoup-client + browser negotiation can still land on
        // VP8 — passing `codec` explicitly forces it.
        const h264Codec = deviceRef.current?.rtpCapabilities.codecs?.find(
          (c) => c.mimeType.toLowerCase() === 'video/h264'
        );

        localScreenShareProducer.current =
          await producerTransport.current?.produce({
            track: videoTrack,
            codec: h264Codec,
            appData: { kind: StreamKind.SCREEN }
          });

        localScreenShareProducer.current?.on('@close', async () => {
          logVoice('Screen share producer closed');

          const trpc = getTRPCClient();
          if (!trpc) return;

          try {
            await trpc.voice.closeProducer.mutate({
              kind: StreamKind.SCREEN
            });
          } catch (error) {
            logVoice('Error closing screen share producer', { error });
          }
        });

        let audioTrack = stream.getAudioTracks()[0];

        // macOS Electron: use the virtual audio device for system audio capture.
        // Always prefer our HAL plugin over whatever getDisplayMedia returned,
        // because the system picker's audio track (from ScreenCaptureKit) may be
        // silent without the "Screen & System Audio Recording" permission, while
        // our virtual device only needs microphone permission.
        if (window.pulseDesktop?.audioCapture) {
          try {
            const available = await window.pulseDesktop.audioCapture.isAvailable();
            if (available) {
              logVoice('macOS: Starting system audio capture via virtual device');

              // Remove any audio track from getDisplayMedia — we'll replace it
              // with our virtual device capture which is more reliable
              if (audioTrack) {
                logVoice('macOS: Removing system picker audio track in favor of virtual device');
                audioTrack.stop();
                stream.removeTrack(audioTrack);
                audioTrack = undefined as unknown as MediaStreamTrack;
              }

              const captureResult = await window.pulseDesktop.audioCapture.start();

              if (captureResult) {
                // Find the Pulse Audio virtual input device
                const mediaDevices = await navigator.mediaDevices.enumerateDevices();

                logVoice('macOS: Available audio input devices', {
                  devices: mediaDevices
                    .filter((d) => d.kind === 'audioinput')
                    .map((d) => ({ id: d.deviceId, label: d.label }))
                });

                const pulseInput = mediaDevices.find(
                  (d) => d.kind === 'audioinput' && d.label.includes('Pulse Audio')
                );

                if (pulseInput) {
                  logVoice('macOS: Capturing from Pulse Audio device', { deviceId: pulseInput.deviceId });
                  const audioStream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                      deviceId: { exact: pulseInput.deviceId },
                      autoGainControl: false,
                      echoCancellation: false,
                      noiseSuppression: false,
                      channelCount: 2,
                      sampleRate: 48000
                    }
                  });

                  audioTrack = audioStream.getAudioTracks()[0];
                  if (audioTrack) {
                    stream.addTrack(audioTrack);
                    setSystemAudioActive(true);

                    // Find the real output device by name so we can route voice
                    // chat audio directly to it (bypassing the aggregate device).
                    // This prevents remote users' voices from being re-captured.
                    const realOutput = mediaDevices.find(
                      (d) => d.kind === 'audiooutput' && d.label.includes(captureResult.realOutputDeviceName)
                    );
                    if (realOutput) {
                      logVoice('macOS: Routing voice to real output', { deviceId: realOutput.deviceId, label: realOutput.label });
                      setRealOutputSinkId(realOutput.deviceId);
                    }

                    // Re-acquire the microphone with echo cancellation
                    // forced ON — attachMicStream applies the forced-EC
                    // profile and real-mic selection while system audio is
                    // active. Skipped while muted: the mic is released, so
                    // there is nothing to bleed (unmute re-attaches with
                    // the forced profile).
                    if (
                      localAudioProducer.current &&
                      !localAudioProducer.current.closed &&
                      !micMutedRef.current
                    ) {
                      logVoice('macOS: Re-acquiring mic with echo cancellation');
                      await attachMicStream();
                    }
                  }
                } else {
                  logVoice('macOS: Pulse Audio input device not found, available inputs listed above');
                  window.pulseDesktop.audioCapture.stop();
                }
              }
            } else {
              logVoice('macOS: Audio driver not available, using system audio track if present');
            }
          } catch (err) {
            logVoice('macOS: System audio capture failed', { error: err });
            window.pulseDesktop?.audioCapture?.stop();
          }
        }

        if (audioTrack) {
          logVoice('Obtained screen share audio track', { audioTrack });

          const audioBitrate = (devices.screenAudioBitrate ?? 128) * 1000;

          localScreenShareAudioProducer.current =
            await producerTransport.current?.produce({
              track: audioTrack,
              appData: { kind: StreamKind.SCREEN_AUDIO },
              encodings: [{ maxBitrate: audioBitrate, dtx: false }],
              codecOptions: {
                opusStereo: true,
                opusDtx: false,
                opusFec: true,
                opusMaxPlaybackRate: 48000
              }
            });

          localScreenShareAudioProducer.current?.on('@close', async () => {
            logVoice('Screen share audio producer closed');

            const trpc = getTRPCClient();
            if (!trpc) return;

            try {
              await trpc.voice.closeProducer.mutate({
                kind: StreamKind.SCREEN_AUDIO
              });
            } catch (error) {
              logVoice('Error closing screen share audio producer', { error });
            }
          });
        }

        videoTrack.onended = () => {
          logVoice('Screen share track ended, cleaning up screen share');

          localScreenShareStream?.getTracks().forEach((track) => {
            track.stop();
          });
          localScreenShareProducer.current?.close();
          localScreenShareAudioProducer.current?.close();

          // Stop macOS system audio capture if active
          window.pulseDesktop?.audioCapture?.stop();

          setLocalScreenShare(undefined);
          setRealOutputSinkId(undefined);
        };

        return videoTrack;
      } else {
        throw new Error('No video track obtained for screen share');
      }
    } catch (error) {
      logVoice('Error starting screen share stream', { error });
      throw error;
    }
  }, [
    setLocalScreenShare,
    localScreenShareProducer,
    localScreenShareAudioProducer,
    producerTransport,
    localScreenShareStream,
    localAudioProducer,
    attachMicStream,
    setSystemAudioActive,
    devices.screenResolution,
    devices.screenFramerate,
    devices.screenAudioBitrate
  ]);

  // Hot-swap webcam track on the existing producer when device settings change
  const reapplyWebcamSettings = useCallback(async (webcamEnabled: boolean) => {
    if (!webcamEnabled) return;
    if (!localVideoProducer.current || localVideoProducer.current.closed) return;

    try {
      logVoice('Reapplying webcam settings mid-call');

      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          deviceId: { ideal: devices.webcamId },
          frameRate: devices.webcamFramerate,
          ...getResWidthHeight(devices.webcamResolution)
        }
      });

      const newTrack = newStream.getVideoTracks()[0];
      if (!newTrack) return;

      // Stop old tracks
      localVideoStream?.getVideoTracks().forEach((t) => t.stop());

      await localVideoProducer.current!.replaceTrack({ track: newTrack });
      setLocalVideoStream(newStream);
      logVoice('Webcam settings reapplied successfully');
    } catch (error) {
      logVoice('Error reapplying webcam settings', { error });
    }
  }, [
    localVideoProducer,
    localVideoStream,
    setLocalVideoStream,
    devices.webcamId,
    devices.webcamFramerate,
    devices.webcamResolution
  ]);

  // Live re-apply screen-share quality on an ACTIVE share. Resolution and
  // framerate go through applyConstraints on the captured track (downscales
  // in the browser, no re-pick); audio bitrate through the sender's
  // encoding parameters.
  const reapplyScreenShareSettings = useCallback(async () => {
    const videoTrack = localScreenShareStream?.getVideoTracks()[0];
    if (videoTrack && videoTrack.readyState === 'live') {
      try {
        await videoTrack.applyConstraints({
          ...getResWidthHeight(devices.screenResolution),
          frameRate: devices.screenFramerate
        });
        logVoice('Screen share constraints re-applied live');
      } catch (error) {
        logVoice('Error re-applying screen share constraints', { error });
      }
    }

    const audioSender = localScreenShareAudioProducer.current?.closed
      ? undefined
      : localScreenShareAudioProducer.current?.rtpSender;
    if (audioSender) {
      try {
        const params = audioSender.getParameters();
        if (params.encodings?.length) {
          params.encodings[0].maxBitrate =
            (devices.screenAudioBitrate ?? 128) * 1000;
          await audioSender.setParameters(params);
          logVoice('Screen share audio bitrate re-applied live');
        }
      } catch (error) {
        logVoice('Error re-applying screen share audio bitrate', { error });
      }
    }
  }, [
    localScreenShareStream,
    localScreenShareAudioProducer,
    devices.screenResolution,
    devices.screenFramerate,
    devices.screenAudioBitrate
  ]);

  const cleanup = useCallback(() => {
    logVoice('Running voice provider cleanup');

    stopMonitoring();
    resetStats();
    clearLocalStreams();
    clearRemoteUserStreams();
    clearExternalStreams();
    cleanupTransports();
    micPipelineRef.current?.destroy();
    micPipelineRef.current = null;
    setSystemAudioActive(false);
    deviceRef.current = null;

    setConnectionStatus(ConnectionStatus.DISCONNECTED);
  }, [
    stopMonitoring,
    resetStats,
    clearLocalStreams,
    clearRemoteUserStreams,
    clearExternalStreams,
    cleanupTransports,
    setSystemAudioActive
  ]);

  const init = useCallback(
    async (
      incomingRouterRtpCapabilities: RtpCapabilities,
      channelId: number
    ) => {
      logVoice('Initializing voice provider', {
        incomingRouterRtpCapabilities,
        channelId
      });

      cleanup();

      try {
        setLoading(true);
        setConnectionStatus(ConnectionStatus.CONNECTING);

        routerRtpCapabilities.current = incomingRouterRtpCapabilities;

        const device = new Device();

        await device.load({
          routerRtpCapabilities: incomingRouterRtpCapabilities
        });

        deviceRef.current = device;

        await createProducerTransport(device);
        await createConsumerTransport(device);
        await consumeExistingProducers(incomingRouterRtpCapabilities);
        await attachMicStream();

        startMonitoring(producerTransport.current, consumerTransport.current);
        setConnectionStatus(ConnectionStatus.CONNECTED);
        setLoading(false);
        playSound(SoundType.OWN_USER_JOINED_VOICE_CHANNEL);
      } catch (error) {
        logVoice('Error initializing voice provider', { error });

        setConnectionStatus(ConnectionStatus.FAILED);
        setLoading(false);

        throw error;
      }
    },
    [
      cleanup,
      createProducerTransport,
      createConsumerTransport,
      consumeExistingProducers,
      attachMicStream,
      startMonitoring,
      producerTransport,
      consumerTransport
    ]
  );

  const {
    toggleMic,
    toggleSound,
    toggleWebcam,
    toggleScreenShare,
    ownVoiceState
  } = useVoiceControls({
    attachMicStream,
    detachMicStream,
    startWebcamStream,
    stopWebcamStream,
    startScreenShareStream,
    stopScreenShareStream
  });

  // Mirror mute state for callbacks defined above useVoiceControls
  // (screen-share restore / forced-EC skip-when-muted).
  useEffect(() => {
    micMutedRef.current = ownVoiceState.micMuted;
  }, [ownVoiceState.micMuted]);

  useVoiceEvents({
    consume,
    removeRemoteUserStream,
    removeExternalStreamTrack,
    removeExternalStream,
    clearRemoteUserStreamsForUser,
    rtpCapabilities: routerRtpCapabilities.current!
  });

  useEffect(() => {
    return () => {
      logVoice('Voice provider unmounting, cleaning up resources');
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Clean up streams when leaving voice (channelId -> undefined)
  const currentVoiceChannelId = useCurrentVoiceChannelId();
  const prevChannelIdRef = useRef(currentVoiceChannelId);

  useEffect(() => {
    if (prevChannelIdRef.current && !currentVoiceChannelId) {
      logVoice('Voice channel left, cleaning up streams');
      cleanup();
    }
    prevChannelIdRef.current = currentVoiceChannelId;
  }, [currentVoiceChannelId, cleanup]);

  // Live-apply device setting changes while in a call
  const prevDevicesRef = useRef<TDeviceSettings | null>(null);

  useEffect(() => {
    if (connectionStatus !== ConnectionStatus.CONNECTED) {
      prevDevicesRef.current = null;
      return;
    }

    // Skip first run after connecting — devices were already used during init
    if (!prevDevicesRef.current) {
      prevDevicesRef.current = devices;
      return;
    }

    const prev = prevDevicesRef.current;
    prevDevicesRef.current = devices;

    const micChanged =
      prev.microphoneId !== devices.microphoneId ||
      prev.echoCancellation !== devices.echoCancellation ||
      prev.noiseSuppressionMode !== devices.noiseSuppressionMode ||
      prev.autoGainControl !== devices.autoGainControl;

    const gateThresholdChanged =
      prev.noiseGateThreshold !== devices.noiseGateThreshold;

    const webcamChanged =
      prev.webcamId !== devices.webcamId ||
      prev.webcamFramerate !== devices.webcamFramerate ||
      prev.webcamResolution !== devices.webcamResolution;

    const screenChanged =
      prev.screenResolution !== devices.screenResolution ||
      prev.screenFramerate !== devices.screenFramerate ||
      prev.screenAudioBitrate !== devices.screenAudioBitrate;

    if (micChanged) {
      // While muted the mic is released; the next unmute acquires with the
      // new settings on its own.
      if (!ownVoiceState.micMuted) {
        attachMicStream();
      }
    } else if (gateThresholdChanged) {
      // Threshold-only change: adjust the live gate, no re-acquire needed.
      micPipelineRef.current?.setThreshold(devices.noiseGateThreshold);
    }
    if (webcamChanged) {
      reapplyWebcamSettings(ownVoiceState.webcamEnabled);
    }
    if (screenChanged && ownVoiceState.sharingScreen) {
      reapplyScreenShareSettings();
    }
  }, [devices, connectionStatus, attachMicStream, reapplyWebcamSettings, reapplyScreenShareSettings, ownVoiceState.micMuted, ownVoiceState.webcamEnabled, ownVoiceState.sharingScreen]);

  const contextValue = useMemo<TVoiceProvider>(
    () => ({
      loading,
      connectionStatus,
      transportStats,
      sharingSystemAudio,
      realOutputSinkId,
      audioVideoRefsMap: audioVideoRefsMap.current,
      getOrCreateRefs,
      init,

      toggleMic,
      toggleSound,
      toggleWebcam,
      toggleScreenShare,
      ownVoiceState,

      localAudioStream,
      localVideoStream,
      localScreenShareStream,

      remoteUserStreams,
      externalStreams
    }),
    [
      loading,
      connectionStatus,
      transportStats,
      sharingSystemAudio,
      realOutputSinkId,
      getOrCreateRefs,
      init,

      toggleMic,
      toggleSound,
      toggleWebcam,
      toggleScreenShare,
      ownVoiceState,

      localAudioStream,
      localVideoStream,
      localScreenShareStream,
      remoteUserStreams,
      externalStreams
    ]
  );

  return (
    <VoiceProviderContext.Provider value={contextValue}>
      <VolumeControlProvider>
        <div className="relative">
          <FloatingPinnedCard
            remoteUserStreams={remoteUserStreams}
            externalStreams={externalStreams}
            localScreenShareStream={localScreenShareStream}
            localVideoStream={localVideoStream}
          />
          {children}
        </div>
      </VolumeControlProvider>
    </VoiceProviderContext.Provider>
  );
});

export { VoiceProvider, VoiceProviderContext };
