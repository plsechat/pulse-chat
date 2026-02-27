import { ServerEvents } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { getDmChannelMemberIds, getDmMessage } from '../../db/queries/dms';
import { getUserById } from '../../db/queries/users';
import { dmMessageFiles, dmMessages, federationInstances } from '../../db/schema';
import { enqueueProcessDmMetadata } from '../../queues/dm-message-metadata';
import { relayToInstance } from '../../utils/federation';
import { invariant } from '../../utils/invariant';
import { fileManager } from '../../utils/file-manager';
import { logger } from '../../logger';
import { pubsub } from '../../utils/pubsub';
import { protectedProcedure } from '../../utils/trpc';

const sendMessageRoute = protectedProcedure
  .input(
    z.object({
      dmChannelId: z.number(),
      content: z.string().max(4000).optional(),
      encryptedContent: z.string().max(16000).optional(),
      e2ee: z.boolean().optional(),
      files: z.array(z.string()).optional(),
      replyToId: z.number().optional()
    })
  )
  .mutation(async ({ ctx, input }) => {
    const memberIds = await getDmChannelMemberIds(input.dmChannelId);

    invariant(memberIds.includes(ctx.userId), {
      code: 'FORBIDDEN',
      message: 'You are not a member of this DM channel'
    });

    const isE2ee = !!input.e2ee;

    invariant(!isE2ee || input.encryptedContent, {
      code: 'BAD_REQUEST',
      message: 'E2EE messages must include encryptedContent'
    });

    invariant(isE2ee || input.content || (input.files && input.files.length > 0), {
      code: 'BAD_REQUEST',
      message: 'Non-E2EE messages must include content or files'
    });

    const [message] = await db
      .insert(dmMessages)
      .values({
        dmChannelId: input.dmChannelId,
        userId: ctx.userId,
        content: isE2ee ? null : input.content,
        encryptedContent: isE2ee ? input.encryptedContent : null,
        e2ee: isE2ee,
        replyToId: input.replyToId,
        createdAt: Date.now()
      })
      .returning();

    if (input.files && input.files.length > 0) {
      for (const tempFileId of input.files) {
        const newFile = await fileManager.saveFile(tempFileId, ctx.userId);

        await db.insert(dmMessageFiles).values({
          dmMessageId: message!.id,
          fileId: newFile.id,
          createdAt: Date.now()
        });
      }
    }

    const joined = await getDmMessage(message!.id);

    if (joined) {
      for (const memberId of memberIds) {
        pubsub.publishFor(memberId, ServerEvents.DM_NEW_MESSAGE, joined);
      }
    }

    if (input.content && !isE2ee) {
      enqueueProcessDmMetadata(input.content, message!.id, input.dmChannelId);
    }

    // Relay to remote instances for federated members (skip for E2EE)
    if (input.content && !isE2ee) {
      const sender = await getUserById(ctx.userId);
      if (sender) {
        for (const memberId of memberIds) {
          if (memberId === ctx.userId) continue;

          const member = await getUserById(memberId);
          if (!member?.isFederated || !member.federatedInstanceId) continue;

          const [instance] = await db
            .select({ domain: federationInstances.domain })
            .from(federationInstances)
            .where(eq(federationInstances.id, member.federatedInstanceId))
            .limit(1);

          if (instance) {
            if (!sender.publicId || !member.federatedPublicId) {
              logger.error(
                '[sendDmMessage] cannot relay: missing publicId (sender=%s, member=%s)',
                sender.publicId,
                member.federatedPublicId
              );
            } else {
              relayToInstance(instance.domain, '/federation/dm-relay', {
                fromUsername: sender.name,
                fromPublicId: sender.publicId,
                fromAvatarFile: sender.avatar?.name ?? null,
                fromUserId: ctx.userId,
                toPublicId: member.federatedPublicId,
                content: input.content
              }).catch((err) =>
                logger.error('[sendDmMessage] federation relay failed: %o', err)
              );
            }
          }
        }
      }
    }

    return message!.id;
  });

export { sendMessageRoute };
