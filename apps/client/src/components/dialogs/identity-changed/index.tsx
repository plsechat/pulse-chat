import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { useUserById } from '@/features/server/users/hooks';
import { getDisplayName } from '@/helpers/get-display-name';
import { fullDateTime } from '@/helpers/time-format';
import {
  computeSafetyNumber,
  formatForDisplay
} from '@/lib/e2ee/safety-number';
import type { VerifiedIdentityMethod } from '@/lib/e2ee/store';
import { base64ToArrayBuffer } from '@/lib/e2ee/utils';
import { format } from 'date-fns';
import { AlertTriangle } from 'lucide-react';
import { memo, useEffect, useState } from 'react';
import type { TDialogBaseProps } from '../types';

type TIdentityChangedDialogProps = TDialogBaseProps & {
  userId: number;
  newIdentityKey: string;
  previousIdentityKey?: string;
  previouslyVerifiedAt?: number;
  previousMethod?: VerifiedIdentityMethod | null;
  localUserId: number | null;
  localIdentityKey: string | null;
  onAccept: () => void | Promise<void>;
  onVerifyNow: () => void | Promise<void>;
  onBlock: () => void | Promise<void>;
};

const IdentityChangedDialog = memo(
  ({
    isOpen,
    userId,
    newIdentityKey,
    previousIdentityKey,
    previouslyVerifiedAt,
    previousMethod,
    localUserId,
    localIdentityKey,
    onAccept,
    onVerifyNow,
    onBlock
  }: TIdentityChangedDialogProps) => {
    const user = useUserById(userId);
    const [safetyNumber, setSafetyNumber] = useState<string | null>(null);
    const [busy, setBusy] = useState<'accept' | 'verify' | 'block' | null>(
      null
    );

    const peerName = user
      ? getDisplayName(user)
      : `User #${userId}`;
    const wasManual = previousMethod === 'manual';

    useEffect(() => {
      if (
        localUserId === null ||
        !localIdentityKey ||
        !newIdentityKey
      ) {
        setSafetyNumber(null);
        return;
      }
      let cancelled = false;
      (async () => {
        try {
          const digits = await computeSafetyNumber({
            localUserId,
            localIdentityKey: new Uint8Array(
              base64ToArrayBuffer(localIdentityKey)
            ),
            remoteUserId: userId,
            remoteIdentityKey: new Uint8Array(
              base64ToArrayBuffer(newIdentityKey)
            )
          });
          if (!cancelled) setSafetyNumber(formatForDisplay(digits));
        } catch (err) {
          console.error('Failed to compute safety number:', err);
          if (!cancelled) setSafetyNumber(null);
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [localUserId, localIdentityKey, newIdentityKey, userId]);

    const wrap = (
      action: 'accept' | 'verify' | 'block',
      handler: () => void | Promise<void>
    ) => async () => {
      if (busy) return;
      setBusy(action);
      try {
        await handler();
      } finally {
        setBusy(null);
      }
    };

    return (
      <AlertDialog open={isOpen}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              {peerName}'s identity has changed
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-2 pt-1">
              <span className="block">
                A new encryption key for{' '}
                <span className="font-semibold text-foreground">{peerName}</span>{' '}
                arrived from the server. This is expected if they reset their
                keys, signed in on a new device, or reinstalled. It is also
                what a malicious server would do to read your messages.
              </span>
              {wasManual && previouslyVerifiedAt && (
                <span className="block text-destructive font-medium">
                  ⚠ You verified this peer in person on{' '}
                  {format(new Date(previouslyVerifiedAt), fullDateTime())}.
                  An identity change after manual verification is high
                  suspicion — do not accept without re-verifying.
                </span>
              )}
              {!wasManual && previouslyVerifiedAt && (
                <span className="block text-muted-foreground text-xs">
                  Previously trusted on first use{' '}
                  {format(new Date(previouslyVerifiedAt), fullDateTime())}.
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="my-2 space-y-1">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">
              New safety number
            </p>
            <div className="rounded-md border bg-muted/30 p-3 font-mono text-sm leading-relaxed text-foreground">
              {safetyNumber ?? (
                <span className="text-muted-foreground italic">
                  Computing…
                </span>
              )}
            </div>
            {previousIdentityKey && previousIdentityKey !== newIdentityKey && (
              <p className="text-xs text-muted-foreground pt-1">
                The pinned key is different from the one the server is now
                offering. Compare this number with{' '}
                <span className="font-semibold">{peerName}</span> through a
                trusted channel before accepting.
              </p>
            )}
          </div>

          <AlertDialogFooter className="gap-2 sm:flex-col sm:items-stretch sm:space-x-0">
            <Button
              variant="default"
              onClick={wrap('verify', onVerifyNow)}
              disabled={busy !== null}
            >
              Verify now
            </Button>
            <Button
              variant="outline"
              onClick={wrap('accept', onAccept)}
              disabled={busy !== null}
            >
              {busy === 'accept' ? 'Accepting…' : 'Accept new identity'}
            </Button>
            <Button
              variant="ghost"
              className="text-destructive hover:text-destructive hover:bg-destructive/10"
              onClick={wrap('block', onBlock)}
              disabled={busy !== null}
            >
              {busy === 'block' ? 'Blocking…' : 'Block this user'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }
);

export default IdentityChangedDialog;
