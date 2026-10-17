import { z } from 'zod';
import {
  createImportJob,
  emptyImportState,
  getActiveImportJobForServer,
  toImportJobView
} from '../../db/queries/import-jobs';
import { getImportDeps } from '../../import/control';
import { DiscordApiClient, DiscordApiError } from '../../import/discord/client';
import type { TDiscordBotUser } from '../../import/discord/types';
import { IMPORT_SOURCE } from '../../import/runner';
import { encryptImportToken, TOKEN_MAX_LENGTH } from '../../import/token-crypto';
import { invariant } from '../../utils/invariant';
import { importOwnerProcedure } from './_shared';

/** Three dot-separated base64url segments; the shape of a bot token, nothing else. */
const TOKEN_SHAPE = /^[\w-]{10,}\.[\w-]{4,}\.[\w-]{10,}$/;

/**
 * Connect: check the token with one call (`/users/@me`), store it
 * encrypted, open the job. The token is never logged and never read
 * back by a route; the bot's name and id are what the wizard shows.
 */
const createJobRoute = importOwnerProcedure
  .input(
    z.object({
      token: z.string().trim().min(1).max(TOKEN_MAX_LENGTH)
    })
  )
  .mutation(async ({ ctx, input }) => {
    invariant(TOKEN_SHAPE.test(input.token), {
      code: 'BAD_REQUEST',
      message: "That doesn't look like a bot token. Copy it from the Bot page of your application."
    });

    const active = await getActiveImportJobForServer(input.serverId);
    invariant(!active, {
      code: 'CONFLICT',
      message: 'An import is already in progress for this server. Finish or cancel it first.'
    });

    const deps = getImportDeps();
    const client = new DiscordApiClient(input.token, {
      transport: deps.transport,
      sleep: deps.sleep,
      now: deps.now
    });

    let bot: TDiscordBotUser;
    try {
      bot = await client.get<TDiscordBotUser>('/users/@me');
    } catch (error) {
      if (error instanceof DiscordApiError && error.status === 401) {
        invariant(false, {
          code: 'BAD_REQUEST',
          message: "That token didn't work. Reset it on the Bot page and paste the new one."
        });
      }
      invariant(false, {
        code: 'BAD_REQUEST',
        message: 'Could not reach the service to check the token. Try again in a moment.'
      });
    }

    invariant(bot && typeof bot.id === 'string' && bot.bot !== false, {
      code: 'BAD_REQUEST',
      message: 'That token belongs to a user account, not a bot.'
    });

    const state = emptyImportState();
    state.bot = { id: bot.id, name: bot.global_name || bot.username || 'bot' };

    const job = await createImportJob({
      serverId: input.serverId,
      createdBy: ctx.userId,
      source: IMPORT_SOURCE,
      tokenCiphertext: encryptImportToken(input.token),
      state
    });

    return toImportJobView(job);
  });

export { createJobRoute };
