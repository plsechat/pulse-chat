import { Badge } from '@/components/ui/badge';
import type { ReactNode } from 'react';

type TReportRowBase = {
  id: number;
  kind: string;
  reason: string;
  details: string | null;
  contentSnapshot: string | null;
  snapshotAttested: boolean;
  status: string;
  createdAt: number;
  resolvedAt: number | null;
  targetName: string;
  targetNickname: string | null;
  targetPublicId: string;
  targetBanned: boolean;
  targetDeletedAt: number | null;
  reporterName: string;
  resolverName: string | null;
};

/**
 * The name a reviewer should act on: the server nickname they know the
 * person by, disambiguated by the account name when the two differ.
 * The short publicId beside it is the canonical check — it matches the
 * popover's "Copy User ID" and the All Accounts search.
 */
const targetLabel = (r: {
  targetName: string;
  targetNickname: string | null;
}): string =>
  r.targetNickname && r.targetNickname !== r.targetName
    ? `${r.targetNickname} (${r.targetName})`
    : r.targetName;

const REASON_LABELS: Record<string, string> = {
  illegal: 'Illegal content',
  spam: 'Spam',
  harassment: 'Harassment',
  other: 'Other'
};

const KIND_LABELS: Record<string, string> = {
  user: 'User',
  dm_message: 'DM message',
  message: 'Message'
};

/**
 * One report, exactly as the reporter granted it — shared between the
 * server mods' queue and the operator's queue/receipts so the two
 * surfaces can't drift apart. `extraBadges` slots audience-specific
 * badges (server name, escalation reason); `actions` slots the
 * audience-specific buttons for open reports.
 */
const ReportCard = ({
  report,
  extraBadges,
  actions
}: {
  report: TReportRowBase;
  extraBadges?: ReactNode;
  actions?: ReactNode;
}) => (
  <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-3">
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <Badge variant="destructive">
        {REASON_LABELS[report.reason] ?? report.reason}
      </Badge>
      <Badge variant="outline">{KIND_LABELS[report.kind] ?? report.kind}</Badge>
      {extraBadges}
      <span className="text-muted-foreground">
        {report.reporterName} reported{' '}
        <span className="text-foreground">{targetLabel(report)}</span>
        <code
          className="ml-1 rounded bg-background/50 px-1 py-0.5 text-[10px]"
          title={report.targetPublicId}
        >
          {report.targetPublicId.slice(0, 8)}
        </code>
        {report.targetBanned ? ' (banned)' : ''}
        {report.targetDeletedAt ? ' (deleted account)' : ''}
      </span>
      <span className="ml-auto text-xs text-muted-foreground">
        {new Date(report.createdAt).toLocaleString()}
      </span>
    </div>

    {report.contentSnapshot !== null ? (
      <div className="space-y-1">
        <blockquote className="rounded-md border-l-2 border-primary/60 bg-background/40 px-3 py-2 text-sm whitespace-pre-wrap break-words">
          {report.contentSnapshot}
        </blockquote>
        {report.snapshotAttested && (
          <p className="text-xs text-muted-foreground">
            Encrypted message — this text is the reporter&apos;s decrypted
            copy and cannot be independently verified.
          </p>
        )}
      </div>
    ) : report.kind !== 'user' ? (
      <p className="text-sm italic text-muted-foreground">
        No snapshot available (encrypted message, reporter attached no text).
      </p>
    ) : null}

    {report.details && (
      <p className="text-sm text-muted-foreground">“{report.details}”</p>
    )}

    {report.status === 'open' ? (
      actions
    ) : (
      <p className="text-xs text-muted-foreground">
        {report.status === 'dismissed' ? 'Dismissed' : 'Resolved'}
        {report.resolverName ? ` by ${report.resolverName}` : ''}
        {report.resolvedAt
          ? ` · ${new Date(report.resolvedAt).toLocaleString()}`
          : ''}
      </p>
    )}
  </div>
);

export { ReportCard, targetLabel };
export type { TReportRowBase };
