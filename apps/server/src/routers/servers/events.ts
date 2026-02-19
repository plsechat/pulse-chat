import { ServerEvents } from '@pulse/shared';
import { protectedProcedure } from '../../utils/trpc';

const onMemberJoinRoute = protectedProcedure.subscription(({ ctx }) => {
  return ctx.pubsub.subscribeFor(ctx.userId, ServerEvents.SERVER_MEMBER_JOIN);
});

const onMemberLeaveRoute = protectedProcedure.subscription(({ ctx }) => {
  return ctx.pubsub.subscribeFor(ctx.userId, ServerEvents.SERVER_MEMBER_LEAVE);
});

const onUnreadCountUpdateRoute = protectedProcedure.subscription(({ ctx }) => {
  return ctx.pubsub.subscribeFor(
    ctx.userId,
    ServerEvents.SERVER_UNREAD_COUNT_UPDATE
  );
});

export { onMemberJoinRoute, onMemberLeaveRoute, onUnreadCountUpdateRoute };
