import { useActiveInstanceDomain } from '@/features/app/hooks';
import { useHomeUserById, useUserById } from '@/features/server/users/hooks';
import { getFileUrl } from '@/helpers/get-file-url';
import { getInitialsFromName } from '@/helpers/get-initials-from-name';
import { cn } from '@/lib/utils';
import { AVATAR_DECORATION_SLUGS, UserStatus } from '@pulse/shared';
import { memo } from 'react';
// Use the local AvatarImage wrapper (not the raw radix primitive) so
// the `object-cover object-center` styling lands. Importing directly
// from @radix-ui/react-avatar leaves the <img> with browser-default
// `object-fit: fill`, which warps non-square uploads into a strip on
// the left of the circle — the original "right quarter empty" report.
import { Avatar, AvatarFallback, AvatarImage } from '../ui/avatar';
import { UserPopover } from '../user-popover';
import { UserStatusBadge } from '../user-status';

type TUserAvatarProps = {
  userId: number;
  className?: string;
  showUserPopover?: boolean;
  showStatusBadge?: boolean;
  /**
   * Resolve `userId` in HOME id-space and serve the avatar file from the
   * home instance. REQUIRED on home-scoped surfaces (DM conversations,
   * friends) rendered while a federated server is active: their ids are
   * home ids, but the default ambient lookup reads the REMOTE roster,
   * where the same numeric id is a different person (the federated-DM
   * identity-swap bug).
   */
  homeScope?: boolean;
  /**
   * Skip the avatar-decoration overlay. For tight layouts where the
   * decoration's ~28% overflow would collide with neighbors (overlapping
   * avatar collages etc.). Avatars under 28px never render it anyway.
   */
  noDecoration?: boolean;
  onClick?: () => void;
};

/**
 * Resolve the avatar's pixel size from its `h-N` tailwind class (N * 4px).
 * Only the base (non-responsive) utility counts; no match falls back to
 * the component's default `h-8` (32px).
 */
const resolveAvatarPx = (className?: string) => {
  const match = className?.match(/(?:^|\s)h-(\d+)(?:\s|$)/);
  return match ? Number(match[1]) * 4 : 32;
};

/**
 * Decoration overlay for an avatar. Mount as a sibling of the Avatar
 * inside its `relative` wrapper — the layer is absolutely positioned at
 * 120% of the box (the APNG canvas is 288px with a 240px avatar hole —
 * at 120% the hole matches the avatar exactly) and never affects layout.
 * Unknown slugs
 * render nothing (federated peers are re-validated server-side, but a
 * stale client cache could still hold one).
 */
const AvatarDecoration = memo(
  ({ decoration }: { decoration: string | null | undefined }) => {
    if (!decoration?.startsWith('preset:')) return null;
    const slug = decoration.slice('preset:'.length);
    if (!AVATAR_DECORATION_SLUGS.includes(slug)) return null;

    return (
      <img
        src={`/decorations/${slug}.png`}
        alt=""
        aria-hidden
        draggable={false}
        className="pointer-events-none select-none absolute left-1/2 top-1/2 h-[120%] w-[120%] max-w-none -translate-x-1/2 -translate-y-1/2"
      />
    );
  }
);

const avatarGradients = [
  'from-violet-600 to-indigo-600',
  'from-rose-500 to-orange-500',
  'from-emerald-500 to-teal-500',
  'from-blue-500 to-cyan-500',
  'from-fuchsia-500 to-pink-500',
  'from-amber-500 to-yellow-500',
  'from-sky-500 to-blue-600',
  'from-red-500 to-rose-600'
];

const UserAvatar = memo(
  ({
    userId,
    className,
    showUserPopover = false,
    showStatusBadge = true,
    homeScope = false,
    noDecoration = false,
    onClick
  }: TUserAvatarProps) => {
    const ambientUser = useUserById(userId);
    const homeUser = useHomeUserById(userId);
    const activeInstanceDomain = useActiveInstanceDomain();

    const user = homeScope ? homeUser : ambientUser;
    // Home-scoped avatars are files on the HOME instance — never route
    // them through the active federated instance's public route.
    const fileInstanceDomain = homeScope
      ? undefined
      : (activeInstanceDomain ?? undefined);

    if (!user) return null;

    // Decorations only render where the avatar is big enough to carry
    // them (>= 28px); the status badge mounts after so it paints on top.
    const showDecoration = !noDecoration && resolveAvatarPx(className) >= 28;

    const content = (
      <div className="relative w-fit h-fit" onClick={onClick}>
        <Avatar className={cn('h-8 w-8 ring-1 ring-border/50 shadow-sm', className)}>
          <AvatarImage src={getFileUrl(user.avatar, fileInstanceDomain)} key={user.avatarId} />
          <AvatarFallback className={cn('text-xs text-white bg-gradient-to-br', avatarGradients[userId % avatarGradients.length])}>
            {getInitialsFromName(user.name)}
          </AvatarFallback>
        </Avatar>
        {showDecoration && <AvatarDecoration decoration={user.avatarDecoration} />}
        {showStatusBadge && (
          <UserStatusBadge
            status={user.status || UserStatus.OFFLINE}
            className="absolute bottom-0 right-0"
          />
        )}
      </div>
    );

    if (!showUserPopover) return content;

    // Forward the scope: a correctly home-resolved avatar wrapping an
    // ambient-resolved popover would show the WRONG identity on click.
    return (
      <UserPopover userId={userId} homeScope={homeScope}>
        {content}
      </UserPopover>
    );
  }
);

export { AvatarDecoration, UserAvatar };
