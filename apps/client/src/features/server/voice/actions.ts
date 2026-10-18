import type { TPinnedCard } from '@/components/channel-view/voice/hooks/use-pin-card-controller';
import { leaveDmVoiceCall } from '@/features/dms/actions';
import { dmsSliceActions } from '@/features/dms/slice';
import { store, type IRootState } from '@/features/store';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { connectionManager } from '@/lib/connection-manager';
import { getHomeTRPCClient, getVoiceTRPCClient } from '@/lib/trpc';
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
  currentVoiceKindSelector,
  selectedChannelIdSelector
} from '../channels/selectors';
import { serverSliceActions } from '../slice';
import { playSound } from '../sounds/actions';
import { SoundType } from '../types';
import {
  homeOwnUserIdSelector,
  ownUserIdSelector,
  userByIdSelector
} from '../users/selectors';
import { voiceMapKey, type TVoiceKind } from './keys';
import { ownVoiceStateSelector } from './selectors';

/**
 * DM calls live in `voiceMap` next to server voice channels, but their
 * participant ids are HOME ids while a server channel's are ambient
 * (remote shadow ids on a federated server). Pick the id the event's
 * ids are expressed in, or our own join/leave is misread as a peer's.
 */
const ownIdForVoiceKind = (state: IRootState, kind: TVoiceKind) =>
  kind === 'dm' ? homeOwnUserIdSelector(state) : ownUserIdSelector(state);

/** Whether an event's session is the one this client is in. */
const isOwnVoiceSession = (
  state: IRootState,
  channelId: number,
  kind: TVoiceKind
) =>
  currentVoiceChannelIdSelector(state) === channelId &&
  currentVoiceKindSelector(state) === kind;

/**
 * Forget the local voice session of either kind: the server-slice
 * session fields (which also drop the per-session flags and let the
 * provider tear down its transports) and the DM "in call" marker. Used
 * by every involuntary end — a server-side removal, the call's channel
 * disappearing — so no path can leave one half set.
 */
export const endOwnVoiceSession = (): void => {
  setCurrentVoiceChannelId(undefined);
  setCurrentVoiceServerId(undefined);
  setPinnedCard(undefined);
  if (store.getState().dms.ownDmCallChannelId !== undefined) {
    store.dispatch(dmsSliceActions.setOwnDmCallChannelId(undefined));
  }
};

export const addUserToVoiceChannel = (
  userId: number,
  channelId: number,
  kind: TVoiceKind,
  voiceState: TVoiceUserState,
  startedAt?: number
): void => {
  const state = store.getState();
  const ownUserId = ownIdForVoiceKind(state, kind);

  store.dispatch(
    serverSliceActions.addUserToVoiceChannel({
      userId,
      channelId,
      kind,
      state: voiceState,
      startedAt
    })
  );

  if (userId !== ownUserId && isOwnVoiceSession(state, channelId, kind)) {
    playSound(SoundType.REMOTE_USER_JOINED_VOICE_CHANNEL);
  }
};

