import { EmptyState } from '@/components/ui/empty-state';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { useFederatedServers } from '@/features/app/hooks';
import { startServerPreview } from '@/features/server/preview/actions';
import { getHomeTRPCClient } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import type { TDirectoryEntry, TDirectorySort } from '@pulse/server/types';
import {
  BookOpen,
  Check,
  Gamepad2,
  Globe,
  Loader2,
  Lock,
  Search,
  Users
} from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  directoryEntryKey,
  directoryLogoSrc,
  formatDirectoryCounts,
  formatFetchedAgo
} from './directory-helpers';
import { joinLocalServerFromCard, joinRemoteServerFromCard } from './join-actions';

/** Cards per page; "Show more" appends the next page. */
const PAGE_SIZE = 30;
/** Keystrokes settle this long before the server is asked. */
const SEARCH_DEBOUNCE_MS = 300;

const SORT_LABELS: Record<TDirectorySort, string> = {
  online: 'Most online',
  members: 'Most members',
  name: 'Name'
};

const ALL_GAMES = '__all__';

const DirectoryCard = memo(
  ({
    entry,
    joined,
    busy,
    onPreview,
    onJoin
  }: {
    entry: TDirectoryEntry;
    joined: boolean;
    busy: 'join' | 'preview' | null;
    onPreview: (entry: TDirectoryEntry) => void;
    onJoin: (entry: TDirectoryEntry) => void;
  }) => {
    const logoSrc = directoryLogoSrc(entry);
    const fetchedAgo =
      entry.fetchedAt !== null ? formatFetchedAgo(entry.fetchedAt) : null;
    const disabled = busy !== null;

    return (
      <article
        aria-label={entry.name}
        className="flex flex-col overflow-hidden rounded-lg bg-card transition-colors hover:bg-accent"
      >
        <div className="flex h-32 items-center justify-center bg-input">
          {logoSrc ? (
            <img
              src={logoSrc}
              alt=""
              className="h-full w-full object-cover"
            />
          ) : (
            <span aria-hidden="true" className="text-5xl font-bold text-muted-foreground">
              {entry.name.charAt(0).toUpperCase()}
            </span>
          )}
        </div>

        <div className="flex flex-1 flex-col gap-2 p-4">
          <h3 className="flex items-center gap-1.5 text-lg font-semibold text-foreground">
            <span className="truncate">{entry.name}</span>
            {entry.hasPassword && (
              <>
                <Lock className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="sr-only">Password required</span>
              </>
            )}
          </h3>

          {entry.instance && (
            <div className="flex items-center gap-1 text-xs text-blue-500">
              <Globe className="h-3 w-3" aria-hidden="true" />
              <span>{entry.instance.name}</span>
              {fetchedAgo && (
                <span className="text-muted-foreground"> · {fetchedAgo}</span>
              )}
            </div>
          )}

          {(entry.game || entry.tags.length > 0) && (
            <ul className="flex flex-wrap gap-1" aria-label="Game and tags">
              {entry.game && (
                <li className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-foreground">
                  <Gamepad2 className="h-3 w-3" aria-hidden="true" />
                  {entry.game}
                </li>
              )}
              {entry.tags.map((tag) => (
                <li
                  key={tag}
                  className="rounded-full bg-input px-2 py-0.5 text-xs text-muted-foreground"
                >
                  {tag}
                </li>
              ))}
            </ul>
          )}

          <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Users className="h-4 w-4" aria-hidden="true" />
            <span>{formatDirectoryCounts(entry.memberCount, entry.onlineCount)}</span>
          </div>

          {entry.description && (
            <p className="line-clamp-3 text-sm text-muted-foreground">
              {entry.description}
            </p>
          )}

          <div className="mt-auto flex items-center justify-end gap-1.5 pt-2">
            {joined ? (
              <span className="flex items-center gap-1.5 rounded-md bg-input px-4 py-1.5 text-sm font-medium text-muted-foreground">
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
                Joined
              </span>
            ) : (
              <>
                {entry.source === 'local' && (
                  <button
                    type="button"
                    onClick={() => onPreview(entry)}
                    disabled={disabled}
                    className={cn(
                      'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                      disabled
                        ? 'cursor-not-allowed bg-muted text-muted-foreground'
                        : 'bg-input text-foreground hover:bg-accent'
                    )}
                  >
                    {busy === 'preview' ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                        <span className="sr-only">Opening preview</span>
                      </>
                    ) : (
                      'Preview'
                    )}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onJoin(entry)}
                  disabled={disabled}
                  className={cn(
                    'rounded-md px-4 py-1.5 text-sm font-medium transition-colors',
                    disabled
                      ? 'cursor-not-allowed bg-muted text-muted-foreground'
                      : entry.source === 'local'
                        ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                        : 'bg-blue-600 text-white hover:bg-blue-700'
                  )}
                >
                  {busy === 'join' ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                      <span className="sr-only">Joining</span>
                    </>
                  ) : (
                    'Join'
                  )}
                </button>
              </>
            )}
          </div>
        </div>
      </article>
    );
  }
);

