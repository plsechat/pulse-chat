import { getEmojis } from '../../db/queries/emojis';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const getServerEmojisRoute = protectedProcedure.query(async ({ ctx }) => {
  invariant(ctx.activeServerId, {
    code: 'BAD_REQUEST',
    message: 'No active server'
  });

  const emojis = await getEmojis(ctx.activeServerId);

  // Strip creator user data — not needed for emoji display
  return emojis.map(({ user: _user, ...rest }) => rest);
});

export { getServerEmojisRoute };
