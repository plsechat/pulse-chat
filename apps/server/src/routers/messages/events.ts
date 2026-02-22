import { ServerEvents } from '@pulse/shared';
import { protectedProcedure } from '../../utils/trpc';

const onMessageDeleteRoute = protectedProcedure.subscription(
  async ({ ctx }) => {
    return ctx.pubsub.subscribe(ServerEvents.MESSAGE_DELETE);
  }
);

const onMessageBulkDeleteRoute = protectedProcedure.subscription(
  async ({ ctx }) => {
    return ctx.pubsub.subscribe(ServerEvents.MESSAGE_BULK_DELETE);
  }
);

const onMessageUpdateRoute = protectedProcedure.subscription(
  async ({ ctx }) => {
    return ctx.pubsub.subscribeFor(ctx.userId, ServerEvents.MESSAGE_UPDATE);
  }
);

const onMessageRoute = protectedProcedure.subscription(async ({ ctx }) => {
  return ctx.pubsub.subscribeFor(ctx.userId, ServerEvents.NEW_MESSAGE);
});

const onMessageTypingRoute = protectedProcedure.subscription(
  async ({ ctx }) => {
    return ctx.pubsub.subscribe(ServerEvents.MESSAGE_TYPING);
  }
);

const onMessagePinRoute = protectedProcedure.subscription(
  async ({ ctx }) => {
    return ctx.pubsub.subscribeFor(ctx.userId, ServerEvents.MESSAGE_PIN);
  }
);

const onMessageUnpinRoute = protectedProcedure.subscription(
  async ({ ctx }) => {
    return ctx.pubsub.subscribeFor(ctx.userId, ServerEvents.MESSAGE_UNPIN);
  }
);

export {
  onMessageBulkDeleteRoute,
  onMessageDeleteRoute,
  onMessagePinRoute,
  onMessageRoute,
  onMessageTypingRoute,
  onMessageUnpinRoute,
  onMessageUpdateRoute
};
