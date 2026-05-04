import { Button } from '@/components/ui/button';
import { UserAvatar } from '@/components/user-avatar';
import { useUserById } from '@/features/server/users/hooks';
import { getDisplayName } from '@/helpers/get-display-name';
import { fullDateTime } from '@/helpers/time-format';
import {
  computeSafetyNumber,
  formatForDisplay
} from '@/lib/e2ee/safety-number';
import {
  signalStore,
  type VerifiedIdentityEntry
} from '@/lib/e2ee/store';
import { notifyVerifiedIdentityChanged } from '@/lib/e2ee/use-verified-identity';
import { base64ToArrayBuffer } from '@/lib/e2ee/utils';
import { format } from 'date-fns';
import {
  ChevronLeft,
  ShieldCheck,
  ShieldQuestion,
  Trash2
} from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useSelector } from 'react-redux';
import type { IRootState } from '@/features/store';

const ownUserIdSelector = (state: IRootState) => state.server.ownUserId;

const StatusBadge = memo(
  ({ method }: { method: 'tofu' | 'manual' }) => {
    if (method === 'manual') {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-500">
          <ShieldCheck className="h-3 w-3" />
          Verified
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
        <ShieldQuestion className="h-3 w-3" />
        Trusted on first use
      </span>
    );
  }
);

