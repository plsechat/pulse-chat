import { useVolumeControl } from '@/components/voice-provider/volume-control-context';
import { useOwnVoiceState } from '@/features/server/voice/hooks';
import { StreamKind } from '@pulse/shared';
import { memo, useEffect, useRef } from 'react';
import { useVoice } from '@/features/server/voice/hooks';

/**
 * Renders hidden audio elements for each remote user's streams.
 * Driven by the VoiceProvider's remoteUserStreams (mediasoup state),
 * NOT by Redux voiceMap — so audio persists across server navigation.
 *
 * Voice audio uses <audio> elements directly.
 * Screen share audio uses AudioContext with "playback" latency hint to
 * avoid Chrome's "communications" audio category ducking.
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
};

const RemoteUserAudio = memo(
  ({ userId, audioStream }: TRemoteUserAudioProps) => {
    const audioRef = useRef<HTMLAudioElement>(null);
    const { getVolume, getUserVolumeKey } = useVolumeControl();
    const ownVoiceState = useOwnVoiceState();
    const { realOutputSinkId } = useVoice();

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

    // Route voice audio directly to real output device when capturing system
    // audio, so remote voices don't get re-captured by the virtual device
    useEffect(() => {
      const el = audioRef.current;
      if (!el || !('setSinkId' in el)) return;

      const sinkId = realOutputSinkId ?? '';
      (el as unknown as { setSinkId(id: string): Promise<void> }).setSinkId(sinkId).catch(() => {
        // setSinkId can fail if device disconnected — not critical
      });
    }, [realOutputSinkId]);

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
};

const RemoteScreenShareAudio = memo(
  ({ userId, audioStream }: TRemoteScreenShareAudioProps) => {
    const audioCtxRef = useRef<AudioContext | null>(null);
    const gainRef = useRef<GainNode | null>(null);
    const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
    const { getVolume, getUserVolumeKey } = useVolumeControl();
    const ownVoiceState = useOwnVoiceState();
    const { realOutputSinkId } = useVoice();

    const volumeKey = getUserVolumeKey(userId);
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

    // Route to real output device during system audio capture
    useEffect(() => {
      if (!audioCtxRef.current) return;
      if (realOutputSinkId && 'setSinkId' in audioCtxRef.current) {
        (audioCtxRef.current as unknown as { setSinkId(id: string): Promise<void> }).setSinkId(realOutputSinkId).catch(() => {});
      }
    }, [realOutputSinkId]);

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
};

const ExternalStreamAudio = memo(
  ({ streamId, audioStream }: TExternalStreamAudioProps) => {
    const audioRef = useRef<HTMLAudioElement>(null);
    const ownVoiceState = useOwnVoiceState();
    const { realOutputSinkId } = useVoice();

    useEffect(() => {
      if (!audioRef.current) return;
      audioRef.current.srcObject = audioStream;
      ensurePlaying(audioRef.current);
    }, [audioStream]);

    useEffect(() => {
      if (!audioRef.current) return;
      audioRef.current.muted = ownVoiceState.soundMuted;
    }, [ownVoiceState.soundMuted]);

    // Route to real output device during system audio capture
    useEffect(() => {
      const el = audioRef.current;
      if (!el || !('setSinkId' in el)) return;

      const sinkId = realOutputSinkId ?? '';
      (el as unknown as { setSinkId(id: string): Promise<void> }).setSinkId(sinkId).catch(() => {});
    }, [realOutputSinkId]);

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
              />
            )}
            {screenAudioStream && (
              <RemoteScreenShareAudio
                userId={userId}
                audioStream={screenAudioStream}
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
          />
        );
      })}
    </>
  );
});

export { PersistentAudioStreams };
