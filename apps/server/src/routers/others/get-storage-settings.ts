import type { TStorageSettings } from '../../types';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { servers } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { getDiskMetrics } from '../../utils/metrics';
import { instanceOwnerProcedure } from '../../utils/procedures';

/**
 * Storage settings of a server plus the INSTANCE's disk metrics. The
 * disk numbers describe the operator's host, not the server, so this is
 * an instance-owner surface — a per-server MANAGE_STORAGE holder (every
 * owner of their own server) must not read them.
 */
const getStorageSettingsRoute = instanceOwnerProcedure
  .input(
    z.object({
      serverId: z.number().int().positive()
    })
  )
  .query(async ({ input }) => {
    const [[server], diskMetrics] = await Promise.all([
      db
        .select()
        .from(servers)
        .where(eq(servers.id, input.serverId))
        .limit(1),
      getDiskMetrics()
    ]);

    invariant(server, { code: 'NOT_FOUND', message: 'Server not found' });

    const storageSettings: TStorageSettings = {
      storageUploadEnabled: server.storageUploadEnabled,
      storageUploadMaxFileSize: server.storageUploadMaxFileSize,
      storageSpaceQuotaByUser: server.storageSpaceQuotaByUser,
      storageOverflowAction: server.storageOverflowAction,
      storageQuota: server.storageQuota
    };

    return { storageSettings, diskMetrics };
  });

export { getStorageSettingsRoute };
