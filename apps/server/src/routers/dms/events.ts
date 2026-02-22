import { ServerEvents } from '@pulse/shared';
import { protectedProcedure } from '../../utils/trpc';

const onDmNewMessageRoute = protectedProcedure.subscription(
  async ({ ctx }) => {
    return ctx.pubsub.subscribeFor(ctx.userId, ServerEvents.DM_NEW_MESSAGE);
  }
);

const onDmMessageUpdateRoute = protectedProcedure.subscription(
  async ({ ctx }) => {
    return ctx.pubsub.subscribeFor(ctx.userId, ServerEvents.DM_MESSAGE_UPDATE);
  }
);

const onDmMessageDeleteRoute = protectedProcedure.subscription(
  async ({ ctx }) => {
    return ctx.pubsub.subscribeFor(ctx.userId, ServerEvents.DM_MESSAGE_DELETE);
  }
);

const onDmCallStartedRoute = protectedProcedure.subscription(
  async ({ ctx }) => {
    return ctx.pubsub.subscribeFor(ctx.userId, ServerEvents.DM_CALL_STARTED);
  }
);

const onDmCallEndedRoute = protectedProcedure.subscription(
  async ({ ctx }) => {
    return ctx.pubsub.subscribeFor(ctx.userId, ServerEvents.DM_CALL_ENDED);
  }
);

const onDmCallUserJoinedRoute = protectedProcedure.subscription(
  async ({ ctx }) => {
    return ctx.pubsub.subscribeFor(
      ctx.userId,
      ServerEvents.DM_CALL_USER_JOINED
    );
  }
);

const onDmCallUserLeftRoute = protectedProcedure.subscription(
  async ({ ctx }) => {
    return ctx.pubsub.subscribeFor(ctx.userId, ServerEvents.DM_CALL_USER_LEFT);
  }
);

const onDmTypingRoute = protectedProcedure.subscription(async ({ ctx }) => {
  return ctx.pubsub.subscribeFor(ctx.userId, ServerEvents.DM_MESSAGE_TYPING);
});

const onDmChannelUpdateRoute = protectedProcedure.subscription(
  async ({ ctx }) => {
    return ctx.pubsub.subscribeFor(
      ctx.userId,
      ServerEvents.DM_CHANNEL_UPDATE
    );
  }
);

const onDmChannelDeleteRoute = protectedProcedure.subscription(
  async ({ ctx }) => {
    return ctx.pubsub.subscribeFor(
      ctx.userId,
      ServerEvents.DM_CHANNEL_DELETE
    );
  }
);

const onDmMemberAddRoute = protectedProcedure.subscription(
  async ({ ctx }) => {
    return ctx.pubsub.subscribeFor(ctx.userId, ServerEvents.DM_MEMBER_ADD);
  }
);

const onDmMemberRemoveRoute = protectedProcedure.subscription(
  async ({ ctx }) => {
    return ctx.pubsub.subscribeFor(ctx.userId, ServerEvents.DM_MEMBER_REMOVE);
  }
);

export {
  onDmCallEndedRoute,
  onDmCallStartedRoute,
  onDmCallUserJoinedRoute,
  onDmCallUserLeftRoute,
  onDmChannelDeleteRoute,
  onDmChannelUpdateRoute,
  onDmMemberAddRoute,
  onDmMemberRemoveRoute,
  onDmMessageDeleteRoute,
  onDmMessageUpdateRoute,
  onDmNewMessageRoute,
  onDmTypingRoute
};
