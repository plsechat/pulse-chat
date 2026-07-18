import { logger } from '../logger';
import { VoiceRuntime } from '../runtimes/voice';
import { removeUserFromVoice } from '../utils/voice-cleanup';
import { hasLiveWsConnection } from '../utils/wss';

/**
 * Reconcile in-memory voice membership against live WS connections.
 * Belt-and-braces behind the per-socket close teardown: any leak class
 * this sweep catches would otherwise strand a ghost peer in the channel
 * until server restart (the pre-fix symptom). A user mid-refresh may be
 * swept during the connection gap — that is the desired outcome; the
 * self-healing join lets them rejoin cleanly.
 */
const cleanupOrphanVoiceUsers = async () => {
  for (const runtime of VoiceRuntime.getAll()) {
    for (const user of [...runtime.getState().users]) {
      if (hasLiveWsConnection(user.userId)) continue;

      logger.info(
        '[cron] removing orphaned voice user %d from channel %d',
        user.userId,
        runtime.id
      );

      try {
        await removeUserFromVoice(user.userId);
      } catch (err) {
        logger.error(
          '[cron] failed to remove orphaned voice user %d:',
          user.userId,
          err
        );
      }
    }
  }
};

export { cleanupOrphanVoiceUsers };
