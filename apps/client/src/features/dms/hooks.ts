import { useSelector } from 'react-redux';
import { useMemo } from 'react';
import type { IRootState } from '../store';
import { blockedUsersSelector } from '../friends/selectors';
import { ownUserIdSelector } from '../server/users/selectors';
import {
  dmActiveCallsSelector,
  dmCallByChannelIdSelector,
  dmChannelsSelector,
  dmMessagesSelector,
  dmsLoadingSelector,
  dmTypingUsersSelector,
  ownDmCallChannelIdSelector,
  ringingCallsSelector,
  selectedDmChannelIdSelector,
  selectedDmChannelSelector
} from './selectors';

/**
 * DM channels with any 1:1 conversation containing a blocked user
 * filtered out. Group DMs containing a blocked user keep showing —
 * the user can still see the other members and the group itself isn't
 * inherently a private channel between just them — but their messages
 * are filtered downstream. The 1:1 case is the only one that warrants
 * total invisibility per the block-spec ("no contact, no visibility").
 */
export const useDmChannels = () => {
  const channels = useSelector(dmChannelsSelector);
  const blocked = useSelector(blockedUsersSelector);
  const ownUserId = useSelector(ownUserIdSelector);
  return useMemo(() => {
    if (blocked.length === 0) return channels;
    const blockedIds = new Set(blocked.map((b) => b.id));
    return channels.filter((channel) => {
      if (channel.isGroup) return true;
      const other = channel.members.find((m) => m.id !== ownUserId);
      return !other || !blockedIds.has(other.id);
    });
  }, [channels, blocked, ownUserId]);
};

export const useSelectedDmChannelId = () =>
  useSelector(selectedDmChannelIdSelector);

export const useSelectedDmChannel = () =>
  useSelector(selectedDmChannelSelector);

export const useDmMessages = (dmChannelId: number) =>
  useSelector((state: IRootState) => dmMessagesSelector(state, dmChannelId));

export const useDmsLoading = () => useSelector(dmsLoadingSelector);

export const useDmActiveCalls = () => useSelector(dmActiveCallsSelector);

export const useDmCall = (dmChannelId: number) =>
  useSelector((state: IRootState) =>
    dmCallByChannelIdSelector(state, dmChannelId)
  );

export const useOwnDmCallChannelId = () =>
  useSelector(ownDmCallChannelIdSelector);

export const useDmTypingUsers = (dmChannelId: number) =>
  useSelector((state: IRootState) =>
    dmTypingUsersSelector(state, dmChannelId)
  );

export const useRingingCalls = () => useSelector(ringingCallsSelector);
