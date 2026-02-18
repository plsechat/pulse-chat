import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { deleteServer } from '@/features/app/actions';
import { useActiveInstanceDomain, useActiveServerId, useJoinedServers } from '@/features/app/hooks';
import { useCan } from '@/features/server/hooks';
import { useOwnUserId } from '@/features/server/users/hooks';
import { Permission } from '@pulse/shared';
import { memo, useCallback, useMemo, useState } from 'react';
import type { TServerScreenBaseProps } from '../screens';
import { ServerScreenLayout } from '../server-screen-layout';
import { Emojis } from './emojis';
import { Federation } from './federation';
import { General } from './general';
import { Invites } from './invites';
import { Roles } from './roles';
import { Users } from './users';
import { Webhooks } from './webhooks';
import { AutoMod } from './automod';

type TServerSettingsProps = TServerScreenBaseProps;

const ServerSettings = memo(({ close }: TServerSettingsProps) => {
  const can = useCan();
  const ownUserId = useOwnUserId();
  const activeServerId = useActiveServerId();
  const activeInstanceDomain = useActiveInstanceDomain();
  const joinedServers = useJoinedServers();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const activeServer = useMemo(
    () => joinedServers.find((s) => s.id === activeServerId),
    [joinedServers, activeServerId]
  );

  const isOwner = ownUserId != null && activeServer?.ownerId === ownUserId;

  const defaultTab = useMemo(() => {
    if (can(Permission.MANAGE_SETTINGS)) return 'general';
    if (can(Permission.MANAGE_ROLES)) return 'roles';
    if (can(Permission.MANAGE_EMOJIS)) return 'emojis';
    if (can(Permission.MANAGE_USERS)) return 'users';
    if (can(Permission.MANAGE_INVITES)) return 'invites';
    return 'general';
  }, [can]);

  const handleDelete = useCallback(() => {
    if (activeServerId) {
      deleteServer(activeServerId);
    }
  }, [activeServerId]);

  return (
    <ServerScreenLayout close={close} title="Server Settings">
      <div className="mx-auto max-w-4xl">
        <Tabs defaultValue={defaultTab} className="w-full">
          <TabsList className="mb-6">
            <TabsTrigger
              value="general"
              disabled={!can(Permission.MANAGE_SETTINGS)}
            >
              General
            </TabsTrigger>
            <TabsTrigger value="roles" disabled={!can(Permission.MANAGE_ROLES)}>
              Roles
            </TabsTrigger>
            <TabsTrigger
              value="emojis"
              disabled={!can(Permission.MANAGE_EMOJIS)}
            >
              Emojis
            </TabsTrigger>
            <TabsTrigger value="users" disabled={!can(Permission.MANAGE_USERS)}>
              Users
            </TabsTrigger>
            <TabsTrigger
              value="invites"
              disabled={!can(Permission.MANAGE_INVITES)}
            >
              Invites
            </TabsTrigger>
            <TabsTrigger
              value="webhooks"
              disabled={!can(Permission.MANAGE_WEBHOOKS)}
            >
              Webhooks
            </TabsTrigger>
            <TabsTrigger
              value="automod"
              disabled={!can(Permission.MANAGE_AUTOMOD)}
            >
              Auto-Mod
            </TabsTrigger>
            {!activeInstanceDomain && (
              <TabsTrigger
                value="federation"
                disabled={!can(Permission.MANAGE_SETTINGS)}
              >
                Federation
              </TabsTrigger>
            )}
            {isOwner && (
              <TabsTrigger
                value="delete"
                className="text-destructive data-[state=active]:text-destructive"
              >
                Delete
              </TabsTrigger>
            )}
          </TabsList>
          <TabsContent value="general" className="space-y-6">
            {can(Permission.MANAGE_SETTINGS) && <General />}
          </TabsContent>
          <TabsContent value="roles" className="space-y-6">
            {can(Permission.MANAGE_ROLES) && <Roles />}
          </TabsContent>
          <TabsContent value="emojis" className="space-y-6">
            {can(Permission.MANAGE_EMOJIS) && <Emojis />}
          </TabsContent>
          <TabsContent value="users" className="space-y-6">
            {can(Permission.MANAGE_USERS) && <Users />}
          </TabsContent>
          <TabsContent value="invites" className="space-y-6">
            {can(Permission.MANAGE_INVITES) && <Invites />}
          </TabsContent>
          <TabsContent value="webhooks" className="space-y-6">
            {can(Permission.MANAGE_WEBHOOKS) && <Webhooks />}
          </TabsContent>
          <TabsContent value="automod" className="space-y-6">
            {can(Permission.MANAGE_AUTOMOD) && <AutoMod />}
          </TabsContent>
          {!activeInstanceDomain && (
            <TabsContent value="federation" className="space-y-6">
              {can(Permission.MANAGE_SETTINGS) && <Federation />}
            </TabsContent>
          )}
          {isOwner && (
            <TabsContent value="delete" className="space-y-6">
              <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-6">
                <h3 className="text-lg font-semibold text-destructive">
                  Delete Server
                </h3>
                <p className="mt-2 text-sm text-muted-foreground">
                  Permanently delete{' '}
                  <strong className="text-foreground">
                    {activeServer?.name}
                  </strong>
                  . This will remove all channels, messages, roles, and data.
                  This action cannot be undone.
                </p>
                <button
                  onClick={() => setShowDeleteConfirm(true)}
                  className="mt-4 rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 transition-colors"
                >
                  Delete Server
                </button>
              </div>
            </TabsContent>
          )}
        </Tabs>
      </div>

      <AlertDialog
        open={showDeleteConfirm}
        onOpenChange={setShowDeleteConfirm}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you sure?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete{' '}
              <strong>{activeServer?.name}</strong> and all of its data
              including channels, messages, and members. This action cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDelete}
            >
              Delete Server
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ServerScreenLayout>
  );
});

export { ServerSettings };
