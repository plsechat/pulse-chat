import { Button } from '@/components/ui/button';
import { LoadingCard } from '@/components/ui/loading-card';
import type { TAdminQuery } from '@/features/server/admin/hooks';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { memo } from 'react';

/** Inline failure row for a settings panel whose fetch rejected. */
const QueryErrorRow = memo(
  ({ message, onRetry }: { message: string; onRetry: () => void }) => (
    <div
      role="alert"
      className="flex items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm"
    >
      <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />
      <span className="min-w-0 flex-1 text-foreground">{message}</span>
      <Button size="sm" variant="outline" onClick={onRetry}>
        <RefreshCw className="h-4 w-4" />
        Retry
      </Button>
    </div>
  )
);

/**
 * Renders the loading / error states of a `useAdminQuery` and hands the
 * resolved data to `children` — so every instance panel shows the same
 * spinner card while fetching and the same Retry row on failure instead
 * of an empty body under the section header.
 */
function QueryState<T>({
  query,
  children
}: {
  query: TAdminQuery<T>;
  children: (data: T) => React.ReactNode;
}) {
  if (query.error) {
    return <QueryErrorRow message={query.error} onRetry={query.refetch} />;
  }
  if (query.data === null) {
    return <LoadingCard className="h-48" />;
  }
  return <>{children(query.data)}</>;
}

export { QueryErrorRow, QueryState };
