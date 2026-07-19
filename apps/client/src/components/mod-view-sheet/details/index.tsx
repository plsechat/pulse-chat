import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tooltip } from '@/components/ui/tooltip';
import { fullDateTime } from '@/helpers/time-format';
import { format, formatDistanceToNow } from 'date-fns';
import {
  Calendar,
  ClipboardList,
  Clock,
  Fingerprint,
  Gavel,
  Globe,
  IdCard,
  Network,
  Ticket
} from 'lucide-react';
import { memo } from 'react';
import { useVerifiedIdentity } from '@/lib/e2ee/use-verified-identity';
import { useModViewContext } from '../context';

type TRowProps = {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  details?: string;
};

const Row = memo(({ icon, label, value, details }: TRowProps) => {
  let valContent = (
    <span className="text-sm text-muted-foreground truncate max-w-[160px]">
      {value}
    </span>
  );

  if (details) {
    valContent = <Tooltip content={details}>{valContent}</Tooltip>;
  }

  return (
    <div className="flex items-center justify-between py-1.5 px-1 gap-4">
      <div className="flex items-center gap-3 min-w-0 flex-1">
        {icon}
        <span className="text-sm truncate">{label}</span>
      </div>
      {valContent}
    </div>
  );
});

const Details = memo(() => {
  const { user, logins, joinMethod } = useModViewContext();
  const lastLogin = logins[0]; // TODO: in the future we might show a list of logins, atm we just show info about the last one
  const verifiedIdentity = useVerifiedIdentity(user.id);
  const identityStatus =
    verifiedIdentity === undefined
      ? '…'
      : verifiedIdentity === null
        ? 'Not verified'
        : verifiedIdentity.acceptedChangeAt
          ? 'Recently changed'
          : verifiedIdentity.verifiedMethod === 'manual'
            ? 'Verified'
            : 'Pinned (TOFU)';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ClipboardList className="h-5 w-5" />
          Details
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="space-y-2">
          <Row
            icon={<IdCard className="h-4 w-4 text-muted-foreground" />}
            label="User ID"
            value={user.id}
          />

          <Row
            icon={<IdCard className="h-4 w-4 text-muted-foreground" />}
            label="Identity"
            value={user.supabaseId}
          />

          <Row
            icon={<Fingerprint className="h-4 w-4 text-muted-foreground" />}
            label="E2EE Identity"
            value={identityStatus}
          />

          <Row
            icon={<Network className="h-4 w-4 text-muted-foreground" />}
            label="IP Address"
            value={lastLogin?.ip || 'Unknown'}
          />

          <Row
            icon={<Globe className="h-4 w-4 text-muted-foreground" />}
            label="Location"
            value={`${lastLogin?.country || 'N/A'} - ${lastLogin?.city || 'N/A'}`}
          />

          <Row
            icon={<Calendar className="h-4 w-4 text-muted-foreground" />}
            label="Joined Server"
            value={formatDistanceToNow(user.createdAt, { addSuffix: true })}
          />

          {joinMethod && (
            <Row
              icon={<Ticket className="h-4 w-4 text-muted-foreground" />}
              label="Join Method"
              value={joinMethod.inviteCode}
              details={
                joinMethod.inviterName
                  ? `Invited by ${joinMethod.inviterName}`
                  : undefined
              }
            />
          )}
          {joinMethod?.inviterName && (
            <Row
              icon={<IdCard className="h-4 w-4 text-muted-foreground" />}
              label="Invited By"
              value={joinMethod.inviterName}
            />
          )}

          <Row
            icon={<Clock className="h-4 w-4 text-muted-foreground" />}
            label="Last Active"
            value={formatDistanceToNow(user.lastLoginAt, { addSuffix: true })}
          />

          {user.banned && (
            <>
              <Row
                icon={<Gavel className="h-4 w-4 text-muted-foreground" />}
                label="Banned"
                value="Yes"
              />

              <Row
                icon={<Gavel className="h-4 w-4 text-muted-foreground" />}
                label="Ban Reason"
                value={user.banReason || 'No reason provided'}
              />

              <Row
                icon={<Gavel className="h-4 w-4 text-muted-foreground" />}
                label="Banned At"
                value={format(user.bannedAt ?? 0, 'PPP')}
                details={format(user.bannedAt ?? 0, fullDateTime())}
              />
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
});

export { Details };
