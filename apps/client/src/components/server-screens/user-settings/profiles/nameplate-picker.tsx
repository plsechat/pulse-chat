import {
  customNameplateStyle,
  NAMEPLATE_PRESETS,
  presetNameplateStyle
} from '@/components/nameplate/presets';
import { UserAvatar } from '@/components/user-avatar';
import { useActiveInstanceDomain } from '@/features/app/hooks';
import { useNameplatePacks } from '@/features/nameplates/hooks';
import { getDisplayName } from '@/helpers/get-display-name';
import { getFileUrl } from '@/helpers/get-file-url';
import { getNameStyleCss } from '@/helpers/name-style';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { getHomeTRPCClient } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import type { TJoinedPublicUser } from '@pulse/shared';
import { NAMEPLATE_PRESET_SLUGS } from '@pulse/shared';
import { Check } from 'lucide-react';
import { memo, useCallback, useState, type CSSProperties } from 'react';
import { toast } from 'sonner';

type TNameplateTileProps = {
  user: TJoinedPublicUser;
  name: string;
  nameCss: ReturnType<typeof getNameStyleCss>;
  label: string;
  style?: CSSProperties;
  animated?: boolean;
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
};

/** Mini row preview — the picker shows each plate exactly as the member
 *  list will render it: the user's avatar (with their equipped
 *  decoration), their styled name, the plate art behind. */
const NameplateTile = memo(
  ({ user, name, nameCss, label, style, animated, selected, disabled, onClick }: TNameplateTileProps) => (
    <button
      type="button"
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'relative h-11 w-full overflow-hidden rounded-md border border-border/60 bg-muted/40 text-left transition-[border-color,box-shadow] duration-100 hover:border-border disabled:opacity-60',
        selected && 'border-transparent ring-2 ring-primary'
      )}
    >
      {style && (
        <div
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-0 opacity-80 dark:opacity-100',
            animated && 'nameplate-animated'
          )}
          style={style}
        />
      )}
      <span className="relative flex h-full items-center gap-2 px-2.5">
        <UserAvatar
          userId={user.id}
          className="h-7 w-7"
          showStatusBadge={false}
        />
        <span
          className={cn(
            'text-xs font-medium text-foreground/90 truncate',
            nameCss?.className
          )}
          style={nameCss?.style}
        >
          {name}
        </span>
      </span>
      {selected && (
        <Check className="absolute right-1.5 top-1.5 h-3.5 w-3.5 text-primary drop-shadow-sm" />
      )}
    </button>
  )
);

type TNameplatePickerProps = {
  user: TJoinedPublicUser;
};

const NameplatePicker = memo(({ user }: TNameplatePickerProps) => {
  const packs = useNameplatePacks();
  const activeInstanceDomain = useActiveInstanceDomain();
  const [saving, setSaving] = useState(false);

  const equipped = user.nameplate ?? null;
  const name = getDisplayName(user);
  const nameCss = getNameStyleCss(user.nameStyle);

  // The selected ring follows user.nameplate, which arrives back via the
  // USER_UPDATE fanout the mutation triggers — no local mirror to drift.
  const equip = useCallback(async (value: string | null) => {
    const trpc = getHomeTRPCClient();
    if (!trpc) return;

    setSaving(true);
    try {
      await trpc.users.setNameplate.mutate({ nameplate: value });
    } catch (err) {
      toast.error(getTrpcError(err, 'Failed to update nameplate'));
    } finally {
      setSaving(false);
    }
  }, []);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <NameplateTile
          user={user}
          name={name}
          nameCss={nameCss}
          label="None"
          selected={equipped === null}
          disabled={saving}
          onClick={() => equip(null)}
        />
        {NAMEPLATE_PRESET_SLUGS.map((slug) => {
          const preset = NAMEPLATE_PRESETS[slug];
          if (!preset) return null;
          return (
            <NameplateTile
              key={slug}
              user={user}
              name={name}
              nameCss={nameCss}
              label={preset.label}
              style={presetNameplateStyle(preset)}
              animated={preset.animated}
              selected={equipped === `preset:${slug}`}
              disabled={saving}
              onClick={() => equip(`preset:${slug}`)}
            />
          );
        })}
      </div>

      {/* Custom pack ids live in the HOME instance's id-space and the
          equip mutation always targets home — while a federated server
          is active the packs store holds the REMOTE server's packs, so
          the section is hidden rather than offering un-equippable art. */}
      {!activeInstanceDomain && packs.length > 0 && (
        <div className="space-y-2">
          <span className="text-xs font-semibold uppercase text-muted-foreground">
            Server nameplates
          </span>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {packs.map((pack) => (
              <NameplateTile
                key={pack.id}
                user={user}
                name={name}
                nameCss={nameCss}
                label={pack.name}
                style={customNameplateStyle(getFileUrl(pack.file))}
                selected={equipped === `custom:${pack.id}`}
                disabled={saving}
                onClick={() => equip(`custom:${pack.id}`)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
});

export { NameplatePicker };
