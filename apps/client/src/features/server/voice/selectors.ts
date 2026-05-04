import type { IRootState } from '@/features/store';
import { createSelector } from '@reduxjs/toolkit';
import { createCachedSelector } from 're-reselect';

const DEFAULT_OBJECT = {};

export const voiceMapSelector = (state: IRootState) => state.server.voiceMap;

const channelsSelector = (state: IRootState) => state.server.channels;

/**
 * "Are there any voice users in the *active server's* channels?"
 *
 * voiceMap is shared between server voice channels and DM call
 * channels — addUserToVoiceChannel from dms/subscriptions writes to
 * the same map. Walking the whole map without scoping caused DM
 * voice activity to make the active server's icon light up with
 * the call indicator. Filter to channel ids that actually belong
 * to the active server.
 */
export const hasAnyVoiceUsersSelector = createSelector(
  [voiceMapSelector, channelsSelector],
  (voiceMap, channels) => {
    const serverChannelIds = new Set(channels.map((c) => c.id));
    for (const [id, ch] of Object.entries(voiceMap)) {
      if (!ch) continue;
      if (!serverChannelIds.has(Number(id))) continue;
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
  channelId: number
) => state.server.voiceMap[channelId];

export const voiceChannelExternalStreamsSelector = (
  state: IRootState,
  channelId: number
) => state.server.externalStreamsMap[channelId];

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

export const voiceChannelVideoExternalStreamsSelector = createCachedSelector(
  voiceChannelExternalStreamsListSelector,
  (externalStreams) =>
    externalStreams.filter((stream) => stream.tracks?.video === true)
)((_state: IRootState, channelId: number) => channelId);
