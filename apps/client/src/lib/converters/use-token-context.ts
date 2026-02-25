import { useActiveInstanceDomain } from '@/features/app/hooks';
import { useChannels } from '@/features/server/channels/hooks';
import { useRoles } from '@/features/server/roles/hooks';
import { useUsers } from '@/features/server/users/hooks';
import { getDisplayName } from '@/helpers/get-display-name';
import { getFileUrl } from '@/helpers/get-file-url';
import type { IRootState } from '@/features/store';
import { useMemo } from 'react';
import { useSelector } from 'react-redux';
import type { TokenToTiptapContext } from './tokens-to-tiptap';

export function useTokenToTiptapContext(): TokenToTiptapContext {
  const users = useUsers();
  const roles = useRoles();
  const channels = useChannels();
  const emojis = useSelector((state: IRootState) => state.server.emojis);
  const activeInstanceDomain = useActiveInstanceDomain();

  return useMemo(() => {
    const userMap = new Map<number, string>();
    for (const user of users) {
      userMap.set(user.id, getDisplayName(user));
    }

    const roleMap = new Map<number, string>();
    for (const role of roles) {
      roleMap.set(role.id, role.name);
    }

    const channelMap = new Map<number, string>();
    for (const channel of channels) {
      channelMap.set(channel.id, channel.name);
    }

    const emojiMap = new Map<number, { name: string; src: string }>();
    for (const emoji of emojis) {
      emojiMap.set(emoji.id, {
        name: emoji.name,
        src: getFileUrl(emoji.file, activeInstanceDomain ?? undefined)
      });
    }

    return {
      users: userMap,
      roles: roleMap,
      channels: channelMap,
      emojis: emojiMap
    };
  }, [users, roles, channels, emojis, activeInstanceDomain]);
}
