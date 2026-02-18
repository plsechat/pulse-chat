import { useVolumeControl } from '@/components/voice-provider/volume-control-context';
import { useIsOwnUser } from '@/features/server/users/hooks';
import { useVoice } from '@/features/server/voice/hooks';
import { StreamKind } from '@pulse/shared';
import { useEffect, useMemo } from 'react';
import { useAudioLevel } from './use-audio-level';

const useVoiceRefs = (
  remoteId: number,
  pluginId?: string,
  streamKey?: string
) => {
  const {
    remoteUserStreams,
    externalStreams,
    localAudioStream,
    localVideoStream,
    localScreenShareStream,
    ownVoiceState,
    realOutputSinkId,
    getOrCreateRefs
  } = useVoice();
  const isOwnUser = useIsOwnUser(remoteId);
  const { getVolume, getUserVolumeKey, getExternalVolumeKey } =
    useVolumeControl();

  const {
    videoRef,
    audioRef,
    screenShareRef,
    screenShareAudioRef,
    externalAudioRef,
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

  const { audioLevel, isSpeaking, speakingIntensity } =
    useAudioLevel(audioStreamForLevel);

  const userVolumeKey = getUserVolumeKey(remoteId);
  const userVolume = getVolume(userVolumeKey);

  // Screen share audio playback is handled by PersistentAudioStreams
  // (via AudioContext to avoid Chrome "communications" ducking).
  // We only need the stream reference here for the hasScreenShareAudioStream flag.

  const externalVolumeKey =
    pluginId && streamKey ? getExternalVolumeKey(pluginId, streamKey) : null;

  const externalVolume = externalVolumeKey ? getVolume(externalVolumeKey) : 100;

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

  // When capturing system audio on macOS, route voice audio directly to the
  // real output device via setSinkId. This bypasses the aggregate device so
  // remote voices are audible but not re-captured by the virtual device.
  useEffect(() => {
    const el = audioRef.current;
    if (!el || !('setSinkId' in el)) return;

    const sinkId = realOutputSinkId ?? '';
    (el as unknown as { setSinkId(id: string): Promise<void> }).setSinkId(sinkId).catch(() => {});
  }, [audioRef, realOutputSinkId]);

  useEffect(() => {
    if (!screenShareStream || !screenShareRef.current) return;

    if (screenShareRef.current.srcObject !== screenShareStream) {
      screenShareRef.current.srcObject = screenShareStream;
    }
  }, [screenShareStream, screenShareRef]);

  useEffect(() => {
    if (!externalAudioStream || !externalAudioRef.current) return;

    if (externalAudioRef.current.srcObject !== externalAudioStream) {
      externalAudioRef.current.srcObject = externalAudioStream;
    }

    externalAudioRef.current.volume = externalVolume / 100;
  }, [externalAudioStream, externalAudioRef, externalVolume]);

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

  // Route external audio to real output device during system audio capture
  useEffect(() => {
    const el = externalAudioRef.current;
    if (!el || !('setSinkId' in el)) return;

    const sinkId = realOutputSinkId ?? '';
    (el as unknown as { setSinkId(id: string): Promise<void> }).setSinkId(sinkId).catch(() => {});
  }, [externalAudioRef, realOutputSinkId]);

  return {
    videoRef,
    audioRef,
    screenShareRef,
    screenShareAudioRef,
    externalAudioRef,
    externalVideoRef,
    hasAudioStream: !!audioStream,
    hasVideoStream: !!videoStream,
    hasScreenShareStream: !!screenShareStream,
    hasScreenShareAudioStream: !!screenShareAudioStream,
    hasExternalAudioStream: !!externalAudioStream,
    hasExternalVideoStream: !!externalVideoStream,
    audioLevel,
    isSpeaking,
    speakingIntensity
  };
};

export { useVoiceRefs };
