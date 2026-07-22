import { Button } from '@/components/ui/button';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { getTRPCClient } from '@/lib/trpc';
import { filesize } from 'filesize';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

type TStorage = {
  totalBytes: number;
  fileCount: number;
  orphanCount: number;
  topUploaders: {
    userId: number;
    userName: string;
    bytes: number;
    fileCount: number;
  }[];
};

const Stat = ({ label, value }: { label: string; value: string }) => (
  <div className="rounded-lg border border-border bg-muted/20 p-3">
    <p className="text-xs text-muted-foreground">{label}</p>
    <p className="text-lg font-semibold text-foreground">{value}</p>
  </div>
);

/** Storage usage totals, orphan backlog, and heaviest uploaders. */
const InstanceStorage = () => {
  const [storage, setStorage] = useState<TStorage | null>(null);
  const [cleaning, setCleaning] = useState(false);

  const fetchStorage = useCallback(async () => {
    const trpc = getTRPCClient();
    if (!trpc) return;
    setStorage(await trpc.admin.getStorage.query());
  }, []);

  useEffect(() => {
    fetchStorage();
  }, [fetchStorage]);

  const runCleanup = async () => {
    const trpc = getTRPCClient();
    if (!trpc) return;
    setCleaning(true);
    try {
      const { removed } = await trpc.admin.runStorageCleanup.mutate();
      toast.success(
        removed === 0
          ? 'Nothing to clean up'
          : `Removed ${removed} orphaned file${removed === 1 ? '' : 's'}`
      );
      await fetchStorage();
    } catch (error) {
      toast.error(getTrpcError(error, 'Cleanup failed'));
    } finally {
      setCleaning(false);
    }
  };

  if (!storage) return null;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="Storage used" value={String(filesize(storage.totalBytes))} />
        <Stat label="Stored files" value={String(storage.fileCount)} />
        <Stat label="Orphaned files" value={String(storage.orphanCount)} />
      </div>

      <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/20 px-4 py-3">
        <div className="text-sm">
          <p className="text-foreground">Orphan cleanup</p>
          <p className="text-muted-foreground">
            Files nothing references anymore. The sweep also runs
            automatically every 15 minutes.
          </p>
        </div>
        <Button
          size="sm"
          className="ml-auto"
          disabled={cleaning || storage.orphanCount === 0}
          onClick={runCleanup}
        >
          Clean up now
        </Button>
      </div>

      <div className="space-y-2">
        <h4 className="text-sm font-medium text-foreground">
          Largest uploaders
        </h4>
        {storage.topUploaders.length === 0 ? (
          <p className="text-sm text-muted-foreground">No files uploaded.</p>
        ) : (
          <div className="space-y-1">
            {storage.topUploaders.map((u) => (
              <div
                key={u.userId}
                className="flex items-center gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2 text-sm"
              >
                <span className="text-foreground">{u.userName}</span>
                <span className="text-xs text-muted-foreground">
                  {u.fileCount} file{u.fileCount === 1 ? '' : 's'}
                </span>
                <span className="ml-auto text-muted-foreground">
                  {String(filesize(u.bytes))}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export { InstanceStorage };
