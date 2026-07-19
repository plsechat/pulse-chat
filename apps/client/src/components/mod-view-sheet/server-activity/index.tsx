import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Activity,
  ChevronRight,
  File,
  Link,
  MessageSquareText,
  ShieldCheck
} from 'lucide-react';
import { memo } from 'react';
import { ModViewScreen, useModViewContext } from '../context';

const ServerActivity = memo(() => {
  const { files, messages, links, auditLog, setView } = useModViewContext();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="h-5 w-5" />
          Server Activity
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div
          className="flex items-center justify-between rounded-lg px-2 py-2 hover:bg-accent/50 transition-colors duration-100 cursor-pointer"
          onClick={() => setView(ModViewScreen.MESSAGES)}
        >
          <div className="flex items-center gap-3">
            <MessageSquareText className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm">Messages</span>
          </div>
          <span className="flex items-center gap-1 text-sm text-muted-foreground"><span className="rounded-full bg-muted/60 px-2 py-0.5 text-xs tabular-nums">{messages.length}</span><ChevronRight className="h-3.5 w-3.5" /></span>
        </div>

        <div
          className="flex items-center justify-between rounded-lg px-2 py-2 hover:bg-accent/50 transition-colors duration-100 cursor-pointer"
          onClick={() => setView(ModViewScreen.LINKS)}
        >
          <div className="flex items-center gap-3">
            <Link className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm">Links</span>
          </div>
          <span className="flex items-center gap-1 text-sm text-muted-foreground"><span className="rounded-full bg-muted/60 px-2 py-0.5 text-xs tabular-nums">{links.length}</span><ChevronRight className="h-3.5 w-3.5" /></span>
        </div>

        <div
          className="flex items-center justify-between rounded-lg px-2 py-2 hover:bg-accent/50 transition-colors duration-100 cursor-pointer"
          onClick={() => setView(ModViewScreen.FILES)}
        >
          <div className="flex items-center gap-3">
            <File className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm">Files</span>
          </div>
          <span className="flex items-center gap-1 text-sm text-muted-foreground"><span className="rounded-full bg-muted/60 px-2 py-0.5 text-xs tabular-nums">{files.length}</span><ChevronRight className="h-3.5 w-3.5" /></span>
        </div>

        <div
          className="flex items-center justify-between rounded-lg px-2 py-2 hover:bg-accent/50 transition-colors duration-100 cursor-pointer"
          onClick={() => setView(ModViewScreen.AUDIT_LOG)}
        >
          <div className="flex items-center gap-3">
            <ShieldCheck className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm">Audit Log</span>
          </div>
          <span className="flex items-center gap-1 text-sm text-muted-foreground"><span className="rounded-full bg-muted/60 px-2 py-0.5 text-xs tabular-nums">{auditLog.length}</span><ChevronRight className="h-3.5 w-3.5" /></span>
        </div>
      </CardContent>
    </Card>
  );
});

export { ServerActivity };
