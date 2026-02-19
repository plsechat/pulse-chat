import { useIsAppLoading } from '@/features/app/hooks';
import { ReconnectingBanner } from '@/components/reconnecting-banner';
import {
  useDisconnectInfo,
  useIsConnected,
  useIsReconnecting
} from '@/features/server/hooks';
import { Connect } from '@/screens/connect';
import { Disconnected } from '@/screens/disconnected';
import { LoadingApp } from '@/screens/loading-app';
import { MainView } from '@/screens/main-view';
import { DisconnectCode } from '@pulse/shared';
import { memo } from 'react';

const Routing = memo(() => {
  const isConnected = useIsConnected();
  const isAppLoading = useIsAppLoading();
  const disconnectInfo = useDisconnectInfo();
  const isReconnecting = useIsReconnecting();

  if (isAppLoading) {
    return <LoadingApp />;
  }

  // While reconnecting, keep the main UI visible with a banner on top
  if (isReconnecting) {
    return (
      <>
        <ReconnectingBanner />
        <MainView />
      </>
    );
  }

  if (!isConnected) {
    if (
      disconnectInfo &&
      (!disconnectInfo.wasClean ||
        disconnectInfo.code === DisconnectCode.BANNED)
    ) {
      return <Disconnected info={disconnectInfo} />;
    }

    return <Connect />;
  }

  return <MainView />;
});

export { Routing };
