import type { TRole } from '@pulse/shared';
import { X } from 'lucide-react';
import { memo } from 'react';
import { Badge } from '../ui/badge';
import { IconButton } from '../ui/icon-button';

type TRoleBadgeProps = {
  role: TRole;
  onRemoveRole?: (roleId: number, roleName: string) => void;
};

/**
 * Neutral chip + colored dot, never colored text. Role colors are
 * arbitrary user-chosen hexes — painting the text with them is unreadable
 * whenever the color sits near the surface tone (white roles on light
 * themes were literally invisible). The dot carries the color at any
 * value (a faint ring seats pale dots on pale chips); the label stays at
 * full foreground contrast in every theme.
 */
const RoleBadge = memo(({ role, onRemoveRole }: TRoleBadgeProps) => {
  return (
    <Badge
      variant="secondary"
      className="gap-1.5 border border-border/60 bg-muted/60 text-foreground"
    >
      <span
        className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-inset ring-black/10 dark:ring-white/15"
        style={{ backgroundColor: role.color }}
      />
      {role.name}
      {onRemoveRole && (
        <IconButton
          icon={X}
          size="xs"
          aria-label={`Remove ${role.name} role`}
          className="text-muted-foreground hover:text-foreground"
          onClick={() => onRemoveRole(role.id, role.name)}
        />
      )}
    </Badge>
  );
});

export { RoleBadge };
