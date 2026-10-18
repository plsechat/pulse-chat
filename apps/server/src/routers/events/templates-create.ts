import { Permission } from '@pulse/shared';
import { z } from 'zod';
import {
  createRosterTemplate,
  eventRolesSchema,
  templateNameSchema
} from '../../db/queries/events';
import { eventsProcedure } from './_shared';

const createTemplateRoute = eventsProcedure(Permission.MANAGE_EVENTS)
  .input(z.object({ name: templateNameSchema, roles: eventRolesSchema }))
  .mutation(({ ctx, input }) =>
    createRosterTemplate(ctx.activeServerId, input.name, input.roles)
  );

export { createTemplateRoute };
