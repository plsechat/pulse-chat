import { Button } from '@/components/ui/button';
import { requestConfirmation } from '@/features/dialogs/actions';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { getTRPCClient } from '@/lib/trpc';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ReportCard, type TReportRowBase } from '../report-card';

type TReportStatus = 'open' | 'resolved' | 'dismissed';
type TServerAction =
  | 'dismiss'
  | 'delete-content'
  | 'delete-and-kick'
  | 'delete-and-ban'
  | 'escalate';

type TServerReportRow = TReportRowBase & {
  targetMessageId: number | null;
  targetUserId: number;
  reporterId: number;
};

const CONFIRMS: Partial<
  Record<TServerAction, { title: (name: string) => string; message: string; confirmLabel: string }>
> = {
  'delete-content': {
    title: () => 'Delete the reported message?',
    message: 'The message is removed for everyone. The author stays.',
    confirmLabel: 'Delete'
  },
  'delete-and-kick': {
    title: (name) => `Delete the message and kick ${name}?`,
    message:
      'The message is removed for everyone and the author is removed from this server. They can rejoin with an invite.',
    confirmLabel: 'Delete & kick'
  },
  'delete-and-ban': {
    title: (name) => `Delete the message and ban ${name}?`,
    message:
      'The message is removed for everyone and the author is banned. Bans apply across the whole instance.',
    confirmLabel: 'Delete & ban'
  }
};

/**
 * The server moderators' queue: channel-message reports about this
 * server that no trigger escalated. Escalating hands the report — with
 * its snapshot — to the instance operator and removes it from here.
 */
const ServerReports = () => {
  const [status, setStatus] = useState<TReportStatus>('open');
  const [rows, setRows] = useState<TServerReportRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);

  const fetchReports = useCallback(async () => {
    const trpc = getTRPCClient();
    if (!trpc) return;
    setLoading(true);
    try {
      const result = await trpc.reports.listServerQueue.query({ status });
      setRows(result.reports);
      setTotal(result.total);
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    fetchReports();
  }, [fetchReports]);

  const resolve = async (report: TServerReportRow, action: TServerAction) => {
    const confirm = CONFIRMS[action];
    if (confirm) {
      const confirmed = await requestConfirmation({
        title: confirm.title(report.targetName),
        message: confirm.message,
        confirmLabel: confirm.confirmLabel,
        cancelLabel: 'Cancel'
      });
      if (!confirmed) return;
    }

    const trpc = getTRPCClient();
    if (!trpc) return;
    setBusyId(report.id);
    try {
      await trpc.reports.resolveServer.mutate({ reportId: report.id, action });
      toast.success(
        action === 'dismiss'
          ? 'Report dismissed'
          : action === 'escalate'
            ? 'Escalated to the instance operator'
            : 'Resolved'
      );
      await fetchReports();
    } catch (error) {
      toast.error(getTrpcError(error, 'Could not resolve the report'));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
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

      <div className="space-y-3">
        {rows.map((report) => (
          <ReportCard
            key={report.id}
            report={report}
            actions={
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busyId === report.id}
                  onClick={() => resolve(report, 'dismiss')}
                >
                  Dismiss
                </Button>
                {report.targetMessageId !== null && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busyId === report.id}
                    onClick={() => resolve(report, 'delete-content')}
                  >
                    Delete content
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busyId === report.id}
                  onClick={() => resolve(report, 'delete-and-kick')}
                >
                  Delete &amp; kick
                </Button>
                {!report.targetBanned && !report.targetDeletedAt && (
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={busyId === report.id}
                    onClick={() => resolve(report, 'delete-and-ban')}
                  >
                    Delete &amp; ban
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto"
                  disabled={busyId === report.id}
                  onClick={() => resolve(report, 'escalate')}
                >
                  Escalate to operator
                </Button>
              </div>
            }
          />
        ))}
        {!loading && rows.length === 0 && (
          <div className="rounded-lg border border-border bg-muted/20 px-4 py-10 text-center text-sm text-muted-foreground">
            {status === 'open' ? 'The queue is clear.' : `No ${status} reports.`}
          </div>
        )}
      </div>
    </div>
  );
};

export { ServerReports };
