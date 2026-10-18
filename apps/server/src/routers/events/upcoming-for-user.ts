import { z } from 'zod';
import { listUpcomingEventsForUser } from '../../db/queries/events';
import { protectedProcedure } from '../../utils/trpc';

/**
 * The Home overview's "Upcoming events": the next scheduled events
 * across every community the caller is a member of on this instance,
 * soonest first. No active server is needed — Home has none.
 *
 * Scope: membership is a `server_members` row here, so a community the
 * caller joined on a federated peer is NOT included (its events belong
 * to that peer and are listed when its tab is open). The window and the
 * row count are capped: a week and ten rows at most.
 */

const HOUR_MS = 60 * 60 * 1000;
const MAX_WITHIN_HOURS = 168;
const MAX_LIMIT = 10;

const upcomingForUserRoute = protectedProcedure
  .input(
    z
      .object({
        withinHours: z.number().int().min(1).max(MAX_WITHIN_HOURS).optional(),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional()
      })
      .optional()
  )
  .query(({ ctx, input }) =>
    listUpcomingEventsForUser(
      ctx.userId,
      Date.now(),
      (input?.withinHours ?? MAX_WITHIN_HOURS) * HOUR_MS,
      input?.limit ?? 5
    )
  );

export { upcomingForUserRoute };
