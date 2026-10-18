import type { IRootState } from '@/features/store';
import { createSelector } from '@reduxjs/toolkit';
import { createCachedSelector } from 're-reselect';
import { findExternalStream } from './external-streams';
import {
  channelIdFromVoiceKey,
  isChannelVoiceKey,
  voiceMapKey,
  type TVoiceKind
} from './keys';

const DEFAULT_OBJECT = {};

export const voiceMapSelector = (state: IRootState) => state.server.voiceMap;

const channelsSelector = (state: IRootState) => state.server.channels;

/**
 * "Are there any voice users in the *active server's* channels?"
 *
 * USER_JOIN_VOICE reaches every member of the hosting server whichever
 * server they are viewing, so the roster also holds channels of other
 * servers the user belongs to; only the active server's channels may
 * light its rail icon.
 */
export const hasAnyVoiceUsersSelector = createSelector(
  [voiceMapSelector, channelsSelector],
  (voiceMap, channels) => {
    const serverChannelIds = new Set(channels.map((c) => c.id));
    for (const [key, ch] of Object.entries(voiceMap)) {
      if (!ch || !isChannelVoiceKey(key)) continue;
      if (!serverChannelIds.has(channelIdFromVoiceKey(key))) continue;
      if (Object.keys(ch.users).length > 0) return true;
    }
    return false;
  }
);

export const ownVoiceStateSelector = (state: IRootState) => {
  return state.server.ownVoiceState;
};

export const pinnedCardSelector = (state: IRootState) =>
  state.server.pinnedCard;

export const voiceChannelStateSelector = (
  state: IRootState,
  channelId: number,
  kind: TVoiceKind
) => state.server.voiceMap[voiceMapKey(kind, channelId)];

export const voiceSessionStartedAtSelector = (
  state: IRootState,
  channelId: number,
  kind: TVoiceKind
) => state.server.voiceMap[voiceMapKey(kind, channelId)]?.startedAt;

export const voiceChannelExternalStreamsSelector = (
  state: IRootState,
  channelId: number
) => state.server.externalStreamsMap[channelId];

const externalStreamsMapSelector = (state: IRootState) =>
  state.server.externalStreamsMap;

export const externalStreamByIdSelector = createCachedSelector(
  [externalStreamsMapSelector, (_: IRootState, streamId: number) => streamId],
  findExternalStream
)((_: IRootState, streamId: number) => streamId);

export const voiceChannelExternalStreamsListSelector = createCachedSelector(
  voiceChannelExternalStreamsSelector,
  (externalStreamsMap) => {
    return Object.entries(externalStreamsMap || DEFAULT_OBJECT).map(
      ([streamId, stream]) => ({
        streamId: Number(streamId),
        ...stream
      })
    );
  }
)((_state: IRootState, channelId: number) => channelId);

export const voiceChannelAudioExternalStreamsSelector = createCachedSelector(
  voiceChannelExternalStreamsListSelector,
  (externalStreams) =>
    externalStreams.filter((stream) => stream.tracks?.audio === true)
)((_state: IRootState, channelId: number) => channelId);
