import { useVolumeControl } from '@/components/voice-provider/volume-control-context';
import { setSoundOutputSinkId } from '@/features/server/sounds/actions';
import { useOwnVoiceState } from '@/features/server/voice/hooks';
import { externalStreamByIdSelector } from '@/features/server/voice/selectors';
import type { IRootState } from '@/features/store';
import { StreamKind } from '@pulse/shared';
import { memo, useEffect, useRef } from 'react';
import { useSelector } from 'react-redux';
import { useVoice } from '@/features/server/voice/hooks';
import { applySinkId, useOutputSinkId } from './output-sink';

/**
 * Renders hidden audio elements for each remote user's streams.
 * Driven by the VoiceProvider's remoteUserStreams (mediasoup state),
 * NOT by Redux voiceMap — so audio persists across server navigation.
 *
 * This is the ONLY place remote audio is played: the voice/stream cards
 * render video and indicators but no <audio>, so a stream is never
 * heard twice while its channel view is open.
 *
 * Voice audio uses <audio> elements directly.
 * Screen share audio uses AudioContext with "playback" latency hint to
 * avoid Chrome's "communications" audio category ducking.
 *
 * Every player is routed to the resolved output sink (the user's Output
 * Device, overridden by the capture bypass) — see output-sink.ts.
 */

const ensurePlaying = (audio: HTMLAudioElement) => {
  if (audio.paused && audio.srcObject) {
    audio.play().catch(() => {
      // Autoplay blocked — will be unblocked on next user interaction
    });
  }
};

type TRemoteUserAudioProps = {
  userId: number;
  audioStream: MediaStream;
  sinkId: string;
};

const RemoteUserAudio = memo(
  ({ userId, audioStream, sinkId }: TRemoteUserAudioProps) => {
    const audioRef = useRef<HTMLAudioElement>(null);
    const { getVolume, getUserVolumeKey } = useVolumeControl();
    const ownVoiceState = useOwnVoiceState();

    const volumeKey = getUserVolumeKey(userId);
    const volume = getVolume(volumeKey);

    useEffect(() => {
      if (!audioRef.current) return;
      audioRef.current.srcObject = audioStream;
      audioRef.current.volume = volume / 100;
      ensurePlaying(audioRef.current);
    }, [audioStream, volume]);

    useEffect(() => {
      if (!audioRef.current) return;
      audioRef.current.muted = ownVoiceState.soundMuted;
    }, [ownVoiceState.soundMuted]);

    useEffect(() => {
      applySinkId(audioRef.current, sinkId);
    }, [sinkId]);

    return (
      <audio
        ref={audioRef}
        className="hidden"
        autoPlay
        data-user-id={userId}
        data-persistent
      />
    );
  }
);

/**
 * Plays screen share audio via AudioContext to avoid Chrome's
 * "communications" audio ducking that affects <audio> elements.
 */
type TRemoteScreenShareAudioProps = {
  userId: number;
  audioStream: MediaStream;
  sinkId: string;
};

