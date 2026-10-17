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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { SettingsFormFooter } from '@/components/ui/settings-form-footer';
import { Slider } from '@/components/ui/slider';
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
import { validateDirectoryCard } from '@/screens/discover-view/directory-helpers';
import {
  DIRECTORY_DESCRIPTION_MAX_LENGTH,
  DIRECTORY_GAME_MAX_LENGTH,
  DIRECTORY_TAG_MAX_LENGTH,
  DIRECTORY_TAGS_MAX,
  STORAGE_MAX_FILE_SIZE,
  STORAGE_MAX_QUOTA_PER_USER,
  STORAGE_MIN_FILE_SIZE,
  STORAGE_MIN_QUOTA_PER_USER,
  STORAGE_OVERFLOW_ACTIONS_DICT,
  StorageOverflowAction
} from '@pulse/shared';
import { filesize } from 'filesize';
import { memo, useMemo } from 'react';
import { LogoManager } from './logo-manager';

const FILE_SIZE_STEP = 5 * 1024 * 1024; // 5 MB

const formatBytes = (bytes: number) =>
  bytes === 0 ? 'Unlimited' : String(filesize(bytes, { standard: 'jedec' }));

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

  // The directory card: the listing needs an open join path (the route
  // refuses it otherwise), so the switch follows Discoverable + Allow
  // New Users, and turning either off takes the listing with it.
  const canList = settings.discoverable && settings.allowNewUsers;
  const cardErrors = validateDirectoryCard({
    listed: settings.directoryListed,
    description: settings.directoryDescription,
    tagsText: settings.directoryTagsText,
    game: settings.directoryGame,
    discoverable: settings.discoverable,
    allowNewUsers: settings.allowNewUsers
  });

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
            onCheckedChange={(checked) => {
              onChange('allowNewUsers', checked);
              if (!checked) onChange('directoryListed', false);
            }}
          />
        </Group>

        <Group
          label="Discoverable"
          description="Show this server in the Discover directory so anyone can find and join it."
        >
          <Switch
            checked={settings.discoverable}
            onCheckedChange={(checked) => {
              onChange('discoverable', checked);
              if (!checked) onChange('directoryListed', false);
            }}
          />
        </Group>

        <div className="border-t border-border pt-4">
          <h3 className="text-base font-semibold">Public directory</h3>
          <p className="text-sm text-muted-foreground">
            A card on the Directory tab of this instance and, when the server is
            federatable, of its federated peers.
          </p>
        </div>

        <Group
          label="List in the directory"
          description={
            canList
              ? 'Show a card with the description, tags and game below.'
              : 'Turn on Discoverable and Allow New Users first — a listing needs an open way in.'
          }
        >
          <Switch
            checked={settings.directoryListed}
            disabled={!canList}
            aria-label="List in the directory"
            onCheckedChange={(checked) => onChange('directoryListed', checked)}
          />
          {cardErrors.directoryListed && (
            <p className="text-sm text-destructive" role="alert">
              {cardErrors.directoryListed}
            </p>
          )}
        </Group>

        <Group
          label="Directory description"
          description={`What the card says about the community (${settings.directoryDescription.length}/${DIRECTORY_DESCRIPTION_MAX_LENGTH}).`}
        >
          <Textarea
            value={settings.directoryDescription}
            onChange={(e) => onChange('directoryDescription', e.target.value)}
            placeholder="Who you are and what you do together"
            rows={3}
            maxLength={DIRECTORY_DESCRIPTION_MAX_LENGTH}
            aria-label="Directory description"
            error={cardErrors.directoryDescription || errors.directoryDescription}
          />
        </Group>

        <Group
          label="Tags"
          description={`Up to ${DIRECTORY_TAGS_MAX} tags of ${DIRECTORY_TAG_MAX_LENGTH} characters, separated by commas. Searchable.`}
        >
          <Input
            value={settings.directoryTagsText}
            onChange={(e) => onChange('directoryTagsText', e.target.value)}
            placeholder="casual, ranked, weekends"
            aria-label="Directory tags"
            error={cardErrors.directoryTags || errors.directoryTags}
          />
        </Group>

        <Group
          label="Game"
          description="The game or activity the community is about; the Directory filters by it."
        >
          <Input
            value={settings.directoryGame}
            onChange={(e) => onChange('directoryGame', e.target.value)}
            placeholder="Chess"
            maxLength={DIRECTORY_GAME_MAX_LENGTH}
            aria-label="Directory game"
            error={cardErrors.directoryGame || errors.directoryGame}
          />
        </Group>

        <Group
          label="Plugins"
          description="Let members run commands from the plugins enabled on this instance. Which plugins are installed and enabled is managed by the instance owner under Instance → Plugins."
        >
          <Switch
            checked={settings.enablePlugins}
            onCheckedChange={(checked) => onChange('enablePlugins', checked)}
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

        <div className="border-t border-border pt-4">
          <h3 className="text-base font-semibold">Uploads</h3>
          <p className="text-sm text-muted-foreground">
            Limits for files members attach in this server.
          </p>
        </div>

        <Group
          label="Allow uploads"
          description="Let members attach files to messages. Files already uploaded stay available."
        >
          <Switch
            checked={settings.storageUploadEnabled}
            onCheckedChange={(checked) =>
              onChange('storageUploadEnabled', checked)
            }
          />
        </Group>

        <Group
          label="Max file size"
          description="The largest single file a member can upload."
        >
          <Slider
            className="max-w-96"
            value={[settings.storageUploadMaxFileSize]}
            max={STORAGE_MAX_FILE_SIZE}
            min={STORAGE_MIN_FILE_SIZE}
            step={FILE_SIZE_STEP}
            disabled={!settings.storageUploadEnabled}
            onValueChange={([value]) =>
              onChange('storageUploadMaxFileSize', value)
            }
            rightSlot={
              <span className="text-sm tabular-nums">
                {formatBytes(settings.storageUploadMaxFileSize)}
              </span>
            }
          />
        </Group>

        <Group
          label="Quota per member"
          description="How much storage each member may use in total. 0 means unlimited."
        >
          <Slider
            className="max-w-96"
            value={[settings.storageSpaceQuotaByUser]}
            max={STORAGE_MAX_QUOTA_PER_USER}
            min={STORAGE_MIN_QUOTA_PER_USER}
            step={FILE_SIZE_STEP}
            disabled={!settings.storageUploadEnabled}
            onValueChange={([value]) =>
              onChange('storageSpaceQuotaByUser', value)
            }
            rightSlot={
              <span className="text-sm tabular-nums">
                {formatBytes(settings.storageSpaceQuotaByUser)}
              </span>
            }
          />
        </Group>

        <Group
          label="When a quota is exceeded"
          description="What happens to an upload that would push a member over their quota."
        >
          <Select
            value={settings.storageOverflowAction}
            disabled={!settings.storageUploadEnabled}
            onValueChange={(value) =>
              onChange('storageOverflowAction', value as StorageOverflowAction)
            }
          >
            <SelectTrigger className="w-60">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.values(StorageOverflowAction).map((value) => (
                <SelectItem key={value} value={value}>
                  {STORAGE_OVERFLOW_ACTIONS_DICT[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Group>

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
