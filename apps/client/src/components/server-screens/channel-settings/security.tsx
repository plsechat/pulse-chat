import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import { Group } from '@/components/ui/group';
import { Switch } from '@/components/ui/switch';
import { useActiveServerId, useJoinedServers } from '@/features/app/hooks';
import { useIsOwnUserOwner } from '@/features/server/hooks';
import { useOwnUserId } from '@/features/server/users/hooks';
import { requestConfirmation } from '@/features/dialogs/actions';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { getTRPCClient } from '@/lib/trpc';
import { Lock } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

type TSecurityProps = {
  channelId: number;
};

const Security = memo(({ channelId }: TSecurityProps) => {
  const ownUserId = useOwnUserId();
  const activeServerId = useActiveServerId();
  const joinedServers = useJoinedServers();
  const isOwnerByRole = useIsOwnUserOwner();
  const isOwner = useMemo(() => {
    // Check ownerId on the server record (works for user-created servers)
    const server = joinedServers.find((s) => s.id === activeServerId);
    const isOwnerById = ownUserId != null && server?.ownerId === ownUserId;
    // Fall back to role-based check (works for the default seeded server
    // where ownerId is null but the Owner role is assigned)
    return isOwnerById || isOwnerByRole;
  }, [joinedServers, activeServerId, ownUserId, isOwnerByRole]);
  const [e2ee, setE2ee] = useState(false);
  const [loadingE2ee, setLoadingE2ee] = useState(true);

  useEffect(() => {
    const fetchChannel = async () => {
      const trpc = getTRPCClient();
      try {
        const channel = await trpc.channels.get.query({ channelId });
        setE2ee(channel.e2ee);
      } catch {
        // ignore
      } finally {
        setLoadingE2ee(false);
      }
    };
    fetchChannel();
  }, [channelId]);

  const onRotateToken = useCallback(async () => {
    const trpc = getTRPCClient();

    try {
      await trpc.channels.rotateFileAccessToken.mutate({ channelId });

      toast.success('File access token rotated successfully');
    } catch (error) {
      toast.error(getTrpcError(error, 'Failed to rotate file access token'));
    }
  }, [channelId]);

  const onEnableE2ee = useCallback(async () => {
    const confirmed = await requestConfirmation({
      title: 'Enable End-to-End Encryption',
      message:
        'This will enable end-to-end encryption for this channel. Once enabled, this cannot be disabled. Server-side search will not work for encrypted messages. Are you sure?',
      confirmLabel: 'Enable E2EE'
    });

    if (!confirmed) return;

    const trpc = getTRPCClient();
    try {
      await trpc.channels.update.mutate({
        channelId,
        e2ee: true
      });
      setE2ee(true);
      toast.success('End-to-end encryption enabled');
    } catch (error) {
      toast.error(getTrpcError(error, 'Failed to enable E2EE'));
    }
  }, [channelId]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Security</CardTitle>
        <CardDescription>
          Manage some security settings for this channel
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {isOwner && (
          <Group
            label="End-to-End Encryption"
            description="Encrypt all messages so only channel members can read them. The server cannot access message content."
          >
            {loadingE2ee ? (
              <p className="text-sm text-muted-foreground">Loading...</p>
            ) : e2ee ? (
              <div className="flex items-center gap-2 text-sm text-emerald-500">
                <Lock className="h-4 w-4" />
                <span>End-to-end encryption is enabled for this channel</span>
              </div>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  Once enabled, E2EE cannot be disabled. Existing messages will
                  remain unencrypted, but all new messages will be encrypted.
                  Server-side search and automod will not work for encrypted
                  messages.
                </p>
                <Switch
                  checked={false}
                  onCheckedChange={onEnableE2ee}
                />
              </>
            )}
          </Group>
        )}

        {!isOwner && e2ee && !loadingE2ee && (
          <Group label="End-to-End Encryption">
            <div className="flex items-center gap-2 text-sm text-emerald-500">
              <Lock className="h-4 w-4" />
              <span>End-to-end encryption is enabled for this channel</span>
            </div>
          </Group>
        )}

        <Group label="File Access Token" help="Only used for private channels">
          <p className="text-sm text-muted-foreground">
            The file access token is used to secure access to files in this
            channel. Rotating the token will invalidate all existing file links.
            This means that ALL previously shared files will no longer be
            accessible.
          </p>
          <Button variant="destructive" onClick={onRotateToken}>
            Rotate Token
          </Button>
        </Group>
      </CardContent>
    </Card>
  );
});

export { Security };
