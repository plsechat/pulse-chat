import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { getTRPCClient } from '@/lib/trpc';
import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

type TLevel = 'all' | 'error' | 'warn' | 'info' | 'debug';
type TLogLine = { ts: number; level: string; message: string };

const LEVEL_COLORS: Record<string, string> = {
  error: 'text-red-400',
  warn: 'text-yellow-400',
  info: 'text-foreground',
  debug: 'text-muted-foreground'
};

/**
 * Tail of the server's in-memory log ring (last 1000 lines, exactly
 * what the console prints). For history, the on-disk logs are the
 * source of truth — see the debug-logging operator docs.
 */
const InstanceLogs = () => {
  const [level, setLevel] = useState<TLevel>('all');
  const [lines, setLines] = useState<TLogLine[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  const fetchLogs = useCallback(async () => {
    const trpc = getTRPCClient();
    if (!trpc) return;
    const result = await trpc.admin.getRecentLogs.query({
      level: level === 'all' ? undefined : level,
      limit: 300
    });
    setLines(result.logs);
  }, [level]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [lines]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        {(['all', 'error', 'warn', 'info', 'debug'] as const).map((l) => (
          <Button
            key={l}
            size="sm"
            variant={level === l ? 'default' : 'secondary'}
            onClick={() => setLevel(l)}
          >
            {l[0]!.toUpperCase() + l.slice(1)}
          </Button>
        ))}
        <Button size="sm" variant="ghost" className="ml-auto" onClick={fetchLogs}>
          <RefreshCw className="h-4 w-4" />
          Refresh
        </Button>
      </div>

      <div className="h-[28rem] overflow-y-auto rounded-lg border border-border bg-background/60 p-3 font-mono text-xs leading-5">
        {lines.length === 0 ? (
          <p className="text-muted-foreground">No log lines captured yet.</p>
        ) : (
          lines.map((line, i) => (
            <div key={`${line.ts}-${i}`} className="flex gap-2 whitespace-pre-wrap break-all">
              <span className="shrink-0 text-muted-foreground">
                {new Date(line.ts).toLocaleTimeString()}
              </span>
              <span
                className={cn(
                  'shrink-0 w-12',
                  LEVEL_COLORS[line.level] ?? 'text-foreground'
                )}
              >
                {line.level}
              </span>
              <span className="text-foreground/90">{line.message}</span>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
};

export { InstanceLogs };
