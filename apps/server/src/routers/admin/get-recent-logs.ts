import { z } from 'zod';
import { getRecentLogs } from '../../logger';
import { instanceOwnerProcedure } from '../../utils/procedures';

/**
 * Tail of the in-memory log ring (what the console already prints,
 * ANSI-stripped, capped at 1000 entries). Log FILES never leave the
 * box — an operator who needs history uses the on-disk logs.
 */
const getRecentLogsRoute = instanceOwnerProcedure
  .input(
    z.object({
      level: z.enum(['error', 'warn', 'info', 'debug']).optional(),
      limit: z.number().int().min(1).max(1000).default(200)
    })
  )
  .query(({ input }) => {
    const all = getRecentLogs();
    const filtered =
      input.level !== undefined
        ? all.filter((l) => l.level === input.level)
        : all;
    return { logs: filtered.slice(-input.limit) };
  });

export { getRecentLogsRoute };
