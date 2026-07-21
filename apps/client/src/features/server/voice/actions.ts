import type { TPinnedCard } from '@/components/channel-view/voice/hooks/use-pin-card-controller';
import { leaveDmVoiceCall } from '@/features/dms/actions';
import { store } from '@/features/store';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { getTRPCClient } from '@/lib/trpc';
import { type TExternalStream, type TVoiceUserState } from '@pulse/shared';
import type { RtpCapabilities } from 'mediasoup-client/types';
import { toast } from 'sonner';
import {
  setCurrentVoiceChannelId,
  setCurrentVoiceServerId,
  setSelectedChannelId
} from '../channels/actions';
import {
  currentVoiceChannelIdSelector,
  selectedChannelIdSelector
} from '../channels/selectors';
import { serverSliceActions } from '../slice';
import { playSound } from '../sounds/actions';
import { SoundType } from '../types';
import { ownUserIdSelector, userByIdSelector } from '../users/selectors';
import { ownVoiceStateSelector } from './selectors';

export const addUserToVoiceChannel = (
  userId: number,
  channelId: number,
  voiceState: TVoiceUserState,
  startedAt?: number
): void => {
  const state = store.getState();
  const ownUserId = ownUserIdSelector(state);
  const currentChannelId = currentVoiceChannelIdSelector(state);

  store.dispatch(
    serverSliceActions.addUserToVoiceChannel({
      userId,
      channelId,
      state: voiceState,
      startedAt
    })
  );

  if (userId !== ownUserId && channelId === currentChannelId) {
    playSound(SoundType.REMOTE_USER_JOINED_VOICE_CHANNEL);
  }
};

export const removeUserFromVoiceChannel = (
  userId: number,
  channelId: number,
  startedAt?: number
): void => {
  const state = store.getState();
  const ownUserId = ownUserIdSelector(state);
  const currentChannelId = currentVoiceChannelIdSelector(state);

  store.dispatch(
    serverSliceActions.removeUserFromVoiceChannel({ userId, channelId, startedAt })
  );

  if (userId !== ownUserId && channelId === currentChannelId) {
    playSound(SoundType.REMOTE_USER_LEFT_VOICE_CHANNEL);
  }

  // Server-initiated removal of THIS client (moderator disconnect,
  // orphan sweep): tear down the local session. A voluntary leave never
  // reaches here with a matching channel — leaveVoice clears Redux
  // before its mutate, so currentChannelId is already undefined by the
  // time our own USER_LEAVE_VOICE event arrives.
  if (userId === ownUserId && channelId === currentChannelId) {
    setCurrentVoiceChannelId(undefined);
    setCurrentVoiceServerId(undefined);
    setPinnedCard(undefined);
    playSound(SoundType.OWN_USER_LEFT_VOICE_CHANNEL);
    toast.info('You were disconnected from the voice channel');
  }
};

export const addExternalStreamToVoiceChannel = (
  channelId: number,
  streamId: number,
  stream: TExternalStream
): void => {
  store.dispatch(
    serverSliceActions.addExternalStreamToChannel({
      channelId,
      streamId,
      stream
    })
  );
};

export const updateExternalStreamInVoiceChannel = (
  channelId: number,
  streamId: number,
  stream: TExternalStream
): void => {
  store.dispatch(
    serverSliceActions.updateExternalStreamInChannel({
      channelId,
      streamId,
      stream
    })
  );
};

export const removeExternalStreamFromVoiceChannel = (
  channelId: number,
  streamId: number
): void => {
  store.dispatch(
    serverSliceActions.removeExternalStreamFromChannel({
      channelId,
      streamId
    })
  );
};

