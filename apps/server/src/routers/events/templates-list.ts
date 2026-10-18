import { listRosterTemplates } from '../../db/queries/events';
import { eventsProcedure } from './_shared';

const listTemplatesRoute = eventsProcedure().query(({ ctx }) =>
  listRosterTemplates(ctx.activeServerId)
);

export { listTemplatesRoute };
