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
import { getTRPCClient } from '@/lib/trpc';
import {
  SCREEN_FRAMERATES,
  SCREEN_RESOLUTIONS,
  type TScreenResolution
} from '@pulse/shared';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

type TScreenLimits = {
  maxResolution: string;
  maxFramerate: number;
};

/**
 * Instance-global screen-share ceiling. Members can pick any quality at or
 * below these caps; the client clamps its capture to them. Resolution is
 * never seen by the media server, so the cap is honored by the client
 * rather than enforced at the wire — a resource/quality guardrail.
 */
const InstanceScreenSharing = () => {
  const [data, setData] = useState<TScreenLimits | null>(null);
  const [saving, setSaving] = useState(false);

  const fetchLimits = useCallback(async () => {
    const trpc = getTRPCClient();
    if (!trpc) return;
    setData(await trpc.admin.getScreenLimits.query());
  }, []);

  useEffect(() => {
    fetchLimits();
  }, [fetchLimits]);

  const save = useCallback(async (next: TScreenLimits) => {
    const trpc = getTRPCClient();
    if (!trpc) return;
    setSaving(true);
    try {
      await trpc.admin.setScreenLimits.mutate({
        maxResolution: next.maxResolution as TScreenResolution,
        maxFramerate: next.maxFramerate
      });
      setData(next);
      toast.success('Screen-share limits updated');
    } catch {
      toast.error('Could not update screen-share limits');
    } finally {
      setSaving(false);
    }
  }, []);

  if (!data) return null;

  return (
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
  );
};

export { InstanceScreenSharing };
