import {
  SettingRow,
  SettingsSection
} from '@/components/server-screens/user-settings/settings-primitives';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { useAdminQuery } from '@/features/server/admin/hooks';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { getTRPCClient } from '@/lib/trpc';
import {
  SCREEN_FRAMERATES,
  SCREEN_RESOLUTIONS,
  type TScreenResolution
} from '@pulse/shared';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { QueryState } from '../query-state';

type TScreenLimits = {
  maxResolution: string;
  maxFramerate: number;
};

const fetchLimits = async (): Promise<TScreenLimits> => {
  const trpc = getTRPCClient();
  if (!trpc) throw new Error('Not connected');
  return trpc.admin.getScreenLimits.query();
};

/**
 * Instance-global screen-share ceiling. Members can pick any quality at or
 * below these caps; the client clamps its capture to them. Resolution is
 * never seen by the media server, so the cap is honored by the client
 * rather than enforced at the wire — a resource/quality guardrail.
 */
const InstanceScreenSharing = () => {
  const query = useAdminQuery(
    fetchLimits,
    'Could not load the screen-share limits'
  );
  const [saving, setSaving] = useState(false);
  const { refetch } = query;

  const save = useCallback(
    async (next: TScreenLimits) => {
      const trpc = getTRPCClient();
      if (!trpc) return;
      setSaving(true);
      try {
        await trpc.admin.setScreenLimits.mutate({
          maxResolution: next.maxResolution as TScreenResolution,
          maxFramerate: next.maxFramerate
        });
        await refetch();
        toast.success('Screen-share limits updated');
      } catch (err) {
        toast.error(getTrpcError(err, 'Could not update screen-share limits'));
      } finally {
        setSaving(false);
      }
    },
    [refetch]
  );

  return (
    <QueryState query={query}>
      {(data) => (
        <div className="space-y-6">
          <SettingsSection
            title="Screen-share quality ceiling"
            description="The highest quality members may stream. Everyone can still choose any resolution and framerate at or below these — raise them to allow sharper streams, lower them to cap bandwidth and server load."
          >
            <SettingRow
              label="Maximum resolution"
              description="The top resolution offered in the Stream Quality menu."
            >
              <Select
                value={data.maxResolution}
                disabled={saving}
                onValueChange={(v) => save({ ...data, maxResolution: v })}
              >
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SCREEN_RESOLUTIONS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingRow>

            <SettingRow
              label="Maximum framerate"
              description="The top framerate offered in the Stream Quality menu."
            >
              <Select
                value={String(data.maxFramerate)}
                disabled={saving}
                onValueChange={(v) => save({ ...data, maxFramerate: Number(v) })}
              >
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SCREEN_FRAMERATES.map((f) => (
                    <SelectItem key={f} value={String(f)}>
                      {f} FPS
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingRow>
          </SettingsSection>
        </div>
      )}
    </QueryState>
  );
};

export { InstanceScreenSharing };
