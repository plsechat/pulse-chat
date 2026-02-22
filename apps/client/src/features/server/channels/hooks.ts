import type { IRootState } from '@/features/store';
import { useSelector } from 'react-redux';
import {
  activeThreadIdSelector,
  activeThreadSelector,
  channelByIdSelector,
  channelPermissionsByIdSelector,
  channelsByCategoryIdSelector,
  channelsSelector,
  currentVoiceChannelIdSelector,
  currentVoiceServerIdSelector,
  isCurrentVoiceChannelSelectedSelector,
  lastReadMessageIdSelector,
  selectedChannelIdSelector,
  selectedChannelSelector,
  selectedChannelTypeSelector,
  threadsByParentChannelIdSelector
} from './selectors';

export const useChannels = () =>
  useSelector((state: IRootState) => channelsSelector(state));

export const useChannelById = (channelId: number) =>
  useSelector((state: IRootState) => channelByIdSelector(state, channelId));

export const useChannelsByCategoryId = (categoryId: number) =>
  useSelector((state: IRootState) =>
    channelsByCategoryIdSelector(state, categoryId)
  );

export const useSelectedChannelId = () =>
  useSelector(selectedChannelIdSelector);

export const useSelectedChannel = () => useSelector(selectedChannelSelector);

export const useCurrentVoiceChannelId = () =>
  useSelector(currentVoiceChannelIdSelector);

export const useCurrentVoiceServerId = () =>
  useSelector(currentVoiceServerIdSelector);

export const useIsCurrentVoiceChannelSelected = () =>
  useSelector(isCurrentVoiceChannelSelectedSelector);

export const useChannelPermissionsById = (channelId: number) =>
  useSelector((state: IRootState) =>
    channelPermissionsByIdSelector(state, channelId)
  );

export const useSelectedChannelType = () =>
  useSelector(selectedChannelTypeSelector);

export const useActiveThreadId = () =>
  useSelector(activeThreadIdSelector);

export const useActiveThread = () =>
  useSelector(activeThreadSelector);

export const useThreadsByParentChannelId = (parentChannelId: number) =>
  useSelector((state: IRootState) =>
    threadsByParentChannelIdSelector(state, parentChannelId)
  );

export const useLastReadMessageId = (channelId: number) =>
  useSelector((state: IRootState) =>
    lastReadMessageIdSelector(state, channelId)
  );