const RemoteScreenShareAudio = memo(
  ({ userId, audioStream, sinkId }: TRemoteScreenShareAudioProps) => {
    const audioCtxRef = useRef<AudioContext | null>(null);
    const gainRef = useRef<GainNode | null>(null);
    const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
    const { getVolume, getScreenVolumeKey } = useVolumeControl();
    const ownVoiceState = useOwnVoiceState();

    // Screen-specific key — stream audio volume is independent of the
    // user's voice volume.
    const volumeKey = getScreenVolumeKey(userId);
    const volume = getVolume(volumeKey);

    // Create AudioContext and connect the stream
    useEffect(() => {
      // Create context with playback latency hint to avoid ducking
      if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
        audioCtxRef.current = new AudioContext({ latencyHint: 'playback' });
        gainRef.current = audioCtxRef.current.createGain();
        gainRef.current.connect(audioCtxRef.current.destination);
      }

      const ctx = audioCtxRef.current;
      const gain = gainRef.current!;

      // Disconnect old source if any
      sourceRef.current?.disconnect();

      const source = ctx.createMediaStreamSource(audioStream);
      source.connect(gain);
      sourceRef.current = source;

      // Resume if suspended (autoplay policy)
      if (ctx.state === 'suspended') {
        ctx.resume();
      }

      return () => {
        source.disconnect();
        if (sourceRef.current === source) {
          sourceRef.current = null;
        }
      };
    }, [audioStream]);

    // Runs after the effect above on first render, so the context exists.
    useEffect(() => {
      applySinkId(audioCtxRef.current, sinkId);
    }, [sinkId, audioStream]);

    // Update volume via gain node
    useEffect(() => {
      if (gainRef.current) {
        gainRef.current.gain.value = ownVoiceState.soundMuted ? 0 : volume / 100;
      }
    }, [volume, ownVoiceState.soundMuted]);

    // Clean up on unmount
    useEffect(() => {
      return () => {
        sourceRef.current?.disconnect();
        gainRef.current?.disconnect();
        if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
          audioCtxRef.current.close();
        }
      };
    }, []);

    // No visible element — AudioContext handles playback
    return null;
  }
);

type TExternalStreamAudioProps = {
  streamId: number;
  audioStream: MediaStream;
  sinkId: string;
};

const ExternalStreamAudio = memo(
  ({ streamId, audioStream, sinkId }: TExternalStreamAudioProps) => {
    const audioRef = useRef<HTMLAudioElement>(null);
    const ownVoiceState = useOwnVoiceState();
    const { getVolume, getExternalVolumeKey } = useVolumeControl();
    // The card's slider stores the volume under the plugin/key pair the
    // stream was announced with; the media itself only knows its id.
    const stream = useSelector((state: IRootState) =>
      externalStreamByIdSelector(state, streamId)
    );
    const volume = stream
      ? getVolume(getExternalVolumeKey(stream.pluginId, stream.key))
      : 100;

    useEffect(() => {
      if (!audioRef.current) return;
      audioRef.current.srcObject = audioStream;
      audioRef.current.volume = volume / 100;
      ensurePlaying(audioRef.current);
    }, [audioStream, volume]);

    useEffect(() => {
      if (!audioRef.current) return;
      audioRef.current.muted = ownVoiceState.soundMuted;
    }, [ownVoiceState.soundMuted]);

    useEffect(() => {
      applySinkId(audioRef.current, sinkId);
    }, [sinkId]);

    return (
      <audio
        ref={audioRef}
        className="hidden"
        autoPlay
        data-stream-id={streamId}
        data-persistent
      />
    );
  }
);

const PersistentAudioStreams = memo(() => {
  const { remoteUserStreams, externalStreams } = useVoice();
  const sinkId = useOutputSinkId();

  // The app's own sounds (join/leave cues, message pings, the call ring)
  // follow the same output as voice; this is the one always-mounted
  // place that sees both the device setting and the capture bypass.
  useEffect(() => {
    setSoundOutputSinkId(sinkId);
  }, [sinkId]);

  return (
    <>
      {Object.entries(remoteUserStreams).map(([userIdStr, streams]) => {
        const userId = Number(userIdStr);
        const audioStream = streams[StreamKind.AUDIO];
        const screenAudioStream = streams[StreamKind.SCREEN_AUDIO];

        return (
          <span key={userId}>
            {audioStream && (
              <RemoteUserAudio
                userId={userId}
                audioStream={audioStream}
                sinkId={sinkId}
              />
            )}
            {screenAudioStream && (
              <RemoteScreenShareAudio
                userId={userId}
                audioStream={screenAudioStream}
                sinkId={sinkId}
              />
            )}
          </span>
        );
      })}
      {Object.entries(externalStreams).map(([streamIdStr, stream]) => {
        const streamId = Number(streamIdStr);

        if (!stream.audioStream) return null;

        return (
          <ExternalStreamAudio
            key={streamId}
            streamId={streamId}
            audioStream={stream.audioStream}
            sinkId={sinkId}
          />
        );
      })}
    </>
  );
});

export { PersistentAudioStreams };
