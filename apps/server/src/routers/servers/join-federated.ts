import { ServerEvents } from '@pulse/shared';
import { timingSafeEqual } from 'crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { getDefaultRoleForServer } from '../../db/queries/roles';
import {
  addServerMember,
  getServersByUserId,
  isServerMember
} from '../../db/queries/servers';
import { servers, userRoles } from '../../db/schema';
import { logger } from '../../logger';
import { invariant } from '../../utils/invariant';
import {
  checkPasswordRateLimit,
  recordPasswordFailure,
  recordPasswordSuccess
} from '../../utils/password-rate-limit';
import { protectedProcedure } from '../../utils/trpc';

const joinFederatedRoute = protectedProcedure
  .input(
    z.object({
      publicId: z.string().min(1),
      password: z.string().optional()
    })
  )
  .mutation(async ({ input, ctx }) => {
    logger.info('[servers/joinFederated] userId=%d, publicId=%s', ctx.userId, input.publicId);

    const [server] = await db
      .select()
      .from(servers)
      .where(eq(servers.publicId, input.publicId))
      .limit(1);

    logger.info('[servers/joinFederated] server=%o', server ? { id: server.id, name: server.name, federatable: server.federatable } : null);

    invariant(server, {
      code: 'NOT_FOUND',
      message: `Server not found for publicId ${input.publicId}`
    });

    invariant(server.federatable, {
      code: 'FORBIDDEN',
      message: 'This server is not available for federation'
    });

    invariant(server.allowNewUsers, {
      code: 'FORBIDDEN',
      message: 'This server is not accepting new members'
    });

    // Check if already a member (existing members skip password)
    const alreadyMember = await isServerMember(server.id, ctx.userId);
    logger.info('[servers/joinFederated] alreadyMember=%s', alreadyMember);

    if (alreadyMember) {
      const userServers = await getServersByUserId(ctx.userId);
      return userServers.find((s) => s.id === server.id)!;
    }

    // Password check for new members
    if (server.password) {
      const rateCheck = checkPasswordRateLimit(ctx.userId, server.id);
      invariant(rateCheck.allowed, {
        code: 'TOO_MANY_REQUESTS',
        message: `Too many failed attempts. Try again in ${Math.ceil(rateCheck.retryAfterMs! / 60000)} minutes.`
      });

      const passwordValid = (() => {
        if (!input.password) return false;
        const a = Buffer.from(input.password);
        const b = Buffer.from(server.password);
        if (a.length !== b.length) return false;
        return timingSafeEqual(a, b);
      })();

      if (!passwordValid) {
        recordPasswordFailure(ctx.userId, server.id);
        invariant(false, {
          code: 'FORBIDDEN',
          message: 'Invalid password'
        });
      }

      recordPasswordSuccess(ctx.userId, server.id);
    }

    // Add member
    await addServerMember(server.id, ctx.userId);

    // Assign default role
    const defaultRole = await getDefaultRoleForServer(server.id);
    if (defaultRole) {
      await db
        .insert(userRoles)
        .values({
          userId: ctx.userId,
          roleId: defaultRole.id,
          createdAt: Date.now()
        })
        .onConflictDoNothing();
    }

    // Return updated server summary
    const userServers = await getServersByUserId(ctx.userId);
    const summary = userServers.find((s) => s.id === server.id)!;

    logger.info('[servers/joinFederated] joined server=%s, userId=%d', server.name, ctx.userId);

    ctx.pubsub.publishFor(ctx.userId, ServerEvents.SERVER_MEMBER_JOIN, {
      serverId: server.id,
      userId: ctx.userId,
      server: summary
    });

    return summary;
  });

export { joinFederatedRoute };
