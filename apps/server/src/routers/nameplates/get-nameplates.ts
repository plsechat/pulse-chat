import { getNameplates } from '../../db/queries/nameplates';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

// Any member can list the active server's packs — the roster needs them
// to resolve co-members' equipped 'custom:<id>' nameplates.
const getNameplatesRoute = protectedProcedure.query(async ({ ctx }) => {
  invariant(ctx.activeServerId, {
    code: 'BAD_REQUEST',
    message: 'No active server'
  });

  const nameplates = await getNameplates(ctx.activeServerId);

  return nameplates;
});

export { getNameplatesRoute };
