import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useUserRoles } from '@/features/server/hooks';
import { Permission } from '@pulse/shared';
import { ShieldCheck } from 'lucide-react';
import { memo, useMemo } from 'react';
import { useModViewContext } from './context';

/**
 * Which moderation-tier permissions this member holds, aggregated across
 * their roles. Everyday-user permissions (send/react/upload/voice) are
 * noise for a mod audit — only the elevated set is listed.
 */

const BASE_PERMISSIONS = new Set<Permission>([
  Permission.SEND_MESSAGES,
  Permission.REACT_TO_MESSAGES,
  Permission.UPLOAD_FILES,
  Permission.JOIN_VOICE_CHANNELS,
  Permission.SHARE_SCREEN,
  Permission.ENABLE_WEBCAM
]);

const prettify = (perm: string) =>
  perm
    .toLowerCase()
    .split('_')
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ');

const ModPermissions = memo(() => {
  const { user } = useModViewContext();
  const userRoles = useUserRoles(user.id);

  const modPerms = useMemo(() => {
    const union = new Set<Permission>();
    for (const role of userRoles) {
      for (const perm of role.permissions) {
        if (!BASE_PERMISSIONS.has(perm)) union.add(perm);
      }
    }
    return Array.from(union).sort();
  }, [userRoles]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5" />
          Mod Permissions
          {modPerms.length > 0 && (
            <span className="ml-auto text-xs font-normal text-muted-foreground">
              {modPerms.length}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {modPerms.length === 0 ? (
          <span className="inline-flex items-center rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-500">
            No Mod Permissions
          </span>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {modPerms.map((perm) => (
              <span
                key={perm}
                className="inline-flex items-center rounded-full bg-muted/60 border border-border/60 px-2.5 py-1 text-xs text-foreground"
              >
                {prettify(perm)}
              </span>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
});

export { ModPermissions };
