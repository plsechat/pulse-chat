import { useCurrentVoiceChannelId } from '@/features/server/channels/hooks';
import { playSound } from '@/features/server/sounds/actions';
import { SoundType } from '@/features/server/types';
import { updateOwnVoiceState } from '@/features/server/voice/actions';
import { useOwnVoiceState } from '@/features/server/voice/hooks';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { getTRPCClient } from '@/lib/trpc';
import { useCallback } from 'react';
import { toast } from 'sonner';

type TUseVoiceControlsParams = {
  attachMicStream: () => Promise<void>;
  detachMicStream: () => Promise<void>;

  startWebcamStream: () => Promise<void>;
  stopWebcamStream: () => void;

  startScreenShareStream: () => Promise<MediaStreamTrack>;
  stopScreenShareStream: () => void | Promise<void>;
  changeScreenShareSource: () => Promise<MediaStreamTrack>;
};

const useVoiceControls = ({
  attachMicStream,
  detachMicStream,
  startWebcamStream,
  stopWebcamStream,
  startScreenShareStream,
  stopScreenShareStream,
  changeScreenShareSource
}: TUseVoiceControlsParams) => {
  const ownVoiceState = useOwnVoiceState();
  const currentVoiceChannelId = useCurrentVoiceChannelId();

  const toggleMic = useCallback(async () => {
    const newState = !ownVoiceState.micMuted;

    // A moderator server-mute can't be lifted by the user. Block the
    // unmute attempt locally (the server enforces it too) and tell them why.
    if (!newState && ownVoiceState.serverMuted) {
      toast.error('You have been muted by a moderator');
      return;
    }

    const trpc = getTRPCClient();
    if (!trpc) return;

    updateOwnVoiceState({ micMuted: newState });
    playSound(
      newState ? SoundType.OWN_USER_MUTED_MIC : SoundType.OWN_USER_UNMUTED_MIC
    );

    if (!currentVoiceChannelId) return;

    // Mute releases the microphone entirely; unmute re-acquires it with the
    // current device settings. This also recovers from a failed initial
    // acquisition (permission prompt dismissed at join, device unplugged).
    if (newState) {
      await detachMicStream();
    } else {
      await attachMicStream();
    }

    try {
      await trpc.voice.updateState.mutate({
        micMuted: newState
      });
    } catch (error) {
      toast.error(getTrpcError(error, 'Failed to update microphone state'));
    }
  }, [
    ownVoiceState.micMuted,
    ownVoiceState.serverMuted,
    attachMicStream,
    detachMicStream,
    currentVoiceChannelId
  ]);

  const toggleSound = useCallback(async () => {
    const newState = !ownVoiceState.soundMuted;

    // A moderator server-deafen can't be lifted by the user.
    if (!newState && ownVoiceState.serverDeafened) {
      toast.error('You have been deafened by a moderator');
      return;
    }

    const trpc = getTRPCClient();
    if (!trpc) return;

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
  }, [
    ownVoiceState.soundMuted,
    ownVoiceState.serverDeafened,
    currentVoiceChannelId
  ]);

  const toggleWebcam = useCallback(async () => {
    if (!currentVoiceChannelId) return;

    const newState = !ownVoiceState.webcamEnabled;
    const trpc = getTRPCClient();
    if (!trpc) return;

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
    if (!trpc) return;

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

  /**
   * Swap the screen-share source without a stop/start cycle. Cancelling
   * the OS picker is a silent no-op — the current share keeps running.
   */
  const changeScreenShare = useCallback(async () => {
    if (!ownVoiceState.sharingScreen) return;

    const trpc = getTRPCClient();
    if (!trpc) return;

    try {
      const video = await changeScreenShareSource();

      // replaceTrack does not carry onended over — rewire the browser's
      // native "Stop sharing" on the new track.
      video.onended = async () => {
        stopScreenShareStream();
        updateOwnVoiceState({ sharingScreen: false });

        await trpc.voice.updateState.mutate({
          sharingScreen: false
        });
      };
    } catch (error) {
      // A cancelled source picker rejects getDisplayMedia — keep sharing.
      if (
        error instanceof DOMException &&
        (error.name === 'NotAllowedError' || error.name === 'AbortError')
      ) {
        return;
      }

      toast.error(getTrpcError(error, 'Failed to change screen share source'));
    }
  }, [
    ownVoiceState.sharingScreen,
    changeScreenShareSource,
    stopScreenShareStream
  ]);

  return {
    toggleMic,
    toggleSound,
    toggleWebcam,
    toggleScreenShare,
    changeScreenShare,
    ownVoiceState
  };
};

export { useVoiceControls };
