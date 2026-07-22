import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { requestConfirmation } from '@/features/dialogs/actions';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { getTRPCClient } from '@/lib/trpc';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ReportCard, type TReportRowBase } from '../report-card';

type TReportStatus = 'open' | 'resolved' | 'dismissed';
type TAudience = 'instance' | 'server';

type TInstanceReportRow = TReportRowBase & {
  targetMessageId: number | null;
  targetDmMessageId: number | null;
  targetUserId: number;
  reporterId: number;
  serverName: string | null;
  audience: string;
  escalationReason: string | null;
};

const ESCALATION_LABELS: Record<string, string> = {
  illegal: 'Illegal — auto-escalated',
  target_mod: 'Reported a moderator',
  manual: 'Escalated by a mod',
  stale: 'Unhandled for 7 days'
};

/**
 * The operator's view. Queue = what the operator owns: DM and account
 * reports plus everything escalated out of a server queue. Receipts =
 * reports the server's own mods own, visible here (snapshot included)
 * for oversight; the operator can still step in on an open one.
 */
const InstanceReports = () => {
  const [audience, setAudience] = useState<TAudience>('instance');
  const [status, setStatus] = useState<TReportStatus>('open');
  const [rows, setRows] = useState<TInstanceReportRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);

  const fetchReports = useCallback(async () => {
    const trpc = getTRPCClient();
    if (!trpc) return;
    setLoading(true);
    try {
      const result = await trpc.admin.listReports.query({ audience, status });
      setRows(result.reports);
      setTotal(result.total);
    } finally {
      setLoading(false);
    }
  }, [audience, status]);

  useEffect(() => {
    fetchReports();
  }, [fetchReports]);

  const resolve = async (
    report: TInstanceReportRow,
    action: 'dismiss' | 'delete-content' | 'delete-and-ban'
  ) => {
    if (action !== 'dismiss') {
      const confirmed = await requestConfirmation({
        title:
          action === 'delete-and-ban'
            ? `Delete the content and ban ${report.targetName}?`
            : 'Delete the reported content?',
        message:
          action === 'delete-and-ban'
            ? 'The reported message is removed for everyone and the author is banned from the entire instance.'
            : 'The reported message is removed for everyone. The author stays.',
        confirmLabel: action === 'delete-and-ban' ? 'Delete & ban' : 'Delete',
        cancelLabel: 'Cancel'
      });
      if (!confirmed) return;
    }

    const trpc = getTRPCClient();
    if (!trpc) return;
    setBusyId(report.id);
    try {
      await trpc.admin.resolveReport.mutate({ reportId: report.id, action });
      toast.success(action === 'dismiss' ? 'Report dismissed' : 'Resolved');
      await fetchReports();
    } catch (error) {
      toast.error(getTrpcError(error, 'Could not resolve the report'));
    } finally {
      setBusyId(null);
    }
  };

  const hasMessage = (r: TInstanceReportRow) =>
    r.targetMessageId !== null || r.targetDmMessageId !== null;

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {(
          [
            ['instance', 'Queue'],
            ['server', 'Receipts']
          ] as const
        ).map(([value, label]) => (
          <Button
            key={value}
            size="sm"
            variant={audience === value ? 'default' : 'outline'}
            onClick={() => setAudience(value)}
          >
            {label}
          </Button>
        ))}
        <span className="mx-1 w-px self-stretch bg-border" />
        {(['open', 'resolved', 'dismissed'] as const).map((s) => (
          <Button
            key={s}
            size="sm"
            variant={status === s ? 'default' : 'secondary'}
            onClick={() => setStatus(s)}
          >
            {s[0]!.toUpperCase() + s.slice(1)}
          </Button>
        ))}
        <span className="ml-auto self-center text-sm text-muted-foreground">
          {total} report{total === 1 ? '' : 's'}
        </span>
      </div>

      {audience === 'server' && (
        <p className="text-xs text-muted-foreground">
          These reports sit with the server&apos;s own moderators. You see
          them for oversight and can still act on an open one directly.
        </p>
      )}

      <div className="space-y-3">
        {rows.map((report) => (
          <ReportCard
            key={report.id}
            report={report}
            extraBadges={
              <>
                {report.serverName && (
                  <Badge variant="secondary">{report.serverName}</Badge>
                )}
                {report.escalationReason && (
                  <Badge variant="outline">
                    {ESCALATION_LABELS[report.escalationReason] ??
                      report.escalationReason}
                  </Badge>
                )}
              </>
            }
            actions={
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busyId === report.id}
                  onClick={() => resolve(report, 'dismiss')}
                >
                  Dismiss
                </Button>
                {hasMessage(report) && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busyId === report.id}
                    onClick={() => resolve(report, 'delete-content')}
                  >
                    Delete content
                  </Button>
                )}
                {!report.targetBanned && !report.targetDeletedAt && (
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={busyId === report.id}
                    onClick={() => resolve(report, 'delete-and-ban')}
                  >
                    {hasMessage(report) ? 'Delete & ban' : 'Ban'}
                  </Button>
                )}
              </div>
            }
          />
        ))}
        {!loading && rows.length === 0 && (
          <div className="rounded-lg border border-border bg-muted/20 px-4 py-10 text-center text-sm text-muted-foreground">
            {status === 'open'
              ? audience === 'instance'
                ? 'The queue is clear.'
                : 'No open reports with server moderators.'
              : `No ${status} reports.`}
          </div>
        )}
      </div>
    </div>
  );
};

export { InstanceReports };
