import { useMemo } from 'react';
import { useSelector } from 'react-redux';
import {
  activeInstanceDomainSelector,
  activeServerIdSelector,
  activeViewSelector,
  appLoadingSelector,
  devicesSelector,
  federatedServersSelector,
  joinedServersSelector,
  modViewOpenSelector,
  modViewUserIdSelector,
  serverUnreadCountsSelector
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
