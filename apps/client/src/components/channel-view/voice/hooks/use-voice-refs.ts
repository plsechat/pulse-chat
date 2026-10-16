import { useOutputSinkId, applySinkId } from '@/components/voice-provider/output-sink';
import { useVolumeControl } from '@/components/voice-provider/volume-control-context';
import { useIsOwnUser } from '@/features/server/users/hooks';
import { useVoice } from '@/features/server/voice/hooks';
import { StreamKind } from '@pulse/shared';
import { useEffect, useMemo } from 'react';
import { useAudioLevel } from './use-audio-level';

/**
 * Stream references for one card (a user, or a plugin stream by its
 * stream id). Audio playback of every remote stream lives in
 * PersistentAudioStreams — the cards attach video and read the
 * has-* flags; a card that also played audio was heard twice.
 */
const useVoiceRefs = (remoteId: number) => {
  const {
    remoteUserStreams,
    externalStreams,
    localAudioStream,
    localVideoStream,
    localScreenShareStream,
    ownVoiceState,
    getOrCreateRefs
  } = useVoice();
  const isOwnUser = useIsOwnUser(remoteId);
  const { getVolume, getUserVolumeKey } = useVolumeControl();
  const sinkId = useOutputSinkId();

  const {
    videoRef,
    audioRef,
    screenShareRef,
    screenShareAudioRef,
    externalVideoRef
  } = getOrCreateRefs(remoteId);

  const videoStream = useMemo(() => {
    if (isOwnUser) return localVideoStream;

    return remoteUserStreams[remoteId]?.[StreamKind.VIDEO];
  }, [remoteUserStreams, remoteId, isOwnUser, localVideoStream]);

  const audioStream = useMemo(() => {
    if (isOwnUser) return undefined;

    return remoteUserStreams[remoteId]?.[StreamKind.AUDIO];
  }, [remoteUserStreams, remoteId, isOwnUser]);

  const audioStreamForLevel = useMemo(() => {
    if (isOwnUser) return localAudioStream;

    return remoteUserStreams[remoteId]?.[StreamKind.AUDIO];
  }, [remoteUserStreams, remoteId, isOwnUser, localAudioStream]);

  const screenShareStream = useMemo(() => {
    if (isOwnUser) return localScreenShareStream;

    return remoteUserStreams[remoteId]?.[StreamKind.SCREEN];
  }, [remoteUserStreams, remoteId, isOwnUser, localScreenShareStream]);

  const screenShareAudioStream = useMemo(() => {
    if (isOwnUser) return undefined;

    return remoteUserStreams[remoteId]?.[StreamKind.SCREEN_AUDIO];
  }, [remoteUserStreams, remoteId, isOwnUser]);

  const externalAudioStream = useMemo(() => {
    if (isOwnUser) return undefined;

    const external = externalStreams[remoteId];

    return external?.audioStream;
  }, [externalStreams, remoteId, isOwnUser]);

  const externalVideoStream = useMemo(() => {
    if (isOwnUser) return undefined;

    const external = externalStreams[remoteId];

    return external?.videoStream;
  }, [externalStreams, remoteId, isOwnUser]);

  const { isSpeaking, speakingIntensity } = useAudioLevel(audioStreamForLevel);

  const userVolumeKey = getUserVolumeKey(remoteId);
  const userVolume = getVolume(userVolumeKey);

  // Screen share audio playback is handled by PersistentAudioStreams
  // (via AudioContext to avoid Chrome "communications" ducking).
  // We only need the stream reference here for the hasScreenShareAudioStream flag.

  useEffect(() => {
    if (!videoStream || !videoRef.current) return;

    videoRef.current.srcObject = videoStream;
  }, [videoStream, videoRef]);

  // Attach the voice audio stream and set volume
  useEffect(() => {
    if (!audioStream || !audioRef.current) return;

    if (audioRef.current.srcObject !== audioStream) {
      audioRef.current.srcObject = audioStream;
    }

    audioRef.current.volume = userVolume / 100;
  }, [audioStream, audioRef, userVolume]);

  // Same output routing as the persistent players (user's Output Device,
  // overridden by the system-audio capture bypass).
  useEffect(() => {
    applySinkId(audioRef.current, sinkId);
  }, [audioRef, sinkId]);

  useEffect(() => {
    if (!screenShareStream || !screenShareRef.current) return;

    if (screenShareRef.current.srcObject !== screenShareStream) {
      screenShareRef.current.srcObject = screenShareStream;
    }
  }, [screenShareStream, screenShareRef]);

  useEffect(() => {
    if (!externalVideoStream || !externalVideoRef.current) return;

    if (externalVideoRef.current.srcObject !== externalVideoStream) {
      externalVideoRef.current.srcObject = externalVideoStream;
    }
  }, [externalVideoStream, externalVideoRef]);

  useEffect(() => {
    if (!audioRef.current) return;

    audioRef.current.muted = ownVoiceState.soundMuted;
  }, [ownVoiceState.soundMuted, audioRef]);

  return {
    videoRef,
    audioRef,
    screenShareRef,
    screenShareAudioRef,
    externalVideoRef,
    hasAudioStream: !!audioStream,
    hasVideoStream: !!videoStream,
    hasScreenShareStream: !!screenShareStream,
    hasScreenShareAudioStream: !!screenShareAudioStream,
    hasExternalAudioStream: !!externalAudioStream,
    hasExternalVideoStream: !!externalVideoStream,
    isSpeaking,
    speakingIntensity
  };
};

export { useVoiceRefs };
