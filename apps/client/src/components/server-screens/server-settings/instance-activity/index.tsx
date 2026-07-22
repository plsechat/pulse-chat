import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { getTRPCClient } from '@/lib/trpc';
import { ActivityLogType } from '@pulse/shared';
import { useCallback, useEffect, useState } from 'react';

const PAGE_SIZE = 50;
const ALL = '__all__';

type TEntry = {
  id: number;
  type: string;
  details: unknown;
  ip: string | null;
  createdAt: number;
  userId: number;
  userName: string;
  serverName: string | null;
};

/** Instance-wide audit trail — action metadata, never content. */
const InstanceActivity = () => {
  const [type, setType] = useState<string>(ALL);
  const [offset, setOffset] = useState(0);
  const [entries, setEntries] = useState<TEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const fetchEntries = useCallback(async () => {
    const trpc = getTRPCClient();
    if (!trpc) return;
    setLoading(true);
    try {
      const result = await trpc.admin.getActivityLog.query({
        type: type === ALL ? undefined : (type as ActivityLogType),
        offset,
        limit: PAGE_SIZE
      });
      setEntries(result.entries);
      setTotal(result.total);
    } finally {
      setLoading(false);
    }
  }, [type, offset]);

  useEffect(() => {
    fetchEntries();
  }, [fetchEntries]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Select
          value={type}
          onValueChange={(v) => {
            setType(v);
            setOffset(0);
          }}
        >
          <SelectTrigger className="w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All events</SelectItem>
            {Object.values(ActivityLogType).map((t) => (
              <SelectItem key={t} value={t}>
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="ml-auto text-sm text-muted-foreground">
          {total} entr{total === 1 ? 'y' : 'ies'}
        </span>
      </div>

      <div className="space-y-2">
        {entries.map((entry) => (
          <div
            key={entry.id}
            className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2 text-sm"
          >
            <Badge variant="outline">{entry.type}</Badge>
            <span className="text-foreground">{entry.userName}</span>
            {entry.serverName && (
              <Badge variant="secondary">{entry.serverName}</Badge>
            )}
            {entry.details != null &&
              Object.keys(entry.details as object).length > 0 && (
                <code className="max-w-md truncate rounded bg-background/50 px-1.5 py-0.5 text-xs text-muted-foreground">
                  {JSON.stringify(entry.details)}
                </code>
              )}
            <span className="ml-auto text-xs text-muted-foreground">
              {new Date(entry.createdAt).toLocaleString()}
            </span>
          </div>
        ))}
        {!loading && entries.length === 0 && (
          <div className="rounded-lg border border-border bg-muted/20 px-4 py-10 text-center text-sm text-muted-foreground">
            No activity recorded.
          </div>
        )}
      </div>

      {total > PAGE_SIZE && (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            Previous
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={offset + PAGE_SIZE >= total}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            Next
          </Button>
          <span className="text-xs text-muted-foreground">
            {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
          </span>
        </div>
      )}
    </div>
  );
};

export { InstanceActivity };
