import { getEmojis } from '../../db/queries/emojis';
import { serverProcedure } from '../../utils/procedures';

const getServerEmojisRoute = serverProcedure().query(async ({ ctx }) => {
  const emojis = await getEmojis(ctx.activeServerId);

  // Strip creator user data — not needed for emoji display
  return emojis.map(({ user: _user, ...rest }) => rest);
});

export { getServerEmojisRoute };
