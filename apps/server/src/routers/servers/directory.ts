import {
  DIRECTORY_GAME_MAX_LENGTH,
  DIRECTORY_SEARCH_MAX_LENGTH
} from '@pulse/shared';
import { z } from 'zod';
import {
  DIRECTORY_PAGE_MAX,
  DIRECTORY_SCAN_MAX,
  listDirectory,
  listDirectoryGames
} from '../../db/queries/directory';
import { protectedProcedure } from '../../utils/trpc';

// The Directory page: this instance's listed servers and the cached
// listings of its peers, searched/filtered/sorted server-side. No
// active server is needed — like servers.discover, it is reached from
// the Discover tab by members and fresh registrants alike.
const directoryRoute = protectedProcedure
  .input(
    z
      .object({
        search: z.string().trim().max(DIRECTORY_SEARCH_MAX_LENGTH).optional(),
        game: z.string().trim().max(DIRECTORY_GAME_MAX_LENGTH).optional(),
        sort: z.enum(['online', 'members', 'name']).default('online'),
        limit: z.number().int().min(1).max(DIRECTORY_PAGE_MAX).default(30),
        offset: z.number().int().min(0).max(DIRECTORY_SCAN_MAX).default(0)
      })
      .refine((v) => v.offset + v.limit <= DIRECTORY_SCAN_MAX, {
        message: `offset + limit must not exceed ${DIRECTORY_SCAN_MAX}`
      })
  )
  .query(async ({ ctx, input }) =>
    listDirectory({
      userId: ctx.userId,
      search: input.search || undefined,
      game: input.game || undefined,
      sort: input.sort,
      limit: input.limit,
      offset: input.offset
    })
  );

const directoryGamesRoute = protectedProcedure.query(async () =>
  listDirectoryGames()
);

export { directoryGamesRoute, directoryRoute };
