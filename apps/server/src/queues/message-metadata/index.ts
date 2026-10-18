import Queue from 'queue';
import { publishMessage } from '../../db/publishers';
import { logger } from '../../logger';
import {
  hasLinkPreviewCandidate,
  LINK_PREVIEW_JOB_TIMEOUT_MS,
  processMessageMetadata
} from './get-message-metadata';

const messageMetadataQueue = new Queue({
  concurrency: 1,
  autostart: true,
  // Above the preview deadline: a job that outlives its queue timeout
  // keeps running detached, which turns `concurrency: 1` into
  // unbounded parallel fetching.
  timeout: LINK_PREVIEW_JOB_TIMEOUT_MS
});

messageMetadataQueue.autostart = true;

// queue@7 discards every queued job when one rejects. Jobs catch their
// own failures; this listener logs anything that still escapes.
messageMetadataQueue.addEventListener('error', (event) => {
  const error = event.detail.error;
  logger.error(
    'Message metadata job failed: %s',
    error instanceof Error ? error.message : String(error)
  );
});

/**
 * Queues link-preview extraction for a message. A message with no URL in
 * it is skipped up front — it used to cost an UPDATE plus a
 * MESSAGE_UPDATE fan-out per message just to write `metadata = []`.
 */
const enqueueProcessMetadata = (content: string, messageId: number) => {
  if (!hasLinkPreviewCandidate(content)) return;

  messageMetadataQueue.push(async (callback) => {
    try {
      const updatedMessage = await processMessageMetadata(content, messageId);

      if (updatedMessage) {
        publishMessage(messageId, updatedMessage.channelId, 'update');
      }
    } catch (error) {
      logger.error(
        'Failed to process metadata for message %d: %s',
        messageId,
        error instanceof Error ? error.message : String(error)
      );
    }

    callback?.();
  });
};

export { enqueueProcessMetadata, messageMetadataQueue };
