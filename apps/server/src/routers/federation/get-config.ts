import { getFederationConfig } from '../../utils/federation';
import { protectedProcedure } from '../../utils/trpc';
import { assertInstanceOwner } from './guard';

const getConfigRoute = protectedProcedure.query(async ({ ctx }) => {
  await assertInstanceOwner(ctx.userId);

  return getFederationConfig();
});

export { getConfigRoute };
