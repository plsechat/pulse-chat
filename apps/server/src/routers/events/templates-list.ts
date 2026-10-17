import { listRosterTemplates } from '../../db/queries/events';
import { serverProcedure } from '../../utils/procedures';

const listTemplatesRoute = serverProcedure().query(({ ctx }) =>
  listRosterTemplates(ctx.activeServerId)
);

export { listTemplatesRoute };
