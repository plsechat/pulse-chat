import { cn } from '@/lib/utils';
import type { LucideIcon } from 'lucide-react';
import { memo, type ReactNode } from 'react';

/**
 * Centered "nothing here yet" panel. Replaces 6+ bespoke
 * implementations that had drifted in spacing, icon size, and font
 * weight (friends panel, DM sidebar, discover, forum, webhooks,
 * plugin-logs). Single shape, one place to tune.
 *
 * Variants:
 *   - `size="lg"` (default): big rounded-muted icon disc + bold
 *     title + small description. The shape used by the canonical
 *     friends-panel empty state. Right for full-pane empties.
 *   - `size="sm"`: bare smaller icon + small text. Right for narrow
 *     sidebar slots (DM list when no DMs yet) where a 64px icon
 *     disc would crowd the column.
 *
 * `description` is optional; many empties only need a title.
 * `action` is a slot for a CTA button (e.g. "Create webhook").
 */
type TEmptyStateProps = {
  icon?: LucideIcon;
  title: string;
  description?: ReactNode;
  size?: 'sm' | 'lg';
  /** Optional CTA rendered below the description. */
  action?: ReactNode;
  /** Outer container className override (for layout positioning). */
  className?: string;
};

const EmptyState = memo(
  ({
    icon: Icon,
    title,
    description,
    size = 'lg',
    action,
    className
  }: TEmptyStateProps) => {
    return (
      <div
        className={cn(
          'flex flex-col items-center justify-center text-center text-muted-foreground',
          size === 'lg' ? 'py-16 gap-1.5' : 'py-8 gap-1',
          className
        )}
      >
        {Icon &&
          (size === 'lg' ? (
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-muted">
              <Icon className="h-8 w-8" />
            </div>
          ) : (
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
              <Icon className="h-6 w-6" />
            </div>
          ))}
        <p
          className={cn(
            'font-medium text-foreground/90',
            size === 'lg' ? 'text-lg' : 'text-sm'
          )}
        >
          {title}
        </p>
        {description && (
          <div
            className={cn(
              'max-w-sm',
              size === 'lg' ? 'text-sm' : 'text-xs'
            )}
          >
            {description}
          </div>
        )}
        {action && <div className="mt-3">{action}</div>}
      </div>
    );
  }
);

EmptyState.displayName = 'EmptyState';

export { EmptyState };
