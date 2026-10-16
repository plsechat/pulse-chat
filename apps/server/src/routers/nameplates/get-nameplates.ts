import { getNameplates } from '../../db/queries/nameplates';
import { serverProcedure } from '../../utils/procedures';

// Any member can list the active server's packs — the roster needs them
// to resolve co-members' equipped 'custom:<id>' nameplates.
const getNameplatesRoute = serverProcedure().query(async ({ ctx }) => {
  const nameplates = await getNameplates(ctx.activeServerId);

  return nameplates;
});

export { getNameplatesRoute };
