import {
  ActivityLogType,
  DIRECTORY_DESCRIPTION_MAX_LENGTH,
  DIRECTORY_GAME_MAX_LENGTH,
  DIRECTORY_TAG_MAX_LENGTH,
  DIRECTORY_TAGS_MAX,
  Permission,
  ServerEvents,
  StorageOverflowAction
} from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../../config';
import { db } from '../../db';
import { getServerPublicSettings } from '../../db/queries/server';
import {
  getServerById,
  getServerMemberIds,
  isInstanceOwner,
  isServerOwner
} from '../../db/queries/servers';
import { servers } from '../../db/schema';
import { enqueueActivityLog } from '../../queues/activity-log';
import { invariant } from '../../utils/invariant';
import { serverProcedureFor } from '../../utils/procedures';

const updateSettingsRoute = serverProcedureFor(Permission.MANAGE_SETTINGS)
  .input(
    z.object({
      name: z.string().min(2).max(24).optional(),
      description: z.string().max(128).optional(),
      password: z.string().min(1).max(32).optional().nullable(),
      allowNewUsers: z.boolean().optional(),
      storageUploadEnabled: z.boolean().optional(),
      storageUploadMaxFileSize: z.number().min(0).optional(),
      storageSpaceQuotaByUser: z.number().min(0).optional(),
      storageOverflowAction: z.enum(StorageOverflowAction).optional(),
      enablePlugins: z.boolean().optional(),
      discoverable: z.boolean().optional(),
      federatable: z.boolean().optional(),
      // Public directory opt-in (card copy). Tags are trimmed and
      // deduplicated case-insensitively; an empty description or game
      // clears the field.
      directoryListed: z.boolean().optional(),
      directoryDescription: z
        .string()
        .trim()
        .max(DIRECTORY_DESCRIPTION_MAX_LENGTH)
        .optional()
        .nullable(),
      directoryTags: z
        .array(z.string().trim().min(1).max(DIRECTORY_TAG_MAX_LENGTH))
        .max(DIRECTORY_TAGS_MAX)
        .optional(),
      directoryGame: z.string().trim().max(DIRECTORY_GAME_MAX_LENGTH).optional().nullable()
    })
  )
  .mutation(async ({ input, ctx }) => {
    const server = await getServerById(input.serverId);

    invariant(server, {
      code: 'NOT_FOUND',
      message: 'Server not found'
    });

    // A listing is only a card with working buttons while the server
    // has an open join path: the Directory reuses servers.preview /
    // servers.joinDiscover (which require `discoverable`) and both
    // refuse a server that is not accepting members. Checked on the
    // RESULTING state so turning discoverable off in the same save as
    // the listing is refused too.
    const resultingListed = input.directoryListed ?? server.directoryListed;
    if (resultingListed) {
      const resultingDiscoverable = input.discoverable ?? server.discoverable;
      const resultingAllowNewUsers = input.allowNewUsers ?? server.allowNewUsers;
      invariant(resultingDiscoverable && resultingAllowNewUsers, {
        code: 'BAD_REQUEST',
        message:
          'A listed server must be discoverable and accepting new members'
      });
    }

    if (input.directoryTags !== undefined) {
      const seen = new Set<string>();
      input.directoryTags = input.directoryTags.filter((tag) => {
        const key = tag.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    if (input.directoryDescription === '') input.directoryDescription = null;
    if (input.directoryGame === '') input.directoryGame = null;

    // "Federatable" is owner-controlled and instance-gated, unlike the
    // rest of these MANAGE_SETTINGS fields: only the server OWNER may
    // change it, and turning it ON also requires the instance owner to
    // have allowed user-federatable servers (you being the instance owner
    // always counts). The client submits the whole settings object, so
    // only enforce when the value actually changes — otherwise a non-owner
    // admin editing the name would trip on the unchanged federatable flag.
    if (
      input.federatable !== undefined &&
      input.federatable !== server.federatable
    ) {
      invariant(await isServerOwner(input.serverId, ctx.userId), {
        code: 'FORBIDDEN',
        message:
          'Only the server owner can change whether this server is federatable'
      });

      if (input.federatable === true) {
        const allowed =
          (await isInstanceOwner(ctx.userId)) ||
          config.federation.allowUserFederatableServers;
        invariant(allowed, {
          code: 'FORBIDDEN',
          message:
            'The instance owner has not allowed users to make servers federatable'
        });
      }
    }

    const { serverId, ...rest } = input;

    // Partial update: only the keys the caller sent are written. An
    // omitted `password` must leave the current one alone (an explicit
    // null clears it).
    const updates = Object.fromEntries(
      Object.entries(rest).filter(([, value]) => value !== undefined)
    );

    await db
      .update(servers)
      .set({
        ...updates,
        updatedAt: Date.now()
      })
      .where(eq(servers.id, serverId));

    // Publish to server members
    const publicSettings = await getServerPublicSettings(serverId);
    const memberIds = await getServerMemberIds(serverId);
    ctx.pubsub.publishFor(
      memberIds,
      ServerEvents.SERVER_SETTINGS_UPDATE,
      publicSettings
    );

    enqueueActivityLog({
      type: ActivityLogType.EDIT_SERVER_SETTINGS,
      userId: ctx.userId,
      details: { values: input }
    });
  });

export { updateSettingsRoute };
