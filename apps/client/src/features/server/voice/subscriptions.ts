import { combineUnsubscribes, subscribe } from '@/lib/subscription-helpers';
import { getTRPCClient } from '@/lib/trpc';
import {
  addExternalStreamToVoiceChannel,
  addUserToVoiceChannel,
  removeExternalStreamFromVoiceChannel,
  removeUserFromVoiceChannel,
  updateExternalStreamInVoiceChannel,
  updateVoiceUserState
} from './actions';

const subscribeToVoice = () => {
  const trpc = getTRPCClient();
  if (!trpc) return () => {};

  return combineUnsubscribes(
    subscribe('onUserJoinVoice', trpc.voice.onJoin, ({ channelId, userId, state, startedAt }) =>
      addUserToVoiceChannel(userId, channelId, state, startedAt)
    ),
    subscribe('onUserLeaveVoice', trpc.voice.onLeave, ({ channelId, userId, startedAt }) =>
      removeUserFromVoiceChannel(userId, channelId, startedAt)
    ),
    subscribe('onUserUpdateVoice', trpc.voice.onUpdateState, ({ channelId, userId, state }) =>
      updateVoiceUserState(userId, channelId, state)
    ),
    subscribe(
      'onVoiceAddExternalStream',
      trpc.voice.onAddExternalStream,
      ({ channelId, streamId, stream }) =>
        addExternalStreamToVoiceChannel(channelId, streamId, stream)
    ),
    subscribe(
      'onVoiceUpdateExternalStream',
      trpc.voice.onUpdateExternalStream,
      ({ channelId, streamId, stream }) =>
        updateExternalStreamInVoiceChannel(channelId, streamId, stream)
    ),
    subscribe(
      'onVoiceRemoveExternalStream',
      trpc.voice.onRemoveExternalStream,
      ({ channelId, streamId }) =>
        removeExternalStreamFromVoiceChannel(channelId, streamId)
    )
  );
};

export { subscribeToVoice };