const PeerRow = memo(
  ({
    entry,
    onSelect
  }: {
    entry: VerifiedIdentityEntry;
    onSelect: (userId: number) => void;
  }) => {
    const user = useUserById(entry.userId);
    const name = user ? getDisplayName(user) : `User #${entry.userId}`;

    return (
      <button
        onClick={() => onSelect(entry.userId)}
        className="flex w-full items-center gap-3 rounded-md border border-border bg-card px-3 py-2 text-left transition-colors hover:bg-accent/40"
      >
        {user ? (
          <UserAvatar userId={entry.userId} className="h-8 w-8" />
        ) : (
          <div className="h-8 w-8 rounded-full bg-muted" />
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium">{name}</span>
          <span className="text-xs text-muted-foreground">
            Pinned {format(new Date(entry.verifiedAt), fullDateTime())}
          </span>
        </div>
        <StatusBadge method={entry.verifiedMethod} />
      </button>
    );
  }
);

const PeerDetail = memo(
  ({
    entry,
    onBack,
    onChanged
  }: {
    entry: VerifiedIdentityEntry;
    onBack: () => void;
    onChanged: () => void;
  }) => {
    const user = useUserById(entry.userId);
    const name = user ? getDisplayName(user) : `User #${entry.userId}`;
    const ownUserId = useSelector(ownUserIdSelector);
    const [safetyNumber, setSafetyNumber] = useState<string | null>(null);
    const [working, setWorking] = useState(false);

    useEffect(() => {
      let cancelled = false;
      (async () => {
        const ownKeyPair = await signalStore.getIdentityKeyPair();
        if (!ownKeyPair || ownUserId === undefined) {
          if (!cancelled) setSafetyNumber(null);
          return;
        }
        try {
          const digits = await computeSafetyNumber({
            localUserId: ownUserId,
            localIdentityKey: new Uint8Array(ownKeyPair.pubKey),
            remoteUserId: entry.userId,
            remoteIdentityKey: new Uint8Array(
              base64ToArrayBuffer(entry.identityPublicKey)
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
    }, [entry.identityPublicKey, entry.userId, ownUserId]);

    const handleMarkVerified = useCallback(async () => {
      if (working) return;
      setWorking(true);
      try {
        await signalStore.markIdentityManual(
          entry.userId,
          entry.identityPublicKey
        );
        notifyVerifiedIdentityChanged();
        toast.success(`Marked ${name} as verified`);
        onChanged();
      } catch (err) {
        console.error(err);
        toast.error('Failed to update verification status');
      } finally {
        setWorking(false);
      }
    }, [entry.userId, entry.identityPublicKey, name, onChanged, working]);

    const handleClearPin = useCallback(async () => {
      if (working) return;
      setWorking(true);
      try {
        await signalStore.clearVerifiedIdentity(entry.userId);
        notifyVerifiedIdentityChanged();
        toast.success(`Removed pinned identity for ${name}`);
        onChanged();
        onBack();
      } catch (err) {
        console.error(err);
        toast.error('Failed to clear pinned identity');
      } finally {
        setWorking(false);
      }
    }, [entry.userId, name, onBack, onChanged, working]);

    return (
      <div className="space-y-4">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
          Back to all peers
        </button>

        <div className="flex items-center gap-3">
          {user ? (
            <UserAvatar userId={entry.userId} className="h-10 w-10" />
          ) : (
            <div className="h-10 w-10 rounded-full bg-muted" />
          )}
          <div className="flex flex-col">
            <span className="font-semibold">{name}</span>
            <StatusBadge method={entry.verifiedMethod} />
          </div>
        </div>

        <div className="rounded-md border border-border bg-card p-4">
          <p className="text-xs uppercase tracking-wider text-muted-foreground mb-2">
            Safety number
          </p>
          <pre className="whitespace-pre-wrap break-all font-mono text-base leading-relaxed text-foreground">
            {safetyNumber ?? 'Computing…'}
          </pre>
          <p className="mt-3 text-xs text-muted-foreground">
            Compare this 60-digit number with what {name} sees on their
            device. If they match, the connection is end-to-end secure.
            If they differ, the server may be intercepting your messages.
          </p>
        </div>

        <div className="space-y-2">
          {entry.verifiedMethod === 'tofu' && (
            <Button
              onClick={handleMarkVerified}
              disabled={working || !safetyNumber}
              className="w-full"
            >
              <ShieldCheck className="h-4 w-4 mr-2" />
              {working ? 'Saving…' : 'Mark as verified'}
            </Button>
          )}

          <Button
            variant="ghost"
            onClick={handleClearPin}
            disabled={working}
            className="w-full text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 className="h-4 w-4 mr-2" />
            Forget pinned identity
          </Button>
          <p className="text-xs text-muted-foreground">
            Forgetting clears the pin and will trust whatever key the
            server offers next time. Use only if you intentionally want
            to re-establish from scratch.
          </p>
        </div>
      </div>
    );
  }
);

type TVerifyIdentityProps = {
  initialPeerId?: number;
};

const VerifyIdentity = memo(({ initialPeerId }: TVerifyIdentityProps) => {
  const [entries, setEntries] = useState<VerifiedIdentityEntry[] | null>(
    null
  );
  const [selectedUserId, setSelectedUserId] = useState<number | null>(
    initialPeerId ?? null
  );

  const refresh = useCallback(async () => {
    try {
      const list = await signalStore.listVerifiedIdentities();
      list.sort((a, b) => b.verifiedAt - a.verifiedAt);
      setEntries(list);
    } catch (err) {
      console.error(err);
      setEntries([]);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const selectedEntry = useMemo(
    () =>
      selectedUserId != null
        ? (entries ?? []).find((e) => e.userId === selectedUserId) ?? null
        : null,
    [entries, selectedUserId]
  );

  if (selectedEntry) {
    return (
      <PeerDetail
        entry={selectedEntry}
        onBack={() => setSelectedUserId(null)}
        onChanged={refresh}
      />
    );
  }

  if (entries === null) {
    return (
      <p className="text-sm text-muted-foreground">
        Loading pinned identities…
      </p>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border p-6 text-center">
        <ShieldQuestion className="mx-auto h-8 w-8 text-muted-foreground mb-2" />
        <p className="text-sm font-medium">No pinned identities yet</p>
        <p className="text-xs text-muted-foreground mt-1">
          Once you exchange messages with someone using end-to-end
          encryption, their identity is pinned here automatically.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Each peer below has an identity key pinned on this device. Open
        any of them to see the 60-digit safety number to compare with
        them through a trusted channel (in person, by phone, etc.).
      </p>
      <div className="space-y-1">
        {entries.map((entry) => (
          <PeerRow
            key={entry.userId}
            entry={entry}
            onSelect={setSelectedUserId}
          />
        ))}
      </div>
    </div>
  );
});

export { VerifyIdentity };
