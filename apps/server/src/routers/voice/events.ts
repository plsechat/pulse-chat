import { ServerEvents, type StreamKind } from '@pulse/shared';
import { observable } from '@trpc/server/observable';
import { protectedProcedure, userSubscription } from '../../utils/trpc';

type TVoiceProducerEvent = {
  channelId: number;
  remoteId: number;
  kind: StreamKind;
};

// User-scoped voice events (delivered to server members):
const onUserJoinVoiceRoute = userSubscription(ServerEvents.USER_JOIN_VOICE);
const onUserLeaveVoiceRoute = userSubscription(ServerEvents.USER_LEAVE_VOICE);
const onUserUpdateVoiceStateRoute = userSubscription(
  ServerEvents.USER_VOICE_STATE_UPDATE
);
const onVoiceAddExternalStreamRoute = userSubscription(
  ServerEvents.VOICE_ADD_EXTERNAL_STREAM
);
const onVoiceUpdateExternalStreamRoute = userSubscription(
  ServerEvents.VOICE_UPDATE_EXTERNAL_STREAM
);
const onVoiceRemoveExternalStreamRoute = userSubscription(
  ServerEvents.VOICE_REMOVE_EXTERNAL_STREAM
);

// these events are channel-scoped (only sent to users in the same voice channel)
// they relate to actual media streaming, not UI state
const onVoiceNewProducerRoute = protectedProcedure.subscription(
  async ({ ctx }) => {
    if (!ctx.currentVoiceChannelId) {
      return observable<TVoiceProducerEvent>(() => () => {});
    }

    return ctx.pubsub.subscribeForChannel(
      ctx.currentVoiceChannelId,
      ServerEvents.VOICE_NEW_PRODUCER
    );
  }
);

const onVoiceProducerClosedRoute = protectedProcedure.subscription(
  async ({ ctx }) => {
    if (!ctx.currentVoiceChannelId) {
      return observable<TVoiceProducerEvent>(() => () => {});
    }

    return ctx.pubsub.subscribeForChannel(
      ctx.currentVoiceChannelId,
      ServerEvents.VOICE_PRODUCER_CLOSED
    );
  }
);

export {
  onUserJoinVoiceRoute,
  onUserLeaveVoiceRoute,
  onUserUpdateVoiceStateRoute,
  onVoiceAddExternalStreamRoute,
  onVoiceNewProducerRoute,
  onVoiceProducerClosedRoute,
  onVoiceRemoveExternalStreamRoute,
  onVoiceUpdateExternalStreamRoute
};
