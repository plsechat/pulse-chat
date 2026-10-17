import { Permission } from '@pulse/shared';
import { z } from 'zod';
import {
  eventRolesSchema,
  templateNameSchema,
  updateRosterTemplate
} from '../../db/queries/events';
import { serverProcedure } from '../../utils/procedures';

const updateTemplateRoute = serverProcedure(Permission.MANAGE_EVENTS)
  .input(
    z.object({
      templateId: z.number().int().positive(),
      name: templateNameSchema.optional(),
      roles: eventRolesSchema.optional()
    })
  )
  .mutation(({ ctx, input }) =>
    updateRosterTemplate(ctx.activeServerId, input.templateId, {
      name: input.name,
      roles: input.roles
    })
  );

export { updateTemplateRoute };
