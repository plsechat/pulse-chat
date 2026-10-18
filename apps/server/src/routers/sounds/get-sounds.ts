import { getServerSounds } from '../../db/queries/sounds';
import { serverProcedure } from '../../utils/procedures';

/** Every member of the active server may read its soundboard (playing is gated separately). */
const getSoundsRoute = serverProcedure().query(({ ctx }) =>
  getServerSounds(ctx.activeServerId)
);

export { getSoundsRoute };
