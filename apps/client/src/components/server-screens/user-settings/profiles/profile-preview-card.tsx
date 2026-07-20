import { NameplateBackground } from '@/components/nameplate';
import { UserAvatar } from '@/components/user-avatar';
import { getFileUrl } from '@/helpers/get-file-url';
import { getNameStyleCss } from '@/helpers/name-style';
import { cn } from '@/lib/utils';
import type { TJoinedPublicUser } from '@pulse/shared';
import { memo } from 'react';

type TProfilePreviewCardProps = {
  /**
   * The own user with any PENDING edits overlaid (bannerColor / bio /
   * pronouns form values, drafted nameStyle). Avatar, banner image,
   * decoration and nameplate are instant-equip, so UserAvatar and the
   * file refs read the live store values.
   */
  user: TJoinedPublicUser;
};

/** Faithful profile-card mock — mirrors the UserPopover's card zones. */
const ProfilePreviewCard = memo(({ user }: TProfilePreviewCardProps) => {
  const nameCss = getNameStyleCss(user.nameStyle);

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      {user.banner ? (
        <div
          className="h-24 w-full bg-cover bg-center bg-no-repeat"
          style={{ backgroundImage: `url(${getFileUrl(user.banner)})` }}
        />
      ) : (
        <div
          className="h-24 w-full"
          style={{ background: user.bannerColor || 'var(--primary)' }}
        />
      )}

      <div className="px-4 pb-4">
        <div className="-mt-8 w-fit">
          <UserAvatar
            userId={user.id}
            className="h-16 w-16 border-4 border-card"
            showStatusBadge={false}
          />
        </div>

        <h3
          className={cn(
            'mt-2 truncate text-lg font-bold text-foreground',
            nameCss?.className
          )}
          style={nameCss?.style}
        >
          {user.name}
        </h3>
        {user.pronouns && (
          <p className="mt-0.5 text-xs text-muted-foreground">
            {user.pronouns}
          </p>
        )}
        {(user.customStatus || user.customStatusEmoji) && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {user.customStatusEmoji && (
              <span className="mr-1">{user.customStatusEmoji}</span>
            )}
            {user.customStatus}
          </p>
        )}

        {user.bio && (
          <div className="mt-3">
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              About Me
            </p>
            <p className="text-sm leading-relaxed text-foreground">
              {user.bio}
            </p>
          </div>
        )}

        {user.nameplate && (
          <div className="mt-3">
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Nameplate
            </p>
            {/* Mock member-list row — plain name on purpose: nameplates
                show in member lists, where role colors (not name styles)
                stay authoritative. */}
            <div className="relative h-10 overflow-hidden rounded-md border border-border/60 bg-muted/40">
              <NameplateBackground nameplate={user.nameplate} />
              <div className="relative flex h-full items-center gap-2 px-2.5">
                <UserAvatar
                  userId={user.id}
                  className="h-6 w-6"
                  showStatusBadge={false}
                />
                <span className="truncate text-sm font-medium text-foreground/90">
                  {user.name}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

export { ProfilePreviewCard };
