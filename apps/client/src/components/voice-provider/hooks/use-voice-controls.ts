import { useCurrentVoiceChannelId } from '@/features/server/channels/hooks';
import { playSound } from '@/features/server/sounds/actions';
import { SoundType } from '@/features/server/types';
import { updateOwnVoiceState } from '@/features/server/voice/actions';
import { useOwnVoiceState } from '@/features/server/voice/hooks';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { getTRPCClient } from '@/lib/trpc';
import type { AppData, Producer } from 'mediasoup-client/types';
import { useCallback, useEffect, useRef } from 'react';
import { toast } from 'sonner';

type TUseVoiceControlsParams = {
  startMicStream: () => Promise<void>;
  localAudioStream: MediaStream | undefined;
  localAudioProducer: React.RefObject<Producer<AppData> | undefined>;

  startWebcamStream: () => Promise<void>;
  stopWebcamStream: () => void;

  startScreenShareStream: () => Promise<MediaStreamTrack>;
  stopScreenShareStream: () => void | Promise<void>;
};

const useVoiceControls = ({
  startMicStream,
  localAudioStream,
  localAudioProducer,
  startWebcamStream,
  stopWebcamStream,
  startScreenShareStream,
  stopScreenShareStream
}: TUseVoiceControlsParams) => {
  const ownVoiceState = useOwnVoiceState();
  const currentVoiceChannelId = useCurrentVoiceChannelId();

  // Store the real mic track so we can restore it when unmuting.
  // Using replaceTrack instead of track.enabled avoids a macOS browser bug
  // where disabling one getUserMedia audio track affects other audio captures
  // (e.g., screen share system audio via virtual audio device).
  const realMicTrackRef = useRef<MediaStreamTrack | null>(null);

  // Mirror localAudioStream state in a ref to avoid stale closure in toggleMic
  const localAudioStreamRef = useRef(localAudioStream);
  useEffect(() => {
    localAudioStreamRef.current = localAudioStream;
  }, [localAudioStream]);

  const toggleMic = useCallback(async () => {
    const newState = !ownVoiceState.micMuted;
    const trpc = getTRPCClient();

    updateOwnVoiceState({ micMuted: newState });
    playSound(
      newState ? SoundType.OWN_USER_MUTED_MIC : SoundType.OWN_USER_UNMUTED_MIC
    );

    if (!currentVoiceChannelId) return;

    // Mute/unmute by replacing the producer's track rather than setting
    // track.enabled. On macOS, track.enabled = false on one getUserMedia
    // capture can interfere with other concurrent audio captures (e.g.,
    // the Pulse Audio virtual device used for screen share system audio).
    const stream = localAudioStreamRef.current;
    const producer = localAudioProducer.current;
    if (producer && !producer.closed) {
      try {
        if (newState) {
          // Muting: save the real track and replace with nothing
          const currentTrack = stream?.getAudioTracks()[0];
          if (currentTrack) {
            realMicTrackRef.current = currentTrack;
          }
          await producer.replaceTrack({ track: null });
        } else {
          // Unmuting: restore the real mic track
          const savedTrack = realMicTrackRef.current;
          if (savedTrack && savedTrack.readyState === 'live') {
            await producer.replaceTrack({ track: savedTrack });
            realMicTrackRef.current = null;
          } else {
            // Track was ended/lost — re-acquire the mic
            realMicTrackRef.current = null;
            await startMicStream();
          }
        }
      } catch {
        // Fallback: if replaceTrack fails, use track.enabled
        stream?.getAudioTracks().forEach((track) => {
          track.enabled = !newState;
        });
      }
    } else {
      // No producer yet — use track.enabled as fallback
      stream?.getAudioTracks().forEach((track) => {
        track.enabled = !newState;
      });
    }

    try {
      await trpc.voice.updateState.mutate({
        micMuted: newState
      });

      if (!stream) {
        await startMicStream();
      }
    } catch (error) {
      toast.error(getTrpcError(error, 'Failed to update microphone state'));
    }
  }, [
    ownVoiceState.micMuted,
    startMicStream,
    currentVoiceChannelId,
    localAudioProducer
  ]);

  const toggleSound = useCallback(async () => {
    const newState = !ownVoiceState.soundMuted;
    const trpc = getTRPCClient();

    updateOwnVoiceState({ soundMuted: newState });
    playSound(
      newState
        ? SoundType.OWN_USER_MUTED_SOUND
        : SoundType.OWN_USER_UNMUTED_SOUND
    );

    if (!currentVoiceChannelId) return;

    try {
      await trpc.voice.updateState.mutate({
        soundMuted: newState
      });
    } catch (error) {
      toast.error(getTrpcError(error, 'Failed to update sound state'));
    }
  }, [ownVoiceState.soundMuted, currentVoiceChannelId]);

  const toggleWebcam = useCallback(async () => {
    if (!currentVoiceChannelId) return;

    const newState = !ownVoiceState.webcamEnabled;
    const trpc = getTRPCClient();

    updateOwnVoiceState({ webcamEnabled: newState });

    playSound(
      newState
        ? SoundType.OWN_USER_STARTED_WEBCAM
        : SoundType.OWN_USER_STOPPED_WEBCAM
    );

    try {
      await trpc.voice.updateState.mutate({
        webcamEnabled: newState
      });

      if (newState) {
        await startWebcamStream();
      } else {
        stopWebcamStream();
      }
    } catch (error) {
      toast.error(getTrpcError(error, 'Failed to update webcam state'));
    }
  }, [
    ownVoiceState.webcamEnabled,
    currentVoiceChannelId,
    startWebcamStream,
    stopWebcamStream
  ]);

  const toggleScreenShare = useCallback(async () => {
    const newState = !ownVoiceState.sharingScreen;
    const trpc = getTRPCClient();

    if (newState) {
      // macOS Electron: prompt to install audio driver if not yet active
      if (window.pulseDesktop?.platform === 'darwin' && window.pulseDesktop?.audioDriver) {
        try {
          const status = await window.pulseDesktop.audioDriver.getStatus();
          if (status.supported && !status.active) {
            const shouldInstall = confirm(
              'To share system audio on macOS, Pulse needs to install a virtual audio driver.\n\n' +
              'This requires administrator privileges. You can also share without audio.\n\n' +
              'Install the audio driver now?'
            );
            if (shouldInstall) {
              const result = await window.pulseDesktop.audioDriver.install();
              if (result.success) {
                toast.success('Audio driver installed successfully');
              } else if (result.error && !result.error.includes('cancelled')) {
                toast.error(`Driver install failed: ${result.error}`);
              }
            }
          }
        } catch {
          // Non-critical — continue with screen share regardless
        }
      }

      // getDisplayMedia must be called synchronously from the user gesture,
      // before any awaits, or the browser will reject it.
      try {
        const video = await startScreenShareStream();

        updateOwnVoiceState({ sharingScreen: true });
        playSound(SoundType.OWN_USER_STARTED_SCREENSHARE);

        await trpc.voice.updateState.mutate({
          sharingScreen: true
        });

        // handle native screen share end
        video.onended = async () => {
          stopScreenShareStream();
          updateOwnVoiceState({ sharingScreen: false });

          await trpc.voice.updateState.mutate({
            sharingScreen: false
          });
        };
      } catch (error) {
        toast.error(getTrpcError(error, 'Failed to start screen share'));
      }
    } else {
      updateOwnVoiceState({ sharingScreen: false });
      playSound(SoundType.OWN_USER_STOPPED_SCREENSHARE);

      try {
        stopScreenShareStream();
        await trpc.voice.updateState.mutate({
          sharingScreen: false
        });
      } catch (error) {
        toast.error(getTrpcError(error, 'Failed to update screen share state'));
      }
    }
  }, [
    ownVoiceState.sharingScreen,
    startScreenShareStream,
    stopScreenShareStream
  ]);

  return {
    toggleMic,
    toggleSound,
    toggleWebcam,
    toggleScreenShare,
    ownVoiceState
  };
};

export { useVoiceControls };
