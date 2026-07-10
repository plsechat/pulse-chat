import { ServerEvents } from '@pulse/shared';
import { protectedProcedure, userSubscription } from '../../utils/trpc';

const onFederationInstanceUpdateRoute = protectedProcedure.subscription(
  async ({ ctx }) => {
    return ctx.pubsub.subscribe(ServerEvents.FEDERATION_INSTANCE_UPDATE);
  }
);

// User-scoped (unlike the global instance-update stream): delivered on a
// user's home instance when a peer kicked/banned them from a remote server.
const onFederatedServerRemovedRoute = userSubscription(
  ServerEvents.FEDERATED_SERVER_REMOVED
);

export { onFederatedServerRemovedRoute, onFederationInstanceUpdateRoute };
