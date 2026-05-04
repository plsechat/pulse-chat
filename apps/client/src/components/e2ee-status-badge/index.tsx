import { Tooltip } from '@/components/ui/tooltip';
import { useVerifiedIdentity } from '@/lib/e2ee/use-verified-identity';
import { AlertTriangle, Lock, ShieldCheck } from 'lucide-react';
import { memo } from 'react';

type TE2EEStatusBadgeProps = {
  /** Single-peer scope (1:1 DM). Omit for group/channel — those render
   *  the generic encrypted lock since per-pair safety numbers don't
   *  collapse into a single header indicator. */
  peerUserId?: number;
  size?: 'sm' | 'md';
};

const E2EEStatusBadge = memo(
  ({ peerUserId, size = 'md' }: TE2EEStatusBadgeProps) => {
    const sizeClass = size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5';
    const verified = useVerifiedIdentity(peerUserId ?? null);

    if (peerUserId == null) {
      return (
        <Tooltip content="End-to-end encrypted">
          <Lock className={`${sizeClass} text-emerald-500 flex-shrink-0`} />
        </Tooltip>
      );
    }

    // "Recently changed" warning takes precedence over the verified-
    // method tier — even if the pin is technically TOFU now, the
    // user just accepted a change and should be reminded to verify
    // out-of-band.
    if (verified?.acceptedChangeAt) {
      return (
        <Tooltip content="Identity changed recently · verify out-of-band">
          <AlertTriangle
            className={`${sizeClass} text-amber-500 flex-shrink-0`}
          />
        </Tooltip>
      );
    }

    if (verified?.verifiedMethod === 'manual') {
      return (
        <Tooltip content="End-to-end encrypted · identity verified">
          <ShieldCheck
            className={`${sizeClass} text-emerald-500 flex-shrink-0`}
          />
        </Tooltip>
      );
    }

    const tooltip =
      verified?.verifiedMethod === 'tofu'
        ? 'End-to-end encrypted · trusted on first use'
        : 'End-to-end encrypted';
    return (
      <Tooltip content={tooltip}>
        <Lock className={`${sizeClass} text-emerald-500 flex-shrink-0`} />
      </Tooltip>
    );
  }
);

/**
 * Compact dot/icon for member-list scenarios. Highlights two cases
 * the user might want to act on at a glance:
 *  - manually verified → green check (positive signal)
 *  - recently accepted an identity change → amber triangle (review!)
 * Plain TOFU stays silent so the member list isn't cluttered with
 * the default state.
 */
const VerifiedMemberDot = memo(
  ({ userId }: { userId: number }) => {
    const verified = useVerifiedIdentity(userId);
    if (verified?.acceptedChangeAt) {
      return (
        <Tooltip content="Identity changed recently">
          <AlertTriangle className="h-3 w-3 text-amber-500 shrink-0" />
        </Tooltip>
      );
    }
    if (verified?.verifiedMethod !== 'manual') return null;
    return (
      <Tooltip content="Identity verified">
        <ShieldCheck className="h-3 w-3 text-emerald-500 shrink-0" />
      </Tooltip>
    );
  }
);

export { E2EEStatusBadge, VerifiedMemberDot };
