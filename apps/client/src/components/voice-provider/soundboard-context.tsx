import {
  useCurrentVoiceChannelId,
  useCurrentVoiceKind
} from '@/features/server/channels/hooks';
import {
  shouldPlayTriggeredSound,
  SOUND_RIPPLE_MS,
  soundElementVolume
} from '@/features/server/sounds/soundboard';
import { useOwnVoiceState } from '@/features/server/voice/hooks';
import type { IRootState } from '@/features/store';
import { getPublicFileUrl } from '@/helpers/get-file-url';
import { logVoice } from '@/helpers/browser-logger';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { getVoiceTRPCClient } from '@/lib/trpc';
import type { TSoundPlayEvent } from '@pulse/server/types';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import { toast } from 'sonner';
import { applySinkId, useOutputSinkId } from './output-sink';
import { SoundboardContext, type TSoundRipple } from './soundboard-store';
import { useVolumeControl } from './volume-control-context';

/**
 * The soundboard's client half. The server fans one VOICE_SOUND_PLAY
 * out to the room; this provider — mounted inside the VoiceProvider so
 * it shares the output sink and the per-user volume sliders — plays the
 * clip through the call's output and remembers who triggered it for a
 * moment, so the player's tile can ripple. Playback is local on
 * purpose: the server has no decoder and does not mix the clip into
 * the SFU, so deafening (own or moderator) silences it here.
 */

const voiceInstanceDomainSelector = (state: IRootState) =>
  state.server.voiceInstanceDomain;

type TSoundboardProviderProps = { children: React.ReactNode };

const SoundboardProvider = memo(({ children }: TSoundboardProviderProps) => {
  const channelId = useCurrentVoiceChannelId();
  const kind = useCurrentVoiceKind();
  const voiceInstanceDomain = useSelector(voiceInstanceDomainSelector);
  const ownVoiceState = useOwnVoiceState();
  const sinkId = useOutputSinkId();
  const { getVolume, getUserVolumeKey } = useVolumeControl();

  const [ripples, setRipples] = useState<Record<number, TSoundRipple>>({});

  // Read at event time, never at subscribe time: the subscription lives
  // for the whole session while these change underneath it.
  const ownStateRef = useRef(ownVoiceState);
  const sinkRef = useRef(sinkId);
  const volumeForRef = useRef((userId: number) => getVolume(getUserVolumeKey(userId)));
  const domainRef = useRef(voiceInstanceDomain);
  useEffect(() => {
    ownStateRef.current = ownVoiceState;
  }, [ownVoiceState]);
  useEffect(() => {
    sinkRef.current = sinkId;
  }, [sinkId]);
  useEffect(() => {
    volumeForRef.current = (userId: number) => getVolume(getUserVolumeKey(userId));
  }, [getVolume, getUserVolumeKey]);
  useEffect(() => {
    domainRef.current = voiceInstanceDomain;
  }, [voiceInstanceDomain]);

  const playLocally = useCallback((event: TSoundPlayEvent) => {
    if (!shouldPlayTriggeredSound(ownStateRef.current)) return;

    const url = getPublicFileUrl(event.file.name, domainRef.current);
    const audio = new Audio(url);
    audio.preload = 'auto';
    // The clip follows the player's own volume slider: a member you
    // turned down does not get louder through the soundboard.
    audio.volume = soundElementVolume(event.volume, volumeForRef.current(event.userId));
    applySinkId(audio, sinkRef.current);
    audio.play().catch((error) => {
      logVoice('Soundboard clip could not play', { error, soundId: event.soundId });
    });
  }, []);

  // One subscription per server voice session; DM calls have no soundboard.
  useEffect(() => {
    if (!channelId || kind !== 'channel') return;
    const trpc = getVoiceTRPCClient();
    if (!trpc) return;

    const timers = new Map<number, ReturnType<typeof setTimeout>>();

    const sub = trpc.voice.onSoundPlay.subscribe(undefined, {
      onData: (event) => {
        if (event.channelId !== channelId) return;

        playLocally(event);

        const ripple: TSoundRipple = {
          soundId: event.soundId,
          name: event.name,
          emoji: event.emoji,
          at: Date.now()
        };
        setRipples((prev) => ({ ...prev, [event.userId]: ripple }));

        const existing = timers.get(event.userId);
        if (existing) clearTimeout(existing);
        timers.set(
          event.userId,
          setTimeout(() => {
            timers.delete(event.userId);
            setRipples((prev) => {
              if (prev[event.userId] !== ripple) return prev;
              const next = { ...prev };
              delete next[event.userId];
              return next;
            });
          }, SOUND_RIPPLE_MS)
        );
      },
      onError: (error) => {
        logVoice('onSoundPlay subscription error', { error });
      }
    });

    return () => {
      sub.unsubscribe();
      for (const timer of timers.values()) clearTimeout(timer);
      setRipples({});
    };
  }, [channelId, kind, playLocally]);

  const playSound = useCallback(
    async (soundId: number) => {
      if (!channelId || kind !== 'channel') return false;
      const trpc = getVoiceTRPCClient();
      if (!trpc) return false;

      try {
        await trpc.voice.playSound.mutate({ channelId, soundId });
        return true;
      } catch (error) {
        toast.error(getTrpcError(error, 'Could not play that sound'));
        return false;
      }
    },
    [channelId, kind]
  );

  const value = useMemo(() => ({ playSound, ripples }), [playSound, ripples]);

  return (
    <SoundboardContext.Provider value={value}>
      {children}
    </SoundboardContext.Provider>
  );
});

export { SoundboardProvider };
