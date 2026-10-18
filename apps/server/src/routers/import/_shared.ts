import { Permission } from '@pulse/shared';
import type { TImportJob } from '../../types';
import { z } from 'zod';
import { getImportJob } from '../../db/queries/import-jobs';
import { isServerOwner } from '../../db/queries/servers';
import { getImportDeps } from '../../import/control';
import { DiscordApiClient } from '../../import/discord/client';
import { decryptImportToken } from '../../import/token-crypto';
import { invariant } from '../../utils/invariant';
import { serverProcedureFor } from '../../utils/procedures';

/**
 * Every import route names its `serverId` and is the server OWNER's
 * alone: an import rewrites the server's name and icon and mints
 * members, which no role permission should be able to do. Built on
 * `serverProcedureFor` so the permission is evaluated in that server,
 * then narrowed to the owner.
 */
const importOwnerProcedure = serverProcedureFor(Permission.MANAGE_SETTINGS).use(
  async ({ ctx, input, next }) => {
    invariant(await isServerOwner(input.serverId, ctx.userId), {
      code: 'FORBIDDEN',
      message: 'Only the server owner can import a community'
    });

    return next();
  }
);

const jobIdSchema = z.number().int().positive();

/** Cross-server scope: a job of another server reads as not found. */
const requireJob = async (jobId: number, serverId: number): Promise<TImportJob> => {
  const job = await getImportJob(jobId);

  invariant(job && job.serverId === serverId, {
    code: 'NOT_FOUND',
    message: 'Import not found'
  });

  return job;
};

/** The API client for a job that still holds its connection. */
const clientForJob = (job: TImportJob): DiscordApiClient => {
  invariant(job.tokenCiphertext, {
    code: 'BAD_REQUEST',
    message: 'This import has ended; start a new one to connect again'
  });

  const deps = getImportDeps();

  return new DiscordApiClient(decryptImportToken(job.tokenCiphertext), {
    transport: deps.transport,
    sleep: deps.sleep,
    now: deps.now
  });
};

export { clientForJob, importOwnerProcedure, jobIdSchema, requireJob };
