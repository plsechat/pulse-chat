import { PaginatedList } from '@/components/paginated-list';
import { useUserById } from '@/features/server/users/hooks';
import { fullDateTime } from '@/helpers/time-format';
import { ActivityLogType } from '@pulse/shared';
import { format } from 'date-fns';
import {
  Gavel,
  LogIn,
  LogOut,
  Pencil,
  ShieldMinus,
  ShieldPlus,
  UserMinus,
  type LucideIcon
} from 'lucide-react';
import { memo, useCallback } from 'react';
import { useModViewContext, type TAuditLogEntry } from '../context';

/**
 * Per-user audit trail (mod view drill-in). Renders whatever entry types
 * the server recorded — unknown/legacy types fall back to a prettified
 * type label so new server versions never render blank rows here.
 */

const ICONS: Record<string, LucideIcon> = {
  [ActivityLogType.USER_JOINED]: LogIn,
  [ActivityLogType.USER_LEFT]: LogOut,
  [ActivityLogType.USER_KICKED]: UserMinus,
  [ActivityLogType.USER_BANNED]: Gavel,
  [ActivityLogType.USER_UNBANNED]: Gavel,
  [ActivityLogType.USER_ROLE_ASSIGNED]: ShieldPlus,
  [ActivityLogType.USER_ROLE_REMOVED]: ShieldMinus,
  [ActivityLogType.USER_NICKNAME_SET]: Pencil
};

const prettifyType = (type: string) =>
  type
    .toLowerCase()
    .split('_')
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ');

const ActorName = memo(({ actorId }: { actorId: number | undefined }) => {
  const actor = useUserById(actorId ?? -1);
  if (actorId === undefined) return null;
  return <> by {actor?.name ?? `user #${actorId}`}</>;
});

const describe = (entry: TAuditLogEntry): { text: string; actorId?: number } => {
  const d = (entry.details ?? {}) as Record<string, unknown>;
  switch (entry.type) {
    case ActivityLogType.USER_JOINED:
      return { text: 'Joined the server' };
    case ActivityLogType.USER_LEFT:
      return { text: 'Left the server' };
    case ActivityLogType.USER_KICKED:
      return {
        text: d.reason ? `Kicked — ${String(d.reason)}` : 'Kicked',
        actorId: d.kickedBy as number | undefined
      };
    case ActivityLogType.USER_BANNED:
      return {
        text: d.reason ? `Banned — ${String(d.reason)}` : 'Banned',
        actorId: d.bannedBy as number | undefined
      };
    case ActivityLogType.USER_UNBANNED:
      return { text: 'Unbanned', actorId: d.unbannedBy as number | undefined };
    case ActivityLogType.USER_ROLE_ASSIGNED:
      return {
        text: `Role "${String(d.roleName ?? d.roleId)}" assigned`,
        actorId: d.assignedBy as number | undefined
      };
    case ActivityLogType.USER_ROLE_REMOVED:
      return {
        text: `Role "${String(d.roleName ?? d.roleId)}" removed`,
        actorId: d.removedBy as number | undefined
      };
    case ActivityLogType.USER_NICKNAME_SET:
      return {
        text: d.nickname
          ? `Nickname set to "${String(d.nickname)}"`
          : 'Nickname cleared',
        actorId: d.setBy as number | undefined
      };
    default:
      return { text: prettifyType(entry.type) };
  }
};

const AuditLog = memo(() => {
  const { auditLog } = useModViewContext();

  const renderItem = useCallback((entry: TAuditLogEntry) => {
    const Icon = ICONS[entry.type] ?? Pencil;
    const { text, actorId } = describe(entry);
    return (
      <div className="flex items-start gap-3 rounded-lg px-2 py-2 hover:bg-accent/40 transition-colors duration-100">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted/60">
          <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm text-foreground">
            {text}
            <span className="text-muted-foreground">
              <ActorName actorId={actorId} />
            </span>
          </p>
          <p className="text-xs text-muted-foreground">
            {format(new Date(entry.createdAt), fullDateTime())}
          </p>
        </div>
      </div>
    );
  }, []);

  const searchFilter = useCallback(
    (entry: TAuditLogEntry, term: string) =>
      describe(entry).text.toLowerCase().includes(term.toLowerCase()) ||
      entry.type.toLowerCase().includes(term.toLowerCase()),
    []
  );

  return (
    <PaginatedList
      items={auditLog}
      renderItem={renderItem}
      searchFilter={searchFilter}
    />
  );
});

export { AuditLog };
