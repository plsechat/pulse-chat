import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import { Group } from '@/components/ui/group';
import { Input } from '@/components/ui/input';
import { LoadingCard } from '@/components/ui/loading-card';
import { SettingsFormFooter } from '@/components/ui/settings-form-footer';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useActiveServerId, useJoinedServers } from '@/features/app/hooks';
import { closeServerScreens } from '@/features/server-screens/actions';
import {
  useFederatableServersAllowed,
  useIsInstanceOwner
} from '@/features/server/hooks';
import { useAdminGeneral } from '@/features/server/admin/hooks';
import { useOwnUserId } from '@/features/server/users/hooks';
import { memo, useMemo } from 'react';
import { LogoManager } from './logo-manager';

const General = memo(() => {
  const activeServerId = useActiveServerId();
  const { settings, logo, loading, onChange, submit, errors, refetch } =
    useAdminGeneral(activeServerId);

  // The Federatable toggle is owner-only and gated by the instance policy
  // (see federation/set-config + others/update-settings). Show it only to
  // the server owner; enable it only when they may actually change it —
  // the instance owner always may, a plain owner only if the operator
  // allowed it, and it stays interactive while already on so the owner can
  // always turn it back off.
  const ownUserId = useOwnUserId();
  const joinedServers = useJoinedServers();
  const isInstanceOwner = useIsInstanceOwner();
  const federatableServersAllowed = useFederatableServersAllowed();

  const isServerOwner = useMemo(() => {
    const server = joinedServers.find((s) => s.id === activeServerId);
    return ownUserId != null && server?.ownerId === ownUserId;
  }, [joinedServers, activeServerId, ownUserId]);

  const canToggleFederatable =
    isInstanceOwner || federatableServersAllowed || settings.federatable;

  if (loading) {
    return <LoadingCard className="h-[600px]" />;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Server Information</CardTitle>
        <CardDescription>
          Manage your server's basic information
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Group label="Name">
          <Input
            value={settings.name}
            onChange={(e) => onChange('name', e.target.value)}
            placeholder="Enter server name"
            error={errors.name}
          />
        </Group>

        <Group label="Description">
          <Textarea
            value={settings.description}
            onChange={(e) => onChange('description', e.target.value)}
            placeholder="Enter server description"
            rows={4}
          />
        </Group>

        <Group label="Password">
          <Input
            value={settings.password}
            onChange={(e) => onChange('password', e.target.value)}
            placeholder="Leave empty for no password"
            error={errors.password}
          />
        </Group>

        <LogoManager logo={logo} serverId={activeServerId} refetch={refetch} />

        <Group
          label="Allow New Users"
          description="Allow anyone to register and join your server. If disabled, only users you invite can join."
        >
          <Switch
            checked={settings.allowNewUsers}
            onCheckedChange={(checked) => onChange('allowNewUsers', checked)}
          />
        </Group>

        <Group
          label="Discoverable"
          description="Show this server in the Discover directory so anyone can find and join it."
        >
          <Switch
            checked={settings.discoverable}
            onCheckedChange={(checked) => onChange('discoverable', checked)}
          />
        </Group>

        {isServerOwner && (
          <Group
            label="Federatable"
            description={
              canToggleFederatable
                ? 'Allow users from federated Pulse instances to discover and join this server.'
                : 'The instance owner has not allowed users to make servers federatable.'
            }
          >
            <Switch
              checked={settings.federatable}
              disabled={!canToggleFederatable}
              onCheckedChange={(checked) => onChange('federatable', checked)}
            />
          </Group>
        )}

        <SettingsFormFooter
          onCancel={closeServerScreens}
          onSave={submit}
          saving={loading}
        />
      </CardContent>
    </Card>
  );
});

export { General };
