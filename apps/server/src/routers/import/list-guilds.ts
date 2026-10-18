import type { TImportGuildSummary } from '../../types';
import { z } from 'zod';
import type { TDiscordPartialGuild } from '../../import/discord/types';
import { boundText, guildIconUrl } from '../../import/mapping';
import { clientForJob, importOwnerProcedure, jobIdSchema, requireJob } from './_shared';

/** A bot is in at most 200 guilds per page; one page is the whole list for any real bot. */
const MAX_GUILDS = 200;

const listGuildsRoute = importOwnerProcedure
  .input(z.object({ jobId: jobIdSchema }))
  .query(async ({ input }): Promise<TImportGuildSummary[]> => {
    const job = await requireJob(input.jobId, input.serverId);
    const client = clientForJob(job);
    const guilds = await client.get<TDiscordPartialGuild[]>('/users/@me/guilds', {
      with_counts: true,
      limit: MAX_GUILDS
    });

    if (!Array.isArray(guilds)) return [];

    return guilds.slice(0, MAX_GUILDS).map((guild) => ({
      id: guild.id,
      name: boundText(guild.name, 100, 'Community'),
      iconUrl: guildIconUrl(guild.id, guild.icon),
      approximateMemberCount: guild.approximate_member_count ?? null,
      approximatePresenceCount: guild.approximate_presence_count ?? null
    }));
  });

export { listGuildsRoute };
