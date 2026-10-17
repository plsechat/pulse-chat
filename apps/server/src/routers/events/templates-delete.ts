import { Permission } from '@pulse/shared';
import { z } from 'zod';
import { deleteRosterTemplate } from '../../db/queries/events';
import { serverProcedure } from '../../utils/procedures';

const deleteTemplateRoute = serverProcedure(Permission.MANAGE_EVENTS)
  .input(z.object({ templateId: z.number().int().positive() }))
  .mutation(({ ctx, input }) =>
    deleteRosterTemplate(ctx.activeServerId, input.templateId)
  );

export { deleteTemplateRoute };
