import { ServerEvents } from '@pulse/shared';
import { protectedProcedure } from '../../utils/trpc';

const onThreadCreateRoute = protectedProcedure.subscription(
  async ({ ctx }) => {
    return ctx.pubsub.subscribe(ServerEvents.THREAD_CREATE);
  }
);

const onThreadUpdateRoute = protectedProcedure.subscription(
  async ({ ctx }) => {
    return ctx.pubsub.subscribe(ServerEvents.THREAD_UPDATE);
  }
);

const onThreadDeleteRoute = protectedProcedure.subscription(
  async ({ ctx }) => {
    return ctx.pubsub.subscribe(ServerEvents.THREAD_DELETE);
  }
);

export { onThreadCreateRoute, onThreadDeleteRoute, onThreadUpdateRoute };