export const removeUserFromVoiceChannel = (
  userId: number,
  channelId: number,
  kind: TVoiceKind,
  startedAt?: number
): void => {
  const state = store.getState();
  const ownUserId = ownIdForVoiceKind(state, kind);
  const inThisSession = isOwnVoiceSession(state, channelId, kind);

  store.dispatch(
    serverSliceActions.removeUserFromVoiceChannel({
      userId,
      channelId,
      kind,
      startedAt
    })
  );

  if (userId !== ownUserId && inThisSession) {
    playSound(SoundType.REMOTE_USER_LEFT_VOICE_CHANNEL);
  }

  // Server-initiated removal of THIS client (moderator disconnect,
  // orphan sweep, the call's channel deleted): tear down the local
  // session. A voluntary leave never reaches here with a matching
  // session — leaveVoice / leaveDmVoiceCall clear Redux before their
  // mutate, so the session is already gone by the time our own
  // USER_LEAVE_VOICE event arrives.
  if (userId === ownUserId && inThisSession) {
    endOwnVoiceSession();
    playSound(SoundType.OWN_USER_LEFT_VOICE_CHANNEL);
    toast.info(
      kind === 'dm'
        ? 'You were disconnected from the call'
        : 'You were disconnected from the voice channel'
    );
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
  kind: TVoiceKind,
  newState: Partial<TVoiceUserState>
): void => {
  const state = store.getState();
  const prevVoiceState =
    state.server.voiceMap[voiceMapKey(kind, channelId)]?.users[userId];
  const ownUserId = ownIdForVoiceKind(state, kind);

  store.dispatch(
    serverSliceActions.updateVoiceUserState({
      userId,
      channelId,
      kind,
      newState
    })
  );

  // Moderation flags on OUR OWN state must mirror into ownVoiceState —
  // voiceMap only feeds rosters/tiles, while the mic/deafen guards (and
  // their "muted by a moderator" refusals) read ownVoiceState. Without
  // the mirror the target never learns it was server-muted and the mic
  // button runs split-brain against the SFU.
  if (userId === ownUserId) {
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
  // DM calls — both live in voiceMap under their kind-qualified key.
  if (
    newState.sharingScreen === true &&
    prevVoiceState &&
    !prevVoiceState.sharingScreen &&
    userId !== ownUserId &&
    isOwnVoiceSession(state, channelId, kind)
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
export const leaveCurrentVoice = async (
  options?: LeaveVoiceOptions
): Promise<void> => {
  const state = store.getState();
  const inDmCall =
    state.dms.ownDmCallChannelId !== undefined ||
    currentVoiceKindSelector(state) === 'dm';

  if (inDmCall) {
    await leaveDmVoiceCall();
  } else {
    await leaveVoice(options);
  }
};

export const setVoiceInstanceDomain = (
  instanceDomain: string | undefined
): void => {
  store.dispatch(serverSliceActions.setVoiceInstanceDomain(instanceDomain));
};

export type JoinVoiceOptions = {
  /** Instance to join on (null = home). Defaults to the instance in
   *  focus — the one whose channel the user clicked. The reconnect rejoin
   *  passes the session's pinned instance instead, since the user may be
   *  browsing a different one by the time the socket is back. */
  instanceDomain?: string | null;
  /** The hosting server, when the join is a restore of a known session
   *  rather than a click on the connected server's channel. */
  server?: { id: number; publicId: string | undefined };
};

export const joinVoice = async (
  channelId: number,
  options?: JoinVoiceOptions
): Promise<RtpCapabilities | undefined> => {
  const state = store.getState();
  const currentChannelId = currentVoiceChannelIdSelector(state);

  if (channelId === currentChannelId) {
    // already in the desired channel
    return undefined;
  }

  if (currentChannelId) {
    // Already in a voice channel (server or DM) — leave it first. This
    // is a hop, not a hang-up: only the join cue should play, so the
    // leave is silent (the provider plays the join sound once the new
    // session is up). A DM leave rejects when the home client is gone;
    // keep this function's contract (undefined + toast) for that case.
    try {
      await leaveCurrentVoice({ silent: true });
    } catch (error) {
      toast.error(getTrpcError(error, 'Failed to leave the current call'));
      return undefined;
    }
  }

  const { micMuted, soundMuted } = ownVoiceStateSelector(state);
  // The instance this session will live on. Resolved explicitly rather
  // than through getTRPCClient so the same client that confirmed the
  // join is the one the pin names — nothing in between can re-route it.
  const instanceDomain =
    options?.instanceDomain === undefined
      ? store.getState().app.activeInstanceDomain
      : options.instanceDomain;
  const client = instanceDomain
    ? connectionManager.getRemoteTRPCClient(instanceDomain)
    : getHomeTRPCClient();
  if (!client) return undefined;

  try {
    const { routerRtpCapabilities } = await client.voice.join.mutate({
      channelId,
      state: { micMuted, soundMuted }
    });

    // Pin the session to its hosting instance BEFORE the channel id is
    // set: the voice subscriptions key on currentVoiceChannelId and must
    // resolve the hosting instance's client on their first run.
    setVoiceInstanceDomain(instanceDomain ?? undefined);

    // Set channel/server ID AFTER the server confirms the join so that
    // ctx.currentVoiceChannelId is already set when the useVoiceEvents
    // subscription handler runs on the server.
    setCurrentVoiceChannelId(channelId);
    setCurrentVoiceServerId(
      options?.server ?? store.getState().app.activeServerId
    );

    return routerRtpCapabilities;
  } catch (error) {
    toast.error(getTrpcError(error, 'Failed to join voice channel'));
  }

  return undefined;
};

export type LeaveVoiceOptions = {
  /** Skip the "left voice" cue — set when the leave is the first half
   *  of a hop to another channel, where only the join cue should play. */
  silent?: boolean;
};

export const leaveVoice = async (
  options?: LeaveVoiceOptions
): Promise<void> => {
  const state = store.getState();
  const currentChannelId = currentVoiceChannelIdSelector(state);
  const selectedChannelId = selectedChannelIdSelector(state);

  if (!currentChannelId) {
    return;
  }

  if (selectedChannelId === currentChannelId) {
    setSelectedChannelId(undefined);
  }

  // Resolve the hosting instance's client BEFORE clearing: the instance
  // pin is dropped together with the session, and the leave must reach
  // the server that has the session — not whichever one is in focus.
  const client = getVoiceTRPCClient();

  setCurrentVoiceChannelId(undefined);
  setCurrentVoiceServerId(undefined);
  setPinnedCard(undefined);

  if (!client) return;

  try {
    await client.voice.leave.mutate();
    if (!options?.silent) {
      playSound(SoundType.OWN_USER_LEFT_VOICE_CHANNEL);
    }
  } catch (error) {
    toast.error(getTrpcError(error, 'Failed to leave voice channel'));
  }
};

export const setPinnedCard = (pinnedCard: TPinnedCard | undefined): void => {
  store.dispatch(serverSliceActions.setPinnedCard(pinnedCard));
};
