import { getFileUrl } from '@/helpers/get-file-url';
import { getInitialsFromName } from '@/helpers/get-initials-from-name';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { getHomeTRPCClient } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import type { TJoinedPublicUser } from '@pulse/shared';
import { AVATAR_DECORATION_SLUGS } from '@pulse/shared';
import { Check } from 'lucide-react';
import { memo, useCallback, useState } from 'react';
import { toast } from 'sonner';

const DECORATION_LABELS: Record<string, string> = {
  mists: 'Lurker',
  flames: 'Ablaze',
  halo: 'Angel',
  orbit: 'Orbit',
  thorns: 'Briar Rose',
  frost: 'Frostbite',
  petals: 'Sakura',
  neonring: 'Neon Vibes',
  stardust: 'Moonlit',
  glitchring: 'Corrupted',
  koifish: 'Koi Pond',
  crown: 'Crown'
};

type TDecorationTileProps = {
  user: TJoinedPublicUser;
  label: string;
  /** Preset slug; omitted for the "None" tile. */
  slug?: string;
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
};

/** The user's own avatar with THIS tile's decoration composed on top.
 *  Layered manually (not via UserAvatar) so every tile can preview its
 *  own art instead of whichever decoration is currently equipped. */
const DecorationTile = memo(
  ({ user, label, slug, selected, disabled, onClick }: TDecorationTileProps) => {
    const avatarUrl = getFileUrl(user.avatar);

    return (
      <button
        type="button"
        title={label}
        onClick={onClick}
        disabled={disabled}
        className={cn(
          'relative flex flex-col items-center gap-1.5 rounded-md border border-border/60 bg-muted/40 p-3 pt-4 transition-[border-color,box-shadow] duration-100 hover:border-border disabled:opacity-60',
          selected && 'border-transparent ring-2 ring-primary'
        )}
      >
        <span className="relative block h-14 w-14">
          <span className="block h-full w-full overflow-hidden rounded-full bg-muted ring-1 ring-border/50">
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt=""
                className="h-full w-full object-cover object-center"
              />
            ) : (
              <span className="flex h-full w-full items-center justify-center text-sm font-medium text-muted-foreground">
                {getInitialsFromName(user.name)}
              </span>
            )}
          </span>
          {slug && (
            // 120% of the avatar box, centered — matches how UserAvatar
            // renders the equipped decoration (288 canvas / 240 avatar).
            <img
              src={`/decorations/${slug}.png`}
              alt=""
              aria-hidden
              className="pointer-events-none absolute left-1/2 top-1/2 h-[120%] w-[120%] max-w-none -translate-x-1/2 -translate-y-1/2"
            />
          )}
        </span>
        <span className="max-w-full truncate text-xs font-medium text-foreground/90">
          {label}
        </span>
        {selected && (
          <Check className="absolute right-1.5 top-1.5 h-3.5 w-3.5 text-primary drop-shadow-sm" />
        )}
      </button>
    );
  }
);

type TAvatarDecorationPickerProps = {
  user: TJoinedPublicUser;
};

const AvatarDecorationPicker = memo(({ user }: TAvatarDecorationPickerProps) => {
  const [saving, setSaving] = useState(false);

  const equipped = user.avatarDecoration ?? null;

  // The selected ring follows user.avatarDecoration, which arrives back
  // via the USER_UPDATE fanout the mutation triggers — no local mirror
  // to drift (same pattern as NameplatePicker).
  const equip = useCallback(async (value: string | null) => {
    const trpc = getHomeTRPCClient();
    if (!trpc) return;

    setSaving(true);
    try {
      await trpc.users.setAvatarDecoration.mutate({ decoration: value });
    } catch (err) {
      toast.error(getTrpcError(err, 'Failed to update avatar decoration'));
    } finally {
      setSaving(false);
    }
  }, []);

  return (
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
      <DecorationTile
        user={user}
        label="None"
        selected={equipped === null}
        disabled={saving}
        onClick={() => equip(null)}
      />
      {AVATAR_DECORATION_SLUGS.map((slug) => (
        <DecorationTile
          key={slug}
          user={user}
          slug={slug}
          label={DECORATION_LABELS[slug] ?? slug}
          selected={equipped === `preset:${slug}`}
          disabled={saving}
          onClick={() => equip(`preset:${slug}`)}
        />
      ))}
    </div>
  );
});

export { AvatarDecorationPicker };
