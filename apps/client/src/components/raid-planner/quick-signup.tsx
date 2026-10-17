import { Button } from '@/components/ui/button';
import {
  openEvent,
  signupForEvent,
  withdrawFromEvent
} from '@/features/events/actions';
import { eventIsOpen, isSignedUp, roleLabel } from '@/features/events/roster';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import type { TEventListItem } from '@pulse/server/types';
import { memo, useCallback, useState } from 'react';
import { toast } from 'sonner';

/**
 * The one-tap RSVP used by agenda cards and the chat card: a single-role
 * event signs the viewer up straight away; with several roles the sheet
 * opens so they can pick one. Signed-up viewers get Withdraw.
 */
const QuickSignup = memo(
  ({
    item,
    size = 'sm'
  }: {
    item: TEventListItem;
    size?: 'sm' | 'default';
  }) => {
    const [busy, setBusy] = useState(false);
    const signedUp = isSignedUp(item.ownSignup);

    const run = useCallback(
      async (task: () => Promise<unknown>, fallback: string) => {
        setBusy(true);
        try {
          await task();
        } catch (err) {
          toast.error(getTrpcError(err, fallback));
        } finally {
          setBusy(false);
        }
      },
      []
    );

    if (!eventIsOpen(item)) return null;

    if (signedUp) {
      return (
        <Button
          type="button"
          size={size}
          variant="outline"
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation();
            void run(() => withdrawFromEvent(item.id), 'Failed to withdraw');
          }}
        >
          Withdraw
        </Button>
      );
    }

    const onlyRole = item.roles.length === 1 ? item.roles[0] : undefined;

    return (
      <Button
        type="button"
        size={size}
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          if (onlyRole) {
            void run(
              () => signupForEvent(item.id, onlyRole.key),
              'Failed to sign up'
            );
          } else {
            openEvent(item.id);
          }
        }}
      >
        {onlyRole
          ? `Sign up as ${roleLabel(item.roles, onlyRole.key)}`
          : 'Sign up'}
      </Button>
    );
  }
);

export { QuickSignup };
