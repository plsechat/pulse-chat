import {
  SettingRow,
  SettingsSection
} from '@/components/server-screens/user-settings/settings-primitives';
import { Switch } from '@/components/ui/switch';
import { useAdminQuery } from '@/features/server/admin/hooks';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { getTRPCClient } from '@/lib/trpc';
import { useState } from 'react';
import { toast } from 'sonner';
import { QueryState } from '../query-state';

type TRegistration = {
  allowNewUsers: boolean;
  registrationDisabledByEnv: boolean;
  methods: { password: boolean; oidc: boolean; social: boolean };
  directory: { exposed: boolean; federationEnabled: boolean; effective: boolean };
};

const METHOD_LABELS: Record<keyof TRegistration['methods'], string> = {
  password: 'Email & password',
  oidc: 'Single Sign-On (OIDC)',
  social: 'Social providers'
};

const fetchRegistration = async (): Promise<TRegistration> => {
  const trpc = getTRPCClient();
  if (!trpc) throw new Error('Not connected');
  return trpc.admin.getRegistration.query();
};

/**
 * Instance registration policy. The toggle is the settings-table
 * allowNewUsers gate on /register; the per-method switches and the
 * REGISTRATION_DISABLED kill-switch live in the environment, so they
 * render read-only here.
 */
const InstanceRegistration = () => {
  const query = useAdminQuery(
    fetchRegistration,
    'Could not load the registration policy'
  );
  const [saving, setSaving] = useState(false);
  const [savingDirectory, setSavingDirectory] = useState(false);

  const toggleDirectory = async (exposeDirectory: boolean) => {
    const trpc = getTRPCClient();
    if (!trpc) return;
    setSavingDirectory(true);
    try {
      await trpc.admin.setRegistration.mutate({ exposeDirectory });
      await query.refetch();
      toast.success(
        exposeDirectory
          ? 'Peers can read the directory'
          : 'The directory is no longer offered to peers'
      );
    } catch (err) {
      toast.error(getTrpcError(err, 'Could not update the directory setting'));
    } finally {
      setSavingDirectory(false);
    }
  };

  const toggle = async (allowNewUsers: boolean) => {
    const trpc = getTRPCClient();
    if (!trpc) return;
    setSaving(true);
    try {
      await trpc.admin.setRegistration.mutate({ allowNewUsers });
      await query.refetch();
      toast.success(
        allowNewUsers ? 'Registration opened' : 'Registration closed'
      );
    } catch (err) {
      toast.error(getTrpcError(err, 'Could not update registration'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <QueryState query={query}>
      {(data) => (
        <div className="space-y-6">
          <SettingsSection
            title="New accounts"
            description="Whether people can create accounts on this instance. A valid invite always works as a break-glass path."
          >
            <SettingRow
              label="Allow new registrations"
              description={
                data.registrationDisabledByEnv
                  ? 'Currently overridden: REGISTRATION_DISABLED is set in the environment, so registration is off regardless of this toggle.'
                  : 'Turn off to make this instance invite-only.'
              }
            >
              <Switch
                checked={data.allowNewUsers}
                disabled={saving}
                onCheckedChange={toggle}
              />
            </SettingRow>
          </SettingsSection>

          <SettingsSection
            title="Public directory"
            description="Servers listed under Server Settings → General make up this instance's directory. Federated peers pull it daily for their own Directory tab."
          >
            <SettingRow
              label="Expose this instance's directory to peers"
              description={
                data.directory.federationEnabled
                  ? 'Off, peers get an empty listing; your members still see the local directory and the peers\' listings.'
                  : 'Federation is off, so nothing is offered to anyone; the switch applies once federation is enabled.'
              }
            >
              <Switch
                checked={data.directory.exposed}
                disabled={savingDirectory || !data.directory.federationEnabled}
                aria-label="Expose this instance's directory to peers"
                onCheckedChange={toggleDirectory}
              />
            </SettingRow>
          </SettingsSection>

          <SettingsSection
            title="Sign-up methods"
            description="Configured through the server environment (REGISTRATION_*_ENABLED) — shown here so the effective policy is visible in one place."
          >
            {(
              Object.keys(METHOD_LABELS) as (keyof TRegistration['methods'])[]
            ).map((method) => (
              <SettingRow key={method} label={METHOD_LABELS[method]}>
                <span className="text-sm text-muted-foreground">
                  {data.methods[method] ? 'Enabled' : 'Disabled'}
                </span>
              </SettingRow>
            ))}
          </SettingsSection>
        </div>
      )}
    </QueryState>
  );
};

export { InstanceRegistration };
