import { Switch } from '@/components/ui/switch';
import { useFederatedServers, useJoinedServers } from '@/features/app/hooks';
import {
  federatedServerKey,
  usePresenceSettings,
  type HiddenServerKey
} from '@/hooks/use-presence-settings';
import { cn } from '@/lib/utils';
import { Gamepad2 } from 'lucide-react';
import { memo, useMemo } from 'react';
import { SettingRow, SettingRowStack, SettingsSection } from './settings-primitives';

type TCommunityRow = {
  key: HiddenServerKey;
  name: string;
  /** The instance a federated community lives on; absent for home servers. */
  instanceDomain?: string;
};

/**
 * User Settings → Privacy. Game presence is off until the person turns
 * it on here; the per-community list lets them keep it off where it does
 * not belong. Detection itself runs in the desktop app — the switch is
 * an account preference, so flipping it in a browser still governs the
 * desktop app signed in as the same account.
 */
const Privacy = memo(() => {
  const { settings, setShareGame, setServerHidden } = usePresenceSettings();
  const joinedServers = useJoinedServers();
  const federatedServers = useFederatedServers();
  const inDesktopApp = !!window.pulseDesktop?.isElectron;

  const communities = useMemo<TCommunityRow[]>(
    () => [
      ...joinedServers.map((server) => ({ key: server.id, name: server.name })),
      ...federatedServers.map((entry) => ({
        key: federatedServerKey(entry.instanceDomain, entry.server.publicId),
        name: entry.server.name,
        instanceDomain: entry.instanceDomain
      }))
    ],
    [joinedServers, federatedServers]
  );

  const hidden = useMemo(
    () => new Set<HiddenServerKey>(settings.hiddenServers),
    [settings.hiddenServers]
  );

  return (
    <div className="space-y-6">
      <SettingsSection
        title="Game presence"
        description="Let the communities you are in see what you are playing. Detected by the desktop app; nothing is shared until you turn this on."
      >
        <SettingRow
          label="Share what you're playing"
          description={
            inDesktopApp
              ? 'Shows "Playing …" under your name and lists you under Now playing in the members pane.'
              : 'Applies to the desktop app signed in as you. This browser cannot detect games.'
          }
        >
          <Switch
            checked={settings.shareGame}
            onCheckedChange={setShareGame}
            aria-label="Share what you're playing"
          />
        </SettingRow>
        <SettingRowStack
          label="Keep it private in these communities"
          description={
            communities.length === 0
              ? 'Join a community to choose where your game stays hidden.'
              : 'Checked communities never see what you are playing, even while sharing is on.'
          }
        >
          {communities.length > 0 && (
            <ul
              className={cn(
                'divide-y divide-border/60 rounded-md border border-border/60',
                !settings.shareGame && 'opacity-60'
              )}
            >
              {communities.map((community) => {
                const isHidden = hidden.has(community.key);
                const id = `hide-game-${String(community.key).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
                return (
                  <li key={String(community.key)}>
                    <label
                      htmlFor={id}
                      className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-accent/40"
                    >
                      <input
                        id={id}
                        type="checkbox"
                        className="h-4 w-4 shrink-0 accent-primary"
                        checked={isHidden}
                        onChange={(event) =>
                          setServerHidden(community.key, event.target.checked)
                        }
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {community.name}
                        {community.instanceDomain && (
                          <span className="ml-1.5 text-xs text-muted-foreground">
                            @{community.instanceDomain}
                          </span>
                        )}
                      </span>
                      {isHidden && (
                        <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                          <Gamepad2 className="h-3 w-3" aria-hidden />
                          hidden
                        </span>
                      )}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </SettingRowStack>
      </SettingsSection>
    </div>
  );
});

export { Privacy };
