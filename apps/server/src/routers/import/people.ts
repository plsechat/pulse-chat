import { Permission } from '@pulse/shared';
import type { TImportedPerson } from '../../types';
import { z } from 'zod';
import { linkPlaceholderToMember, listServerPlaceholders } from '../../import/placeholders';
import { invariant } from '../../utils/invariant';
import { serverProcedureFor } from '../../utils/procedures';

/**
 * Server Settings → Import → "Imported people". The owner (or anyone
 * holding MANAGE_USERS there) sees the placeholders an import left in
 * the server and hands each one's history to the member it belongs
 * to. The link is the same one-way merge a matching sign-in performs:
 * the placeholder's messages, pins, forwards, event signups, roles and
 * membership move to the member and the placeholder is deleted. There
 * is no unlink; the screen says so before asking.
 */

const serverInput = z.object({ serverId: z.number().int().positive() });

const listPlaceholdersRoute = serverProcedureFor(Permission.MANAGE_USERS)
  .input(serverInput)
  .query(async ({ input }): Promise<TImportedPerson[]> => listServerPlaceholders(input.serverId));

const linkPlaceholderRoute = serverProcedureFor(Permission.MANAGE_USERS)
  .input(
    serverInput.extend({
      placeholderUserId: z.number().int().positive(),
      userId: z.number().int().positive()
    })
  )
  .mutation(async ({ input }) => {
    const outcome = await linkPlaceholderToMember(
      input.serverId,
      input.placeholderUserId,
      input.userId
    );

    invariant(outcome.ok || outcome.reason !== 'placeholder', {
      code: 'NOT_FOUND',
      message: 'That imported person is not in this server'
    });
    invariant(outcome.ok || outcome.reason !== 'member', {
      code: 'BAD_REQUEST',
      message: 'Pick a member of this server with an account of their own'
    });
    invariant(outcome.ok, {
      code: 'CONFLICT',
      message: 'That imported person was already linked'
    });

    return { placeholderUserId: input.placeholderUserId, userId: input.userId };
  });

export { linkPlaceholderRoute, listPlaceholdersRoute };