export const updateVoiceUserState = (
  userId: number,
  channelId: number,
  newState: Partial<TVoiceUserState>
): void => {
  const state = store.getState();
  const prevVoiceState = state.server.voiceMap[channelId]?.users[userId];

  store.dispatch(
    serverSliceActions.updateVoiceUserState({ userId, channelId, newState })
  );

  // Moderation flags on OUR OWN state must mirror into ownVoiceState —
  // voiceMap only feeds rosters/tiles, while the mic/deafen guards (and
  // their "muted by a moderator" refusals) read ownVoiceState. Without
  // the mirror the target never learns it was server-muted and the mic
  // button runs split-brain against the SFU.
  if (userId === ownUserIdSelector(state)) {
    const mirror: Partial<TVoiceUserState> = {};
    if (newState.serverMuted !== undefined) {
      mirror.serverMuted = newState.serverMuted;
    }
    if (newState.serverDeafened !== undefined) {
      mirror.serverDeafened = newState.serverDeafened;
    }
    if (Object.keys(mirror).length > 0) {
      store.dispatch(serverSliceActions.updateOwnVoiceState(mirror));
      // Full-state republishes re-deliver the flags on every toggle —
      // toast only on actual transitions.
      if (mirror.serverMuted && !prevVoiceState?.serverMuted) {
        toast.warning('You have been muted by a moderator');
      } else if (mirror.serverMuted === false && prevVoiceState?.serverMuted) {
        toast.info('You have been unmuted by a moderator');
      }
      if (mirror.serverDeafened && !prevVoiceState?.serverDeafened) {
        toast.warning('You have been deafened by a moderator');
      } else if (
        mirror.serverDeafened === false &&
        prevVoiceState?.serverDeafened
      ) {
        toast.info('You have been undeafened by a moderator');
      }
    }
  }

  // The server publishes the user's FULL voice state on every toggle (e.g. a
  // mute while sharing re-delivers sharingScreen: true), so notify only on
  // the actual false→true transition. Covers both server voice channels and
  // DM calls — both live in voiceMap keyed by currentVoiceChannelId.
  if (
    newState.sharingScreen === true &&
    prevVoiceState &&
    !prevVoiceState.sharingScreen &&
    userId !== ownUserIdSelector(state) &&
    channelId === currentVoiceChannelIdSelector(state)
  ) {
    playSound(SoundType.REMOTE_USER_STARTED_SCREENSHARE);

    const sharer = userByIdSelector(state, userId);
    toast.info(
      `${sharer?.name ?? 'Someone'} started sharing their screen`
    );
  }
};

export const updateOwnVoiceState = (
  newState: Partial<TVoiceUserState>
): void => {
  store.dispatch(serverSliceActions.updateOwnVoiceState(newState));
};

/**
 * Leave whatever voice call the user is currently in (server or DM).
 * Call this before joining a new voice channel of any type.
 */
export const leaveCurrentVoice = async (): Promise<void> => {
  const state = store.getState();
  const ownDmCallChannelId = state.dms.ownDmCallChannelId;

  if (ownDmCallChannelId) {
    await leaveDmVoiceCall();
  } else {
    await leaveVoice();
  }
};

export const joinVoice = async (
  channelId: number
): Promise<RtpCapabilities | undefined> => {
  const state = store.getState();
  const currentChannelId = currentVoiceChannelIdSelector(state);

  if (channelId === currentChannelId) {
    // already in the desired channel
    return undefined;
  }

  if (currentChannelId) {
    // is already in a voice channel (server or DM), leave it first
    await leaveCurrentVoice();
  }

  const { micMuted, soundMuted } = ownVoiceStateSelector(state);
  const client = getTRPCClient();
  if (!client) return undefined;

  try {
    const { routerRtpCapabilities } = await client.voice.join.mutate({
      channelId,
      state: { micMuted, soundMuted }
    });

    // Set channel/server ID AFTER the server confirms the join so that
    // ctx.currentVoiceChannelId is already set when the useVoiceEvents
    // subscription handler runs on the server.
    setCurrentVoiceChannelId(channelId);
    setCurrentVoiceServerId(store.getState().app.activeServerId);

    return routerRtpCapabilities;
  } catch (error) {
    toast.error(getTrpcError(error, 'Failed to join voice channel'));
  }

  return undefined;
};

export const leaveVoice = async (): Promise<void> => {
  const state = store.getState();
  const currentChannelId = currentVoiceChannelIdSelector(state);
  const selectedChannelId = selectedChannelIdSelector(state);

  if (!currentChannelId) {
    return;
  }

  if (selectedChannelId === currentChannelId) {
    setSelectedChannelId(undefined);
  }

  setCurrentVoiceChannelId(undefined);
  setCurrentVoiceServerId(undefined);
  setPinnedCard(undefined);

  const client = getTRPCClient();
  if (!client) return;

  try {
    await client.voice.leave.mutate();
    playSound(SoundType.OWN_USER_LEFT_VOICE_CHANNEL);
  } catch (error) {
    toast.error(getTrpcError(error, 'Failed to leave voice channel'));
  }
};

export const setPinnedCard = (pinnedCard: TPinnedCard | undefined): void => {
  store.dispatch(serverSliceActions.setPinnedCard(pinnedCard));
};
