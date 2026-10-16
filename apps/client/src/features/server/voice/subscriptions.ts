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
import { readVoiceKind } from './keys';

const subscribeToVoice = () => {
  const trpc = getTRPCClient();
  if (!trpc) return () => {};

  // Roster events carry `kind` next to the numeric channelId: a DM call
  // and a server channel can share an id, and only the kind says which
  // roster the user belongs to.
  return combineUnsubscribes(
    subscribe('onUserJoinVoice', trpc.voice.onJoin, (event) =>
      addUserToVoiceChannel(
        event.userId,
        event.channelId,
        readVoiceKind(event),
        event.state,
        event.startedAt
      )
    ),
    subscribe('onUserLeaveVoice', trpc.voice.onLeave, (event) =>
      removeUserFromVoiceChannel(
        event.userId,
        event.channelId,
        readVoiceKind(event),
        event.startedAt
      )
    ),
    subscribe('onUserUpdateVoice', trpc.voice.onUpdateState, (event) =>
      updateVoiceUserState(
        event.userId,
        event.channelId,
        readVoiceKind(event),
        event.state
      )
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
