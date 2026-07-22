import type { TJoinedPublicUser } from '@pulse/shared';

export const getDisplayName = (
  user:
    | (Pick<TJoinedPublicUser, 'name' | 'nickname'> &
        Partial<Pick<TJoinedPublicUser, 'deletedAt'>>)
    | undefined
): string => {
  if (!user) return 'Unknown';
  // Tombstones carry a uniquified name ("Deleted User a1b2c3") — render
  // the generic label everywhere instead.
  if (user.deletedAt) return 'Deleted User';
  return user.nickname || user.name;
};
