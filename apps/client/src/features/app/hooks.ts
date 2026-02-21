import { useMemo } from 'react';
import { useSelector } from 'react-redux';
import {
  activeInstanceDomainSelector,
  activeServerIdSelector,
  activeViewSelector,
  appLoadingSelector,
  devicesSelector,
  federatedConnectionStatusesSelector,
  federatedServersSelector,
  joinedServersSelector,
  modViewOpenSelector,
  modViewUserIdSelector,
  serverMentionCountsSelector,
  serverUnreadCountsSelector,
  totalDmUnreadCountSelector
} from './selectors';

export const useIsAppLoading = () => useSelector(appLoadingSelector);

export const useDevices = () => useSelector(devicesSelector);

export const useModViewOpen = () => {
  const isOpen = useSelector(modViewOpenSelector);
  const userId = useSelector(modViewUserIdSelector);

  return useMemo(() => ({ isOpen, userId }), [isOpen, userId]);
};

export const useActiveView = () => useSelector(activeViewSelector);

export const useJoinedServers = () => useSelector(joinedServersSelector);

export const useActiveServerId = () => useSelector(activeServerIdSelector);

export const useFederatedServers = () =>
  useSelector(federatedServersSelector);

export const useActiveInstanceDomain = () =>
  useSelector(activeInstanceDomainSelector);

export const useServerUnreadCounts = () =>
  useSelector(serverUnreadCountsSelector);

export const useServerMentionCounts = () =>
  useSelector(serverMentionCountsSelector);

export const useTotalDmUnreadCount = () =>
  useSelector(totalDmUnreadCountSelector);

export const useFederatedConnectionStatuses = () =>
  useSelector(federatedConnectionStatusesSelector);
