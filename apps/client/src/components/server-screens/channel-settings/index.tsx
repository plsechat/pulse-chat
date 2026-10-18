import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useCan } from '@/features/server/hooks';
import { Permission } from '@pulse/shared';
import { memo } from 'react';
import type { TServerScreenBaseProps } from '../screens';
import { ServerScreenLayout } from '../server-screen-layout';
import { Bridge } from './bridge';
import { useBridgeStatus } from './bridge/hooks';
import { Follows } from './follows';
import { General } from './general';
import { ChannelPermissions } from './permissions';
import { Security } from './security';

export type TChannelSettingsProps = TServerScreenBaseProps & {
  channelId: number;
};

const ChannelSettings = memo(({ close, channelId }: TChannelSettingsProps) => {
  const can = useCan();
  // The Bridge tab exists only while the bridge plugin is loaded on the
  // instance: the status route says so, and it is the same query the
  // tab itself renders from.
  const bridge = useBridgeStatus(channelId);
  const showBridge =
    can(Permission.MANAGE_CHANNELS) && bridge.status !== null && bridge.status.available;
  // Following is a MANAGE_CHANNELS affair on the target's server; the
  // tab is offered on every text channel (any of them may follow).
  const showFollows = can(Permission.MANAGE_CHANNELS);

  return (
    <ServerScreenLayout close={close} title="Channel Settings">
      <div className="mx-auto max-w-4xl">
        <Tabs defaultValue="general" className="w-full">
          <TabsList className="mb-6">
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="permissions">Permissions</TabsTrigger>
            <TabsTrigger value="security">Security</TabsTrigger>
            {showFollows && <TabsTrigger value="follows">Follows</TabsTrigger>}
            {showBridge && <TabsTrigger value="bridge">Bridge</TabsTrigger>}
          </TabsList>

          <TabsContent value="general" className="space-y-6">
            <General channelId={channelId} />
          </TabsContent>
          <TabsContent value="permissions" className="space-y-6">
            <ChannelPermissions channelId={channelId} />
          </TabsContent>
          <TabsContent value="security" className="space-y-6">
            <Security channelId={channelId} />
          </TabsContent>
          {showFollows && (
            <TabsContent value="follows" className="space-y-6">
              <Follows channelId={channelId} />
            </TabsContent>
          )}
          {showBridge && bridge.status && (
            <TabsContent value="bridge" className="space-y-6">
              <Bridge channelId={channelId} status={bridge.status} refresh={bridge.refresh} />
            </TabsContent>
          )}
        </Tabs>
      </div>
    </ServerScreenLayout>
  );
});

export { ChannelSettings };
