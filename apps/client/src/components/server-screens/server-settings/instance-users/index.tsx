import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { requestConfirmation } from '@/features/dialogs/actions';
import { getTRPCClient } from '@/lib/trpc';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

const PAGE_SIZE = 50;

type TAdminUserRow = {
  id: number;
  publicId: string;
  name: string;
  banned: boolean;
  banReason: string | null;
  bannedAt: number | null;
  deletedAt: number | null;
  isFederated: boolean;
  createdAt: number;
};

/**
 * Instance user directory — every account on the instance, including
 * banned users, federated shadows, and deleted tombstones. Actions are
 * instance-wide (admin router), unlike the per-server moderation in
 * the Users tab.
 */
const InstanceUsers = () => {
  const [rows, setRows] = useState<TAdminUserRow[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);

  const fetchUsers = useCallback(async () => {
    const trpc = getTRPCClient();
    if (!trpc) return;
    setLoading(true);
    try {
      const result = await trpc.admin.listUsers.query({
        search: query || undefined,
        offset,
        limit: PAGE_SIZE
      });
      setRows(result.users);
      setTotal(result.total);
    } finally {
      setLoading(false);
    }
  }, [query, offset]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const act = async (
    user: TAdminUserRow,
    action: 'ban' | 'unban' | 'delete'
  ) => {
    const prompts = {
      ban: {
        title: `Ban ${user.name}?`,
        message:
          'This bans the account from the entire instance — every server, DMs, everything — and disconnects them immediately.',
        confirmLabel: 'Ban'
      },
      unban: {
        title: `Unban ${user.name}?`,
        message: 'The account can sign in and use the instance again.',
        confirmLabel: 'Unban'
      },
      delete: {
        title: `Delete ${user.name}'s account?`,
        message:
          'This permanently anonymizes the account: profile scrubbed, relationships removed, sign-in severed. Their messages remain, authored by "Deleted User". This cannot be undone.',
        confirmLabel: 'Delete account'
      }
    } as const;

    const confirmed = await requestConfirmation({
      ...prompts[action],
      cancelLabel: 'Cancel'
    });
    if (!confirmed) return;

    const trpc = getTRPCClient();
    if (!trpc) return;
    setBusyId(user.id);
    try {
      if (action === 'ban') await trpc.admin.banUser.mutate({ userId: user.id });
      if (action === 'unban')
        await trpc.admin.unbanUser.mutate({ userId: user.id });
      if (action === 'delete')
        await trpc.admin.deleteUser.mutate({ userId: user.id });
      toast.success(
        action === 'ban'
          ? 'User banned'
          : action === 'unban'
            ? 'User unbanned'
            : 'Account deleted'
      );
      await fetchUsers();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Action failed'
      );
    } finally {
      setBusyId(null);
    }
  };

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setOffset(0);
          setQuery(search.trim());
        }}
      >
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name"
          className="max-w-xs"
        />
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </form>

      <div className="rounded-lg border border-border bg-muted/20 divide-y divide-border/60">
        {rows.map((user) => (
          <div
            key={user.id}
            className="flex items-center gap-3 px-4 py-2.5 text-sm"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate font-medium">{user.name}</span>
                {user.deletedAt ? (
                  <Badge variant="outline">Deleted</Badge>
                ) : null}
                {user.banned ? (
                  <Badge
                    variant="destructive"
                    title={user.banReason ?? undefined}
                  >
                    Banned
                  </Badge>
                ) : null}
                {user.isFederated ? (
                  <Badge variant="secondary">Federated</Badge>
                ) : null}
              </div>
              <div className="text-xs text-muted-foreground">
                {user.publicId.slice(0, 12)} · joined{' '}
                {new Date(user.createdAt).toLocaleDateString()}
              </div>
            </div>
            {!user.deletedAt && (
              <div className="flex shrink-0 gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busyId === user.id}
                  onClick={() => act(user, user.banned ? 'unban' : 'ban')}
                >
                  {user.banned ? 'Unban' : 'Ban'}
                </Button>
                {!user.isFederated && (
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={busyId === user.id}
                    onClick={() => act(user, 'delete')}
                  >
                    Delete
                  </Button>
                )}
              </div>
            )}
          </div>
        ))}
        {!loading && rows.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            No accounts match this search.
          </div>
        )}
      </div>

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>
          {total} account{total === 1 ? '' : 's'} · page {page} of {pageCount}
        </span>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={offset === 0 || loading}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            Previous
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={offset + PAGE_SIZE >= total || loading}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
};

export { InstanceUsers };
