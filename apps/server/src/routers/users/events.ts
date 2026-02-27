import { ServerEvents } from '@pulse/shared';
import { protectedProcedure } from '../../utils/trpc';

const onUserJoinRoute = protectedProcedure.subscription(async ({ ctx }) => {
  return ctx.pubsub.subscribeFor(ctx.userId, ServerEvents.USER_JOIN);
});

const onUserLeaveRoute = protectedProcedure.subscription(async ({ ctx }) => {
  return ctx.pubsub.subscribeFor(ctx.userId, ServerEvents.USER_LEAVE);
});

const onUserUpdateRoute = protectedProcedure.subscription(async ({ ctx }) => {
  return ctx.pubsub.subscribeFor(ctx.userId, ServerEvents.USER_UPDATE);
});

const onUserCreateRoute = protectedProcedure.subscription(async ({ ctx }) => {
  return ctx.pubsub.subscribeFor(ctx.userId, ServerEvents.USER_CREATE);
});

const onUserDeleteRoute = protectedProcedure.subscription(async ({ ctx }) => {
  return ctx.pubsub.subscribeFor(ctx.userId, ServerEvents.USER_DELETE);
});

const onUserKickedRoute = protectedProcedure.subscription(async ({ ctx }) => {
  return ctx.pubsub.subscribeFor(ctx.userId, ServerEvents.USER_KICKED);
});

export {
  onUserCreateRoute,
  onUserDeleteRoute,
  onUserJoinRoute,
  onUserKickedRoute,
  onUserLeaveRoute,
  onUserUpdateRoute
};
