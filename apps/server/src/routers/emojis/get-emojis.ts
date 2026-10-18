import { Permission } from '@pulse/shared';
import { getEmojis } from '../../db/queries/emojis';
import { serverProcedureFor } from '../../utils/procedures';

const getEmojisRoute = serverProcedureFor(Permission.MANAGE_EMOJIS).query(
  async ({ input }) => {
    const emojis = await getEmojis(input.serverId);

    return emojis;
  }
);

export { getEmojisRoute };
