import { ServerEvents } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { isBlockBetween } from '../../db/queries/blocks';
import { getDmChannelMemberIds, getDmMessage } from '../../db/queries/dms';
import { getUserById } from '../../db/queries/users';
import { dmChannels, dmMessageFiles, dmMessages, federationInstances } from '../../db/schema';
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
      content: z.string().max(16000).optional(),
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

    // Refuse the send outright when there's a block between the sender
    // and any other channel member — this surfaces the block to the
    // sender as a clear error rather than letting them shout into a
    // void the recipient can't see. For 1:1 DMs only one peer matters;
    // for group DMs we block on any pair so a blocked-by user can't
    // be circumvented by the group fanout.
    for (const memberId of memberIds) {
      if (memberId === ctx.userId) continue;
      const blocked = await isBlockBetween(ctx.userId, memberId);
      invariant(!blocked, {
        code: 'FORBIDDEN',
        message:
          'You can no longer send messages to one of these members.'
      });
    }

    const isE2ee = !!input.e2ee;

    // Enforce the channel's e2ee flag on every send. Without this the
    // server trusted whatever the client put in `input.e2ee`, so any
    // client-side bug (sticky state, missing recipient, encryption
    // throw silently caught) would land plaintext in the DB on a
    // channel the user believes is encrypted. Make those failures
    // loud — the client surfaces BAD_REQUEST as a toast.
    const [channel] = await db
      .select({ e2ee: dmChannels.e2ee })
      .from(dmChannels)
      .where(eq(dmChannels.id, input.dmChannelId))
      .limit(1);
    invariant(channel, {
      code: 'NOT_FOUND',
      message: 'DM channel not found'
    });
    invariant(channel.e2ee === isE2ee, {
      code: 'BAD_REQUEST',
      message: channel.e2ee
        ? 'This conversation is encrypted — plaintext sends are not allowed.'
        : 'This conversation is not encrypted — encrypted sends are not allowed.'
    });

    invariant(!isE2ee || input.content, {
      code: 'BAD_REQUEST',
      message: 'E2EE messages must include content'
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
        content: input.content ?? null,
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

    // Relay to remote instances for federated members. Phase D / D1
    // flipped the previous `!isE2ee` gate — encrypted messages now
    // ride through the same `/federation/dm-relay` path with an
    // explicit e2ee flag and the ciphertext envelope as `content`.
    // The receiving instance never decrypts; it just routes the
    // ciphertext to the recipient's WS and persists with e2ee=true.
    // Plaintext path is unchanged.
    if (input.content) {
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
                content: input.content,
                // Phase D / D1: receiver uses this flag to persist
                // the message with e2ee=true and to auto-upgrade the
                // channel's encryption flag on first ciphertext.
                e2ee: isE2ee
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
