import {
  SOUND_ROOM_MAX_PER_WINDOW,
  SOUND_ROOM_WINDOW_MS,
  SOUND_USER_COOLDOWN_MS
} from '@pulse/shared';

/**
 * Trigger pacing for the soundboard: one clip per user every 2 s, ten
 * per room per minute. Both windows are in-memory (a restart forgets
 * them, which is fine for a nuisance guard) and `check` records the
 * play only when it is allowed, so a refused trigger does not eat into
 * the room's budget. `now` is injected for the tests.
 *
 * Memory: the user map is pruned of expired entries whenever it grows
 * past a threshold, and a room's list is trimmed to its window on every
 * check and dropped when empty, so neither grows with time.
 */

type TVerdict = 'ok' | 'user' | 'room';

const USER_MAP_PRUNE_THRESHOLD = 1024;

class SoundboardLimiter {
  private lastByUser = new Map<number, number>();
  private playsByRoom = new Map<string, number[]>();

  public check = (userId: number, roomKey: string, now: number): TVerdict => {
    const last = this.lastByUser.get(userId);
    if (last !== undefined && now - last < SOUND_USER_COOLDOWN_MS) {
      return 'user';
    }

    const recent = (this.playsByRoom.get(roomKey) ?? []).filter(
      (at) => now - at < SOUND_ROOM_WINDOW_MS
    );
    if (recent.length >= SOUND_ROOM_MAX_PER_WINDOW) {
      if (recent.length > 0) this.playsByRoom.set(roomKey, recent);
      return 'room';
    }

    recent.push(now);
    this.playsByRoom.set(roomKey, recent);
    this.lastByUser.set(userId, now);

    if (this.lastByUser.size > USER_MAP_PRUNE_THRESHOLD) {
      for (const [id, at] of this.lastByUser) {
        if (now - at >= SOUND_USER_COOLDOWN_MS) this.lastByUser.delete(id);
      }
    }

    return 'ok';
  };

  /** A room that closed has no budget to carry over. */
  public forgetRoom = (roomKey: string) => {
    this.playsByRoom.delete(roomKey);
  };

  /** Tests only. */
  public reset = () => {
    this.lastByUser.clear();
    this.playsByRoom.clear();
  };
}

const soundboardLimiter = new SoundboardLimiter();

export { soundboardLimiter };
