import { getDisplayName } from '@/helpers/get-display-name';
import { useUserById } from '@/features/server/users/hooks';
import { Forward } from 'lucide-react';
import { memo } from 'react';

/**
 * Non-editable attribution shown above a forwarded message. Both the
 * name and the source author are set SERVER-side at forward time and
 * stored in their own columns, so this can never be edited or faked by
 * rewriting message content — it is not part of the content.
 *
 * The name prefers a live lookup of forwardedFromUserId (so it tracks
 * renames and can go on to link a profile later) and falls back to the
 * stored snapshot, which is the only thing that survives the author's
 * deletion or a federated message arriving from a peer.
 */
type TForwardedFromHeaderProps = {
  forwardedFromUserId: number | null;
  forwardedFromName: string | null;
};

const ForwardedFromHeader = memo(
  ({ forwardedFromUserId, forwardedFromName }: TForwardedFromHeaderProps) => {
    // Hook must run unconditionally; -1 resolves to undefined.
    const liveUser = useUserById(forwardedFromUserId ?? -1);

    if (forwardedFromUserId === null && !forwardedFromName) return null;

    const name = liveUser
      ? getDisplayName(liveUser)
      : (forwardedFromName ?? 'Unknown');

    return (
      <div className="mb-0.5 flex items-center gap-1 text-xs text-muted-foreground">
        <Forward className="h-3 w-3" />
        <span>
          Forwarded from <span className="text-foreground">{name}</span>
        </span>
      </div>
    );
  }
);

ForwardedFromHeader.displayName = 'ForwardedFromHeader';

export { ForwardedFromHeader };
