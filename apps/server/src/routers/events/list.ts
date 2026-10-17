import { z } from 'zod';
import { listEvents } from '../../db/queries/events';
import { invariant } from '../../utils/invariant';
import { serverProcedure } from '../../utils/procedures';

/** Widest window one call may ask for: two months, so the month view fits with padding. */
const MAX_WINDOW_MS = 62 * 24 * 60 * 60 * 1000;

/** The current calendar month (UTC) when the caller passes no window. */
const defaultWindow = (now: number) => {
  const date = new Date(now);
  const from = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  const to = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) - 1;

  return { from, to };
};

const listEventsRoute = serverProcedure()
  .input(
    z
      .object({
        from: z.number().int().nonnegative().optional(),
        to: z.number().int().nonnegative().optional()
      })
      .optional()
  )
  .query(async ({ ctx, input }) => {
    const fallback = defaultWindow(Date.now());
    const from = input?.from ?? fallback.from;
    const to = input?.to ?? fallback.to;

    invariant(to >= from, 'The window ends before it starts');
    invariant(to - from <= MAX_WINDOW_MS, 'The window spans more than 62 days');

    return listEvents(ctx.activeServerId, from, to, ctx.userId);
  });

export { listEventsRoute };
