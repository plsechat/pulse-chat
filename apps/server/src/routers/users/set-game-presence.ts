import { z } from 'zod';
import {
  GAME_PRESENCE_MAX_NAME_LENGTH,
  getPresencePreferences,
  setGamePresence
} from '../../db/queries/game-presence';
import {
  announceGamePresence,
  checkGamePresenceRateLimit
} from '../../utils/game-presence';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

/**
 * The desktop shell's report of what the caller is playing (`null` =
 * nothing). Stored on the user row and announced per server under the
 * caller's sharing rule (preferences.presence): the server is the
 * authority on `shareGame`, so a report that arrives while it is off is
 * stored as nothing, whatever the client thought. One report per 10 s
 * per user — the shell coalesces, and a flapping detector cannot turn
 * into a fan-out storm.
 */
const setGamePresenceRoute = protectedProcedure
  .input(
    z
      .object({
        name: z.string().trim().min(1).max(GAME_PRESENCE_MAX_NAME_LENGTH)
      })
      .nullable()
  )
  .mutation(async ({ ctx, input }) => {
    // A shadow's presence is its home instance's to announce — the
    // client reports to home, never to the peer it is browsing.
    invariant(!ctx.user.isFederated, {
      code: 'FORBIDDEN',
      message: 'Game presence is reported to your home instance'
    });

    const budget = checkGamePresenceRateLimit(ctx.userId);
    invariant(budget.allowed, {
      code: 'TOO_MANY_REQUESTS',
      message: 'Game presence can change at most once every 10 seconds'
    });

    const prefs = (await getPresencePreferences([ctx.userId])).get(ctx.userId)!;
    const name = input && prefs.shareGame ? input.name : null;

    const { changed, presence } = await setGamePresence(ctx.userId, name);
    if (changed) await announceGamePresence(ctx.userId);

    return { gamePresence: presence };
  });

export { setGamePresenceRoute };
