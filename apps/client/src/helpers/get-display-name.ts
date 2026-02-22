import type { TJoinedPublicUser } from '@pulse/shared';

export const getDisplayName = (
  user: Pick<TJoinedPublicUser, 'name' | 'nickname'> | undefined
): string => {
  if (!user) return 'Unknown';
  return user.nickname || user.name;
};
