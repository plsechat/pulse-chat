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
  updateSavedMicTrack: () => {},
  ownVoiceState: {
    micMuted: false,
    soundMuted: false,
    webcamEnabled: false,
    sharingScreen: false
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
  const routerRtpCapabilities = useRef<RtpCapabilities | null>(null);
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

  const startMicStream = useCallback(async () => {
    try {
      logVoice('Starting microphone stream');

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: devices.microphoneId
            ? { exact: devices.microphoneId }
            : undefined,
          autoGainControl: devices.autoGainControl,
          echoCancellation: devices.echoCancellation,
          noiseSuppression: devices.noiseSuppression,
          sampleRate: 48000,
          channelCount: 2
        },
        video: false
      });

      logVoice('Microphone stream obtained', { stream });

      setLocalAudioStream(stream);

      const audioTrack = stream.getAudioTracks()[0];

      if (audioTrack) {
        logVoice('Obtained audio track', { audioTrack });

        localAudioProducer.current = await producerTransport.current?.produce({
          track: audioTrack,
          appData: { kind: StreamKind.AUDIO }
        });

        logVoice('Microphone audio producer created', {
          producer: localAudioProducer.current
        });

        localAudioProducer.current?.on('@close', async () => {
          logVoice('Audio producer closed');

          const trpc = getTRPCClient();

          try {
            await trpc.voice.closeProducer.mutate({
              kind: StreamKind.AUDIO
            });
          } catch (error) {
            logVoice('Error closing audio producer', { error });
          }
        });

        audioTrack.onended = () => {
          logVoice('Audio track ended, cleaning up microphone');

          localAudioStream?.getAudioTracks().forEach((track) => {
            track.stop();
          });
          localAudioProducer.current?.close();

          setLocalAudioStream(undefined);
        };
      } else {
        throw new Error('Failed to obtain audio track from microphone');
      }
    } catch (error) {
      logVoice('Error starting microphone stream', { error });
    }
  }, [
    producerTransport,
    setLocalAudioStream,
    localAudioProducer,
    localAudioStream,
    devices.microphoneId,
    devices.autoGainControl,
    devices.echoCancellation,
    devices.noiseSuppression
  ]);

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
    // forced ON during system audio capture to prevent acoustic bleed)
    if (sharingSystemAudio && localAudioProducer.current && !localAudioProducer.current.closed) {
      try {
        logVoice('macOS: Restoring mic to original settings');
        const newMicStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: devices.microphoneId
              ? { exact: devices.microphoneId }
              : undefined,
            autoGainControl: devices.autoGainControl,
            echoCancellation: devices.echoCancellation,
            noiseSuppression: devices.noiseSuppression,
            sampleRate: 48000,
            channelCount: 2
          },
          video: false
        });

        const newMicTrack = newMicStream.getAudioTracks()[0];
        if (newMicTrack) {
          await localAudioProducer.current.replaceTrack({ track: newMicTrack });
          localAudioStream?.getAudioTracks().forEach((t) => t.stop());
          setLocalAudioStream(newMicStream);
          logVoice('macOS: Mic restored to original settings');
        }
      } catch (err) {
        logVoice('macOS: Failed to restore mic settings', { error: err });
      }
    }

    setLocalScreenShare(undefined);
    setSharingSystemAudio(false);
    setRealOutputSinkId(undefined);
  }, [localScreenShareStream, setLocalScreenShare, localScreenShareProducer, localScreenShareAudioProducer, sharingSystemAudio, localAudioProducer, localAudioStream, setLocalAudioStream, devices.microphoneId, devices.autoGainControl, devices.echoCancellation, devices.noiseSuppression]);

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
        setSharingSystemAudio(isSystemAudio);

        localScreenShareProducer.current =
          await producerTransport.current?.produce({
            track: videoTrack,
            appData: { kind: StreamKind.SCREEN }
          });

        localScreenShareProducer.current?.on('@close', async () => {
          logVoice('Screen share producer closed');

          const trpc = getTRPCClient();

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
                    setSharingSystemAudio(true);

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

                    // Re-acquire the microphone with echo cancellation + noise
                    // suppression forced ON. The aggregate device routes system
                    // audio to the real speakers, and the built-in mic picks it
                    // up acoustically. Without this, the remote user hears the
                    // system audio bleeding through the mic stream.
                    if (localAudioProducer.current && !localAudioProducer.current.closed) {
                      try {
                        // Find the real microphone (exclude the Pulse Audio virtual device)
                        const realMic = mediaDevices.find(
                          (d) => d.kind === 'audioinput' &&
                            !d.label.includes('Pulse Audio') &&
                            (devices.microphoneId ? d.deviceId === devices.microphoneId : true)
                        );

                        if (realMic) {
                          logVoice('macOS: Re-acquiring mic with echo cancellation', { deviceId: realMic.deviceId, label: realMic.label });
                          const newMicStream = await navigator.mediaDevices.getUserMedia({
                            audio: {
                              deviceId: { exact: realMic.deviceId },
                              autoGainControl: true,
                              echoCancellation: true,
                              noiseSuppression: true,
                              sampleRate: 48000,
                              channelCount: 2
                            },
                            video: false
                          });

                          const newMicTrack = newMicStream.getAudioTracks()[0];
                          if (newMicTrack) {
                            await localAudioProducer.current.replaceTrack({ track: newMicTrack });
                            // Stop old tracks and update stream
                            localAudioStream?.getAudioTracks().forEach((t) => t.stop());
                            setLocalAudioStream(newMicStream);
                            logVoice('macOS: Mic re-acquired with echo cancellation enabled');
                          }
                        }
                      } catch (micErr) {
                        logVoice('macOS: Failed to re-acquire mic with echo cancellation', { error: micErr });
                      }
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
    localAudioStream,
    setLocalAudioStream,
    devices.screenResolution,
    devices.screenFramerate,
    devices.screenAudioBitrate,
    devices.microphoneId
  ]);

  // Hot-swap microphone track on the existing producer when device settings change
  const reapplyMicSettings = useCallback(async (micMuted: boolean, savedMicTrackUpdater: (track: MediaStreamTrack | null) => void) => {
    if (!localAudioProducer.current || localAudioProducer.current.closed) return;

    try {
      logVoice('Reapplying mic settings mid-call');

      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: devices.microphoneId
            ? { exact: devices.microphoneId }
            : undefined,
          autoGainControl: devices.autoGainControl,
          echoCancellation: devices.echoCancellation,
          noiseSuppression: devices.noiseSuppression,
          sampleRate: 48000,
          channelCount: 2
        },
        video: false
      });

      const newTrack = newStream.getAudioTracks()[0];
      if (!newTrack) return;

      // Stop old tracks
      localAudioStream?.getAudioTracks().forEach((t) => t.stop());

      if (micMuted) {
        // Mic is muted — update the saved track so unmute uses the new device
        savedMicTrackUpdater(newTrack);
      } else {
        await localAudioProducer.current!.replaceTrack({ track: newTrack });
      }

      setLocalAudioStream(newStream);
      logVoice('Mic settings reapplied successfully');
    } catch (error) {
      logVoice('Error reapplying mic settings', { error });
    }
  }, [
    localAudioProducer,
    localAudioStream,
    setLocalAudioStream,
    devices.microphoneId,
    devices.autoGainControl,
    devices.echoCancellation,
    devices.noiseSuppression
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

  const cleanup = useCallback(() => {
    logVoice('Running voice provider cleanup');

    stopMonitoring();
    resetStats();
    clearLocalStreams();
    clearRemoteUserStreams();
    clearExternalStreams();
    cleanupTransports();

    setConnectionStatus(ConnectionStatus.DISCONNECTED);
  }, [
    stopMonitoring,
    resetStats,
    clearLocalStreams,
    clearRemoteUserStreams,
    clearExternalStreams,
    cleanupTransports
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

        await createProducerTransport(device);
        await createConsumerTransport(device);
        await consumeExistingProducers(incomingRouterRtpCapabilities);
        await startMicStream();

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
      startMicStream,
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
    updateSavedMicTrack,
    ownVoiceState
  } = useVoiceControls({
    startMicStream,
    localAudioStream,
    localAudioProducer,
    startWebcamStream,
    stopWebcamStream,
    startScreenShareStream,
    stopScreenShareStream
  });

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
      prev.noiseSuppression !== devices.noiseSuppression ||
      prev.autoGainControl !== devices.autoGainControl;

    const webcamChanged =
      prev.webcamId !== devices.webcamId ||
      prev.webcamFramerate !== devices.webcamFramerate ||
      prev.webcamResolution !== devices.webcamResolution;

    if (micChanged) {
      reapplyMicSettings(ownVoiceState.micMuted, updateSavedMicTrack);
    }
    if (webcamChanged) {
      reapplyWebcamSettings(ownVoiceState.webcamEnabled);
    }
  }, [devices, connectionStatus, reapplyMicSettings, reapplyWebcamSettings, ownVoiceState.micMuted, ownVoiceState.webcamEnabled, updateSavedMicTrack]);

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
      updateSavedMicTrack,
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
      updateSavedMicTrack,
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
