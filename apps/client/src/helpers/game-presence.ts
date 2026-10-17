import type { TGamePresence, TJoinedPublicUser } from '@pulse/server/types';
import { UserStatus } from '@pulse/shared';
import { getDisplayName } from './get-display-name';

/**
 * Pure helpers behind every game-presence surface (roster subline,
 * profile popover, the "Now playing" section, the Home greeting).
 */

/**
 * The one-line status under a name. The game wins while it is set — a
 * custom status is a standing line, the game is what is happening now
 * — and the custom status comes back by itself once the game clears.
 */
export const getRosterSubline = (user: {
  gamePresence?: TGamePresence | null;
  customStatus?: string | null;
}): string | null => {
  if (user.gamePresence) return `Playing ${user.gamePresence.name}`;
  return user.customStatus || null;
};

/** "for 3 min", "for 2 h 05 min"; under a minute reads "just started". */
export const formatPlayingFor = (startedAt: number, now: number): string => {
  const minutes = Math.max(0, Math.floor((now - startedAt) / 60_000));
  if (minutes < 1) return 'just started';
  if (minutes < 60) return `for ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `for ${hours} h ${String(rest).padStart(2, '0')} min`;
};

export type TPlayingGroup = {
  game: string;
  users: TJoinedPublicUser[];
};

/**
 * Members by the game they are playing, biggest group first (ties by
 * game name), members within a group by display name. Only members the
 * roster would list as present count: a banned row is not a member the
 * list shows, and an offline one cannot be playing (the server clears
 * the presence with the last socket) — but a stale copy must not
 * produce a group either.
 */
export const groupMembersByGame = (
  users: readonly TJoinedPublicUser[]
): TPlayingGroup[] => {
  const byGame = new Map<string, TJoinedPublicUser[]>();
  for (const user of users) {
    if (!user.gamePresence || user.banned) continue;
    if ((user.status ?? UserStatus.OFFLINE) === UserStatus.OFFLINE) continue;
    const list = byGame.get(user.gamePresence.name) ?? [];
    list.push(user);
    byGame.set(user.gamePresence.name, list);
  }

  const byName = (a: TJoinedPublicUser, b: TJoinedPublicUser) =>
    getDisplayName(a).localeCompare(getDisplayName(b), undefined, {
      sensitivity: 'base'
    });

  return [...byGame.entries()]
    .map(([game, members]) => ({ game, users: [...members].sort(byName) }))
    .sort(
      (a, b) =>
        b.users.length - a.users.length ||
        a.game.localeCompare(b.game, undefined, { sensitivity: 'base' })
    );
};
