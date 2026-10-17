import { useCurrentVoiceChannelId } from '@/features/server/channels/hooks';
import { useInfo } from '@/features/server/hooks';
import { playSound } from '@/features/server/sounds/actions';
import { SoundType } from '@/features/server/types';
import {
  leaveCurrentVoice,
  updateOwnVoiceState
} from '@/features/server/voice/actions';
import { logVoice } from '@/helpers/browser-logger';
import { getResWidthHeight } from '@/helpers/get-res-with-height';
import { onAppEvent } from '@/lib/events';
import { getVoiceTRPCClient } from '@/lib/trpc';
import { Resolution, type TDeviceSettings } from '@/types';
import {
  clampScreenFramerate,
  clampScreenResolution,
  StreamKind
} from '@pulse/shared';
import type { Device, RtpCapabilities } from 'mediasoup-client/types';
import {
  createContext,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import { toast } from 'sonner';
import { useDevices } from '../devices-provider/hooks/use-devices';
import { FloatingPinnedCard } from './floating-pinned-card';
import { useLocalStreams } from './hooks/use-local-streams';
import { useRemoteStreams } from './hooks/use-remote-streams';
import {
  useTransportStats,
  type TransportStatsData
} from './hooks/use-transport-stats';
import { useTransports, type TTransportType } from './hooks/use-transports';
import { useVoiceControls } from './hooks/use-voice-controls';
import { useVoiceEvents } from './hooks/use-voice-events';
import {
  describeMicError,
  screenShareAudioConstraints,
  screenShareContentHint,
  screenShareDegradationPreference,
  screenShareEncodings,
  screenShareMaxBitrate,
  transportIceOptions
} from './media-policy';
import { MicPipeline } from './mic-pipeline';
import { VolumeControlProvider } from './volume-control-context';
import { SoundboardProvider } from './soundboard-context';

type AudioVideoRefs = {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  audioRef: React.RefObject<HTMLAudioElement | null>;
  screenShareRef: React.RefObject<HTMLVideoElement | null>;
  screenShareAudioRef: React.RefObject<HTMLAudioElement | null>;
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
  changeScreenShareSource: () => Promise<MediaStreamTrack>;
  screenAudioMuted: boolean;
  toggleScreenShareAudio: () => void;
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
    externalVideoRef: { current: null }
  }),
  init: () => Promise.resolve(),
  changeScreenShareSource: () =>
    Promise.reject(new Error('Not in a voice call')),
  screenAudioMuted: false,
  toggleScreenShareAudio: () => {},
  toggleMic: () => Promise.resolve(),
  toggleSound: () => Promise.resolve(),
  toggleWebcam: () => Promise.resolve(),
  toggleScreenShare: () => Promise.resolve(),
  changeScreenShare: () => Promise.resolve(),
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
  const [realOutputSinkId, setRealOutputSinkId] = useState<string | undefined>(
    undefined
  );
  // Outgoing screen-share audio mute — pauses the SCREEN_AUDIO producer
  // (listeners get silence) without touching the mic or the capture.
  const [screenAudioMuted, setScreenAudioMuted] = useState(false);
  const screenAudioMutedRef = useRef(false);
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
  // What this browser can decode — handed to every consume so the server
  // picks a codec we actually have (see use-transports). Read lazily:
  // the Device exists only after init.
  const getDeviceRtpCapabilities = useCallback(
    () => deviceRef.current?.rtpCapabilities ?? null,
    []
  );
  // The live session's join parameters, kept for the one automatic
  // rebuild after an ICE failure. Cleared by cleanup (a leave), so a
  // late failure event from a closing transport rebuilds nothing.
  const sessionRef = useRef<{
    routerRtpCapabilities: RtpCapabilities;
    channelId: number;
  } | null>(null);
  const transportRetryUsedRef = useRef(false);
  const audioVideoRefsMap = useRef<Map<number, AudioVideoRefs>>(new Map());
  const { devices } = useDevices();
  const info = useInfo();

  // TURN relay (if the operator configured one) for both transports.
  const iceOptions = useMemo(() => transportIceOptions(info), [info]);

  // Screen-capture video constraints, clamped to the instance operator's
  // ceiling. A device pref left above a since-lowered cap is pulled back
  // down here, before capture — the client-side half of the policy (the
  // Stream Quality menu already hides above-cap options).
  const screenQuality = useMemo(
    () => ({
      resolution: clampScreenResolution(
        devices?.screenResolution,
        info?.maxScreenResolution
      ) as Resolution | undefined,
      framerate: clampScreenFramerate(
        devices?.screenFramerate,
        info?.maxScreenFramerate
      )
    }),
    [
      devices?.screenResolution,
      devices?.screenFramerate,
      info?.maxScreenResolution,
      info?.maxScreenFramerate
    ]
  );
  const screenVideoConstraints = useMemo(
    () => ({
      ...getResWidthHeight(screenQuality.resolution),
      frameRate: screenQuality.framerate
    }),
    [screenQuality]
  );

  const getOrCreateRefs = useCallback((remoteId: number): AudioVideoRefs => {
    if (!audioVideoRefsMap.current.has(remoteId)) {
      audioVideoRefsMap.current.set(remoteId, {
        videoRef: { current: null },
        audioRef: { current: null },
        screenShareRef: { current: null },
        screenShareAudioRef: { current: null },
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

  // The session rebuild is defined after the transports (it needs them);
  // the transports' failure handler reaches it through this ref.
  const rebuildSessionRef = useRef<
    | ((
        routerRtpCapabilities: RtpCapabilities,
        channelId: number
      ) => Promise<void>)
    | null
  >(null);

  /**
   * ICE reached `failed` on a transport (its restart did not recover
   * it). Status goes to FAILED so the sidebar says so; one rebuild of
   * the whole session is attempted per join — a second failure is a
   * network that will not carry media, and the user is told.
   */
  const onTransportFailed = useCallback((type: TTransportType) => {
    logVoice('Transport failed', { type });
    setConnectionStatus(ConnectionStatus.FAILED);

    const session = sessionRef.current;
    const rebuild = rebuildSessionRef.current;
    if (!session || !rebuild || transportRetryUsedRef.current) return;

    transportRetryUsedRef.current = true;
    toast.info('Voice connection lost — reconnecting…');
    rebuild(session.routerRtpCapabilities, session.channelId).catch(() => {
      toast.error('Voice connection failed');
    });
  }, []);

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
    removeRemoteUserStream,
    onTransportFailed
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
   *
   * Resolves false when no microphone could be sent. The user is then
   * MUTED — locally and on the server — and told why: a failed acquisition
   * used to be logged and swallowed, which left the user unmuted in every
   * roster while nothing was being sent.
   */
  const attachMicStream = useCallback(async (): Promise<boolean> => {
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

          const trpc = getVoiceTRPCClient();
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

      return true;
    } catch (error) {
      logVoice('Error attaching microphone stream', { error });

      micMutedRef.current = true;
      updateOwnVoiceState({ micMuted: true });
      getVoiceTRPCClient()
        ?.voice.updateState.mutate({ micMuted: true })
        .catch((reportError) => {
          logVoice('Error reporting the muted microphone', { reportError });
        });
      toast.error(describeMicError(error) ?? 'Microphone could not be started');

      return false;
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

          const trpc = getVoiceTRPCClient();
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

          // `stream` is the capture this track belongs to. The state value
          // would be whatever render created this callback — always the
          // previous stream, never this one.
          stream.getVideoTracks().forEach((track) => {
            track.stop();
          });
          localVideoProducer.current?.close();
          localVideoProducer.current = undefined;

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

    screenAudioMutedRef.current = false;
    setScreenAudioMuted(false);

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
  }, [
    localScreenShareStream,
    setLocalScreenShare,
    localScreenShareProducer,
    localScreenShareAudioProducer,
    sharingSystemAudio,
    localAudioProducer,
    attachMicStream,
    setSystemAudioActive
  ]);

  const startScreenShareStream = useCallback(async () => {
    try {
      logVoice('Starting screen share stream');

      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: screenVideoConstraints,
        // Picture only when the user turned system audio off (Voice &
        // Video settings) — no audio track is requested, none is produced.
        audio: screenShareAudioConstraints(devices.shareSystemAudio),
        // Prevent sharing the app's own tab (major source of audio echo)
        selfBrowserSurface: 'exclude',
        preferCurrentTab: false
      } as DisplayMediaStreamOptions);

      logVoice('Screen share stream obtained', { stream });
      setLocalScreenShare(stream);

      const videoTrack = stream.getVideoTracks()[0];

      if (videoTrack) {
        // What to protect under pressure follows the chosen frame rate:
        // a 15 fps desktop keeps its text crisp, a 30/60 fps game keeps
        // its motion (see media-policy).
        videoTrack.contentHint = screenShareContentHint(
          screenQuality.framerate
        );

        // Detect if sharing screen/window (system audio) vs tab (isolated audio)
        const displaySurface = videoTrack.getSettings().displaySurface;
        const hasAudio = stream.getAudioTracks().length > 0;
        const isSystemAudio = hasAudio && displaySurface !== 'browser';

        logVoice('Screen share surface type', {
          displaySurface,
          hasAudio,
          isSystemAudio
        });
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
            // Bitrate budget for the chosen resolution and frame rate (see
            // media-policy): without a ceiling the encoder burns CPU
            // pushing every bit the estimator allows.
            encodings: screenShareEncodings(
              screenQuality.resolution,
              screenQuality.framerate
            ),
            appData: { kind: StreamKind.SCREEN }
          });

        // Tell the encoder which axis to hold when bandwidth or CPU runs
        // short; the default ("balanced") halves the frame rate first,
        // which is exactly the slideshow a 60 fps share must not become.
        const screenSender = localScreenShareProducer.current?.rtpSender;
        if (screenSender) {
          try {
            const params = screenSender.getParameters();
            params.degradationPreference = screenShareDegradationPreference(
              screenQuality.framerate
            );
            await screenSender.setParameters(params);
          } catch (error) {
            logVoice('Error setting screen share degradation preference', {
              error
            });
          }
        }

        localScreenShareProducer.current?.on('@close', async () => {
          logVoice('Screen share producer closed');

          const trpc = getVoiceTRPCClient();
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
        if (!devices.shareSystemAudio) {
          // Picture-only share: the driver capture must not run either
          // (a stale one from an earlier share would still feed audio).
          window.pulseDesktop?.audioCapture?.stop();
        } else if (window.pulseDesktop?.audioCapture) {
          try {
            const available =
              await window.pulseDesktop.audioCapture.isAvailable();
            if (available) {
              logVoice(
                'macOS: Starting system audio capture via virtual device'
              );

              // Remove any audio track from getDisplayMedia — we'll replace it
              // with our virtual device capture which is more reliable
              if (audioTrack) {
                logVoice(
                  'macOS: Removing system picker audio track in favor of virtual device'
                );
                audioTrack.stop();
                stream.removeTrack(audioTrack);
                audioTrack = undefined as unknown as MediaStreamTrack;
              }

              const captureResult =
                await window.pulseDesktop.audioCapture.start();

              if (captureResult) {
                // Find the Pulse Audio virtual input device
                const mediaDevices =
                  await navigator.mediaDevices.enumerateDevices();

                logVoice('macOS: Available audio input devices', {
                  devices: mediaDevices
                    .filter((d) => d.kind === 'audioinput')
                    .map((d) => ({ id: d.deviceId, label: d.label }))
                });

                const pulseInput = mediaDevices.find(
                  (d) =>
                    d.kind === 'audioinput' && d.label.includes('Pulse Audio')
                );

                if (pulseInput) {
                  logVoice('macOS: Capturing from Pulse Audio device', {
                    deviceId: pulseInput.deviceId
                  });
                  const audioStream = await navigator.mediaDevices.getUserMedia(
                    {
                      audio: {
                        deviceId: { exact: pulseInput.deviceId },
                        autoGainControl: false,
                        echoCancellation: false,
                        noiseSuppression: false,
                        channelCount: 2,
                        sampleRate: 48000
                      }
                    }
                  );

                  audioTrack = audioStream.getAudioTracks()[0];
                  if (audioTrack) {
                    stream.addTrack(audioTrack);
                    setSystemAudioActive(true);

                    // Find the real output device by name so we can route voice
                    // chat audio directly to it (bypassing the aggregate device).
                    // This prevents remote users' voices from being re-captured.
                    const realOutput = mediaDevices.find(
                      (d) =>
                        d.kind === 'audiooutput' &&
                        d.label.includes(captureResult.realOutputDeviceName)
                    );
                    if (realOutput) {
                      logVoice('macOS: Routing voice to real output', {
                        deviceId: realOutput.deviceId,
                        label: realOutput.label
                      });
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
                      logVoice(
                        'macOS: Re-acquiring mic with echo cancellation'
                      );
                      await attachMicStream();
                    }
                  }
                } else {
                  logVoice(
                    'macOS: Pulse Audio input device not found, available inputs listed above'
                  );
                  window.pulseDesktop.audioCapture.stop();
                }
              }
            } else {
              logVoice(
                'macOS: Audio driver not available, using system audio track if present'
              );
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

            const trpc = getVoiceTRPCClient();
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

        // The track's onended (the browser's native "Stop sharing") is
        // wired by the caller (use-voice-controls), which owns the share
        // state and the server notification — one handler, not two.
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
    localAudioProducer,
    attachMicStream,
    setSystemAudioActive,
    screenVideoConstraints,
    screenQuality.framerate,
    screenQuality.resolution,
    devices.screenAudioBitrate,
    devices.shareSystemAudio
  ]);

  /**
   * Swap the screen-share source mid-share: fresh getDisplayMedia, then
   * replaceTrack on the live SCREEN producer — remote consumers keep
   * playing, no stop/start cycle. Audio follows the new capture, except
   * during macOS virtual-device system audio which is source-independent
   * and stays untouched.
   */
  const changeScreenShareSource = useCallback(async () => {
    const videoProducer = localScreenShareProducer.current;
    if (!videoProducer || videoProducer.closed) {
      throw new Error('No active screen share to change');
    }

    logVoice('Changing screen share source');

    // Same constraints as startScreenShareStream. A cancelled picker
    // rejects here, before any existing state is touched.
    const newStream = await navigator.mediaDevices.getDisplayMedia({
      video: screenVideoConstraints,
      audio: screenShareAudioConstraints(devices.shareSystemAudio),
      // Prevent sharing the app's own tab (major source of audio echo)
      selfBrowserSurface: 'exclude',
      preferCurrentTab: false
    } as DisplayMediaStreamOptions);

    logVoice('New screen share stream obtained', { stream: newStream });

    const newVideoTrack = newStream.getVideoTracks()[0];
    if (!newVideoTrack) {
      newStream.getTracks().forEach((track) => track.stop());
      throw new Error('No video track obtained for screen share');
    }

    newVideoTrack.contentHint = 'detail';

    const oldStream = localScreenShareStream;

    // replaceTrack stops the previous track itself (producer was created
    // with default stopTracks: true).
    await videoProducer.replaceTrack({ track: newVideoTrack });

    const newAudioTrack = newStream.getAudioTracks()[0];

    if (sharingSystemAudioRef.current) {
      // System audio capture is source-independent — keep the existing
      // audio producer and carry its track over to the new stream (so the
      // eventual stop/cleanup still finds it). The picker's own audio
      // track is redundant.
      if (newAudioTrack) {
        newAudioTrack.stop();
        newStream.removeTrack(newAudioTrack);
      }
      const oldAudioTrack = oldStream?.getAudioTracks()[0];
      if (oldAudioTrack) {
        oldStream?.removeTrack(oldAudioTrack);
        newStream.addTrack(oldAudioTrack);
      }
    } else {
      const audioProducer = localScreenShareAudioProducer.current;

      if (newAudioTrack && audioProducer && !audioProducer.closed) {
        await audioProducer.replaceTrack({ track: newAudioTrack });
        logVoice('Screen share audio track replaced');
      } else if (newAudioTrack) {
        logVoice('New source has audio, producing screen share audio', {
          audioTrack: newAudioTrack
        });

        const audioBitrate = (devices.screenAudioBitrate ?? 128) * 1000;

        localScreenShareAudioProducer.current =
          await producerTransport.current?.produce({
            track: newAudioTrack,
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

          const trpc = getVoiceTRPCClient();
          if (!trpc) return;

          try {
            await trpc.voice.closeProducer.mutate({
              kind: StreamKind.SCREEN_AUDIO
            });
          } catch (error) {
            logVoice('Error closing screen share audio producer', { error });
          }
        });
      } else if (audioProducer && !audioProducer.closed) {
        // New source has no audio — close() fires the '@close' handler
        // registered at produce time, which notifies voice.closeProducer.
        logVoice(
          'New source has no audio, closing screen share audio producer'
        );
        audioProducer.close();
        localScreenShareAudioProducer.current = undefined;
      }

      oldStream?.getAudioTracks().forEach((track) => track.stop());
    }

    oldStream?.getVideoTracks().forEach((track) => track.stop());
    setLocalScreenShare(newStream);

    // A replaced/re-produced audio producer starts unpaused — carry the
    // outgoing-mute state across the source swap.
    if (
      screenAudioMutedRef.current &&
      localScreenShareAudioProducer.current &&
      !localScreenShareAudioProducer.current.closed
    ) {
      localScreenShareAudioProducer.current.pause();
    }

    return newVideoTrack;
  }, [
    localScreenShareStream,
    setLocalScreenShare,
    localScreenShareProducer,
    localScreenShareAudioProducer,
    producerTransport,
    screenVideoConstraints,
    devices.screenAudioBitrate,
    devices.shareSystemAudio
  ]);

  /**
   * Mute/unmute the OUTGOING screen-share audio: pauses the SCREEN_AUDIO
   * producer so listeners get silence. The capture keeps running — this
   * is a broadcast gate, not a device release, and it is independent of
   * the mic.
   */
  const toggleScreenShareAudio = useCallback(() => {
    const producer = localScreenShareAudioProducer.current;
    if (!producer || producer.closed) return;

    if (producer.paused) {
      producer.resume();
      screenAudioMutedRef.current = false;
      setScreenAudioMuted(false);
      logVoice('Screen share audio unmuted');
    } else {
      producer.pause();
      screenAudioMutedRef.current = true;
      setScreenAudioMuted(true);
      logVoice('Screen share audio muted');
    }
  }, [localScreenShareAudioProducer]);

  // Hot-swap webcam track on the existing producer when device settings change
  const reapplyWebcamSettings = useCallback(
    async (webcamEnabled: boolean) => {
      if (!webcamEnabled) return;
      if (!localVideoProducer.current || localVideoProducer.current.closed)
        return;

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
    },
    [
      localVideoProducer,
      localVideoStream,
      setLocalVideoStream,
      devices.webcamId,
      devices.webcamFramerate,
      devices.webcamResolution
    ]
  );

  // Live re-apply screen-share quality on an ACTIVE share. Resolution and
  // framerate go through applyConstraints on the captured track (downscales
  // in the browser, no re-pick); audio bitrate through the sender's
  // encoding parameters.
  const reapplyScreenShareSettings = useCallback(async () => {
    const videoTrack = localScreenShareStream?.getVideoTracks()[0];
    if (videoTrack && videoTrack.readyState === 'live') {
      try {
        await videoTrack.applyConstraints(screenVideoConstraints);
        logVoice('Screen share constraints re-applied live');
      } catch (error) {
        logVoice('Error re-applying screen share constraints', { error });
      }
    }

    // A new resolution or frame rate means a new bitrate budget, hint and
    // degradation axis — re-pin all three alongside the constraints.
    if (videoTrack && videoTrack.readyState === 'live') {
      videoTrack.contentHint = screenShareContentHint(screenQuality.framerate);
    }
    const videoSender = localScreenShareProducer.current?.closed
      ? undefined
      : localScreenShareProducer.current?.rtpSender;
    if (videoSender) {
      try {
        const params = videoSender.getParameters();
        if (params.encodings?.length) {
          params.encodings[0].maxBitrate = screenShareMaxBitrate(
            screenQuality.resolution,
            screenQuality.framerate
          );
          params.degradationPreference = screenShareDegradationPreference(
            screenQuality.framerate
          );
          await videoSender.setParameters(params);
          logVoice('Screen share video bitrate ceiling re-applied live');
        }
      } catch (error) {
        logVoice('Error re-applying screen share video bitrate', { error });
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
    localScreenShareProducer,
    localScreenShareAudioProducer,
    screenVideoConstraints,
    screenQuality.framerate,
    screenQuality.resolution,
    devices.screenAudioBitrate
  ]);

  const cleanup = useCallback(() => {
    logVoice('Running voice provider cleanup');

    sessionRef.current = null;
    stopMonitoring();
    resetStats();
    clearLocalStreams();
    clearRemoteUserStreams();
    clearExternalStreams();
    cleanupTransports();
    micPipelineRef.current?.destroy();
    micPipelineRef.current = null;
    setSystemAudioActive(false);
    screenAudioMutedRef.current = false;
    setScreenAudioMuted(false);
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

  /**
   * Build the media session for a channel the server has already joined
   * us to. Transport creation throws (no media path = no session); a
   * microphone that cannot be sent is NOT a failure — the user joins
   * muted and is told. On failure the server-side session is left too:
   * otherwise the user stayed joined with no media path, a silent ghost
   * in every peer's roster until they left.
   */
  const rebuildSession = useCallback(
    async (
      incomingRouterRtpCapabilities: RtpCapabilities,
      channelId: number
    ) => {
      logVoice('Initializing voice provider', {
        incomingRouterRtpCapabilities,
        channelId
      });

      cleanup();
      sessionRef.current = {
        routerRtpCapabilities: incomingRouterRtpCapabilities,
        channelId
      };

      try {
        setLoading(true);
        setConnectionStatus(ConnectionStatus.CONNECTING);

        routerRtpCapabilities.current = incomingRouterRtpCapabilities;

        // mediasoup-client is only needed once a voice session starts;
        // the provider itself is mounted for the whole app, so the
        // library is fetched here, on the first join, not with the app.
        const { Device } = await import('mediasoup-client');
        const device = new Device();

        await device.load({
          routerRtpCapabilities: incomingRouterRtpCapabilities
        });

        deviceRef.current = device;

        await createProducerTransport(device, iceOptions);
        await createConsumerTransport(device, iceOptions);
        await consumeExistingProducers(device.rtpCapabilities);
        await attachMicStream();

        startMonitoring(producerTransport.current, consumerTransport.current);
        setConnectionStatus(ConnectionStatus.CONNECTED);
        setLoading(false);
        playSound(SoundType.OWN_USER_JOINED_VOICE_CHANNEL);
      } catch (error) {
        logVoice('Error initializing voice provider', { error });

        setConnectionStatus(ConnectionStatus.FAILED);
        setLoading(false);

        await leaveCurrentVoice();

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
      consumerTransport,
      iceOptions
    ]
  );

  useEffect(() => {
    rebuildSessionRef.current = rebuildSession;
  }, [rebuildSession]);

  /** A fresh session (user join or reconnect rejoin): its own retry budget. */
  const init = useCallback(
    async (
      incomingRouterRtpCapabilities: RtpCapabilities,
      channelId: number
    ) => {
      transportRetryUsedRef.current = false;
      await rebuildSession(incomingRouterRtpCapabilities, channelId);
    },
    [rebuildSession]
  );

  // A reconnect re-joined the session server-side (features/server/
  // voice/rejoin); the media half is ours. init's own failure path has
  // already left the channel by the time the toast shows.
  useEffect(
    () =>
      onAppEvent('voice-rejoin', ({ routerRtpCapabilities, channelId }) => {
        init(routerRtpCapabilities, channelId).catch(() => {
          toast.error('Voice disconnected');
        });
      }),
    [init]
  );

  const {
    toggleMic,
    toggleSound,
    toggleWebcam,
    toggleScreenShare,
    changeScreenShare,
    ownVoiceState
  } = useVoiceControls({
    attachMicStream,
    detachMicStream,
    startWebcamStream,
    stopWebcamStream,
    startScreenShareStream,
    stopScreenShareStream,
    changeScreenShareSource
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
    getDeviceRtpCapabilities
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
  }, [
    devices,
    connectionStatus,
    attachMicStream,
    reapplyWebcamSettings,
    reapplyScreenShareSettings,
    ownVoiceState.micMuted,
    ownVoiceState.webcamEnabled,
    ownVoiceState.sharingScreen
  ]);

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
      changeScreenShareSource,
      screenAudioMuted,
      toggleScreenShareAudio,

      toggleMic,
      toggleSound,
      toggleWebcam,
      toggleScreenShare,
      changeScreenShare,
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
      changeScreenShareSource,
      screenAudioMuted,
      toggleScreenShareAudio,

      toggleMic,
      toggleSound,
      toggleWebcam,
      toggleScreenShare,
      changeScreenShare,
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
        <SoundboardProvider>
          <div className="relative">
            <FloatingPinnedCard
              remoteUserStreams={remoteUserStreams}
              externalStreams={externalStreams}
              localScreenShareStream={localScreenShareStream}
              localVideoStream={localVideoStream}
            />
            {children}
          </div>
        </SoundboardProvider>
      </VolumeControlProvider>
    </VoiceProviderContext.Provider>
  );
});

export { VoiceProvider, VoiceProviderContext };
