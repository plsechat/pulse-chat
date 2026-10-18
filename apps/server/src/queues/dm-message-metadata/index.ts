import { ServerEvents } from '@pulse/shared';
import Queue from 'queue';
import { getDmChannelMemberIds, getDmMessage } from '../../db/queries/dms';
import { logger } from '../../logger';
import { pubsub } from '../../utils/pubsub';
import {
  hasLinkPreviewCandidate,
  LINK_PREVIEW_JOB_TIMEOUT_MS
} from '../message-metadata/get-message-metadata';
import { processDmMessageMetadata } from './get-dm-message-metadata';

const dmMessageMetadataQueue = new Queue({
  concurrency: 1,
  autostart: true,
  // See queues/message-metadata: must exceed the preview deadline.
  timeout: LINK_PREVIEW_JOB_TIMEOUT_MS
});

dmMessageMetadataQueue.autostart = true;

// queue@7 discards every queued job when one rejects. Jobs catch their
// own failures; this listener logs anything that still escapes.
dmMessageMetadataQueue.addEventListener('error', (event) => {
  const error = event.detail.error;
  logger.error(
    'DM message metadata job failed: %s',
    error instanceof Error ? error.message : String(error)
  );
});

const enqueueProcessDmMetadata = (
  content: string,
  dmMessageId: number,
  dmChannelId: number
) => {
  if (!hasLinkPreviewCandidate(content)) return;

  dmMessageMetadataQueue.push(async (callback) => {
    try {
      const updated = await processDmMessageMetadata(content, dmMessageId);

      if (updated) {
        const joined = await getDmMessage(dmMessageId);

        if (joined) {
          const memberIds = await getDmChannelMemberIds(dmChannelId);

          for (const memberId of memberIds) {
            pubsub.publishFor(
              memberId,
              ServerEvents.DM_MESSAGE_UPDATE,
              joined
            );
          }
        }
      }
    } catch (error) {
      logger.error(
        'Failed to process metadata for DM message %d: %s',
        dmMessageId,
        error instanceof Error ? error.message : String(error)
      );
    }

    callback?.();
  });
};

export { enqueueProcessDmMetadata, dmMessageMetadataQueue };