/**
 * The Directory section of the Discover screen: this instance's listed
 * servers and its peers' cached listings, searched / filtered / sorted
 * on the server. `searchQuery` is the screen's shared search box,
 * debounced here before it becomes a request.
 */
const DirectorySection = memo(
  ({ active, searchQuery }: { active: boolean; searchQuery: string }) => {
    const [entries, setEntries] = useState<TDirectoryEntry[]>([]);
    const [hasMore, setHasMore] = useState(false);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [games, setGames] = useState<string[]>([]);
    const [game, setGame] = useState<string>(ALL_GAMES);
    const [sort, setSort] = useState<TDirectorySort>('online');
    const [search, setSearch] = useState('');
    const [busy, setBusy] = useState<{ key: string; kind: 'join' | 'preview' } | null>(null);
    const [joinedKeys, setJoinedKeys] = useState<Set<string>>(() => new Set());
    const federatedServers = useFederatedServers();
    // Drops a response that arrives after a newer request was sent.
    const requestSeq = useRef(0);

    useEffect(() => {
      const handle = setTimeout(() => setSearch(searchQuery.trim()), SEARCH_DEBOUNCE_MS);
      return () => clearTimeout(handle);
    }, [searchQuery]);

    const fetchPage = useCallback(
      async (offset: number) => {
        const trpc = getHomeTRPCClient();
        if (!trpc) return;
        const seq = ++requestSeq.current;
        if (offset === 0) setLoading(true);
        else setLoadingMore(true);
        try {
          const page = await trpc.servers.directory.query({
            search: search || undefined,
            game: game === ALL_GAMES ? undefined : game,
            sort,
            limit: PAGE_SIZE,
            offset
          });
          if (seq !== requestSeq.current) return;
          setEntries((prev) => (offset === 0 ? page.entries : [...prev, ...page.entries]));
          setHasMore(page.hasMore);
        } catch (error) {
          if (seq !== requestSeq.current) return;
          console.error('Failed to load the directory:', error);
          toast.error('Failed to load the directory');
        } finally {
          if (seq === requestSeq.current) {
            setLoading(false);
            setLoadingMore(false);
          }
        }
      },
      [search, game, sort]
    );

    useEffect(() => {
      if (!active) return;
      fetchPage(0);
    }, [active, fetchPage]);

    useEffect(() => {
      if (!active) return;
      const trpc = getHomeTRPCClient();
      if (!trpc) return;
      trpc.servers.directoryGames
        .query()
        .then(setGames)
        .catch((error) => console.error('Failed to load directory games:', error));
    }, [active]);

    const handlePreview = useCallback(async (entry: TDirectoryEntry) => {
      if (entry.serverId === null) return;
      setBusy({ key: directoryEntryKey(entry), kind: 'preview' });
      try {
        // Errors are toasted inside startServerPreview
        await startServerPreview({ serverId: entry.serverId });
      } finally {
        setBusy(null);
      }
    }, []);

    const handleJoin = useCallback(async (entry: TDirectoryEntry) => {
      const key = directoryEntryKey(entry);
      setBusy({ key, kind: 'join' });
      try {
        const joined =
          entry.source === 'local' && entry.serverId !== null
            ? (await joinLocalServerFromCard({
                serverId: entry.serverId,
                name: entry.name,
                hasPassword: entry.hasPassword
              })) !== null
            : entry.instance !== null &&
              (await joinRemoteServerFromCard({
                publicId: entry.publicId,
                name: entry.name,
                instance: entry.instance,
                hasPassword: entry.hasPassword
              }));
        if (joined) {
          setJoinedKeys((prev) => new Set(prev).add(key));
        }
      } finally {
        setBusy(null);
      }
    }, []);

    const isJoined = (entry: TDirectoryEntry) =>
      entry.joined ||
      joinedKeys.has(directoryEntryKey(entry)) ||
      (entry.instance !== null &&
        federatedServers.some(
          (fs) =>
            fs.instanceDomain === entry.instance!.domain &&
            fs.server.publicId === entry.publicId
        ));

    const filtered = search.length > 0 || game !== ALL_GAMES;

    return (
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="directory-game" className="sr-only">
            Filter by game
          </label>
          <Select value={game} onValueChange={setGame}>
            <SelectTrigger id="directory-game" className="h-8 w-44" aria-label="Filter by game">
              <SelectValue placeholder="All games" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_GAMES}>All games</SelectItem>
              {games.map((g) => (
                <SelectItem key={g} value={g}>
                  {g}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <label htmlFor="directory-sort" className="sr-only">
            Sort by
          </label>
          <Select value={sort} onValueChange={(v) => setSort(v as TDirectorySort)}>
            <SelectTrigger id="directory-sort" className="h-8 w-40" aria-label="Sort by">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(SORT_LABELS) as TDirectorySort[]).map((key) => (
                <SelectItem key={key} value={key}>
                  {SORT_LABELS[key]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <p aria-live="polite" className="ml-auto text-xs text-muted-foreground">
            {loading
              ? 'Loading…'
              : `${entries.length}${hasMore ? '+' : ''} ${entries.length === 1 ? 'community' : 'communities'}`}
          </p>
        </div>

        {loading ? (
          <div className="flex h-64 items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" aria-hidden="true" />
            <span className="sr-only">Loading the directory</span>
          </div>
        ) : entries.length === 0 ? (
          filtered ? (
            <EmptyState
              icon={Search}
              title="No communities match"
              description="Try another name, tag or game."
              className="h-64"
            />
          ) : (
            <EmptyState
              icon={BookOpen}
              title="Nothing listed yet"
              description="Communities that opt in under Server Settings → General appear here, together with the listings of federated instances."
              className="h-64"
            />
          )
        ) : (
          <>
            <div className="mx-auto grid w-full max-w-5xl grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {entries.map((entry) => {
                const key = directoryEntryKey(entry);
                return (
                  <DirectoryCard
                    key={key}
                    entry={entry}
                    joined={isJoined(entry)}
                    busy={busy?.key === key ? busy.kind : null}
                    onPreview={handlePreview}
                    onJoin={handleJoin}
                  />
                );
              })}
            </div>
            {hasMore && (
              <div className="flex justify-center">
                <button
                  type="button"
                  onClick={() => fetchPage(entries.length)}
                  disabled={loadingMore}
                  className="rounded-md bg-input px-4 py-2 text-sm font-medium text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {loadingMore ? 'Loading…' : 'Show more'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    );
  }
);

export { DirectorySection };
