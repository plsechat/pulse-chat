import { Button } from '@/components/ui/button';
import { usePreviewMeta } from '@/features/server/hooks';
import {
  joinPreviewedServer,
  leaveServerPreview
} from '@/features/server/preview/actions';
import { getFileUrl } from '@/helpers/get-file-url';
import { Eye, Loader2, Lock, Users, X } from 'lucide-react';
import { memo, useCallback, useState } from 'react';

/**
 * Prominent bar above the server layout while previewing (read-only,
 * servers.preview): server identity, Join, and a way to leave.
 */
const PreviewBanner = memo(() => {
  const meta = usePreviewMeta();
  const [joining, setJoining] = useState(false);

  const onJoinClick = useCallback(async () => {
    setJoining(true);

    try {
      // Errors are toasted inside joinPreviewedServer
      await joinPreviewedServer();
    } finally {
      setJoining(false);
    }
  }, []);

  if (!meta) return null;

  const firstLetter = meta.serverName.charAt(0).toUpperCase();

  return (
    <div className="flex items-center gap-3 border-b border-border bg-card px-4 py-2.5">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-input">
        {meta.logo ? (
          <img
            src={getFileUrl(meta.logo)}
            alt={meta.serverName}
            className="h-full w-full object-cover"
          />
        ) : (
          <span className="text-sm font-bold text-muted-foreground">
            {firstLetter}
          </span>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Eye className="h-4 w-4 shrink-0 text-primary" />
          <span className="truncate text-sm font-semibold text-foreground">
            You&apos;re previewing {meta.serverName}
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Users className="h-3 w-3 shrink-0" />
          <span>{meta.memberCount} members</span>
          {meta.hasPassword && <Lock className="h-3 w-3 shrink-0" />}
          <span aria-hidden>·</span>
          <span className="truncate">Read-only until you join</span>
        </div>
      </div>

      <Button size="sm" onClick={onJoinClick} disabled={joining}>
        {joining ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Join Server'}
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="h-8 w-8 text-muted-foreground hover:text-foreground"
        onClick={leaveServerPreview}
        title="Leave preview"
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
});

export { PreviewBanner };
