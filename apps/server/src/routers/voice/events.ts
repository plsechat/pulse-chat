import { ServerEvents, type StreamKind } from '@pulse/shared';
import { observable } from '@trpc/server/observable';
import { protectedProcedure } from '../../utils/trpc';

type TVoiceProducerEvent = {
  channelId: number;
  remoteId: number;
  kind: StreamKind;
};

// these events are scoped to server members
const onUserJoinVoiceRoute = protectedProcedure.subscription(
  async ({ ctx }) => {
    return ctx.pubsub.subscribeFor(ctx.userId, ServerEvents.USER_JOIN_VOICE);
  }
);

const onUserLeaveVoiceRoute = protectedProcedure.subscription(
  async ({ ctx }) => {
    return ctx.pubsub.subscribeFor(ctx.userId, ServerEvents.USER_LEAVE_VOICE);
  }
);

const onUserUpdateVoiceStateRoute = protectedProcedure.subscription(
  async ({ ctx }) => {
    return ctx.pubsub.subscribeFor(ctx.userId, ServerEvents.USER_VOICE_STATE_UPDATE);
  }
);

// these events are scoped to server members
const onVoiceAddExternalStreamRoute = protectedProcedure.subscription(
  async ({ ctx }) => {
    return ctx.pubsub.subscribeFor(ctx.userId, ServerEvents.VOICE_ADD_EXTERNAL_STREAM);
  }
);

const onVoiceUpdateExternalStreamRoute = protectedProcedure.subscription(
  async ({ ctx }) => {
    return ctx.pubsub.subscribeFor(ctx.userId, ServerEvents.VOICE_UPDATE_EXTERNAL_STREAM);
  }
);

const onVoiceRemoveExternalStreamRoute = protectedProcedure.subscription(
  async ({ ctx }) => {
    return ctx.pubsub.subscribeFor(ctx.userId, ServerEvents.VOICE_REMOVE_EXTERNAL_STREAM);
  }
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
