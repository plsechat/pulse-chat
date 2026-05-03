import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { X, type LucideIcon } from 'lucide-react';
import { memo, type ReactNode } from 'react';

/**
 * Shared chrome for the small popover panels that hang off the
 * top-bar action buttons (Pinned Messages, Search, Threads…). The
 * body content of each panel still differs — channel pinned messages
 * vs DM pinned messages have different fetchers and item renderers,
 * search popovers do different queries — but the popover container,
 * the header with title + close button, the entry animation, and the
 * scroll container should all be identical so the surfaces don't
 * drift visually as we change one and forget the other.
 *
 * Caller supplies the body via `children`. Loading and empty states
 * are first-class so callers don't reimplement that styling either.
 */
type TPopoverPanelShellProps = {
  /** Standard header: icon + title. Mutually exclusive with `customHeader`. */
  icon?: LucideIcon;
  title?: string;
  /** Custom header replacing the icon+title layout (e.g. search popovers
      with an inline input). When supplied, render it INSIDE the header
      bar — the close button still gets appended on the right. */
  customHeader?: ReactNode;
  onClose: () => void;
  loading?: boolean;
  loadingMessage?: string;
  empty?: boolean;
  emptyMessage?: string;
  /** Override the default w-96 max-h-96 sizing if a panel needs more room. */
  className?: string;
  /** Header-row trailing content (filters, badges) rendered before the close button. */
  headerExtras?: ReactNode;
  /** Content that sits between header and the scrollable body (e.g. filter bar). */
  toolbar?: ReactNode;
  /** Footer that sits below the scrollable body (e.g. "Load more"). */
  footer?: ReactNode;
  children: ReactNode;
};

const PopoverPanelShell = memo(
  ({
    icon: Icon,
    title,
    customHeader,
    onClose,
    loading,
    loadingMessage = 'Loading…',
    empty,
    emptyMessage = 'Nothing here yet.',
    className,
    headerExtras,
    toolbar,
    footer,
    children
  }: TPopoverPanelShellProps) => {
    return (
      <div
        className={cn(
          'absolute right-0 top-full mt-1 z-50 w-96 max-h-96 overflow-hidden rounded-lg border border-border bg-popover shadow-lg flex flex-col animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 duration-150 origin-top-right',
          className
        )}
      >
        <div className="flex items-center justify-between gap-2 p-3 border-b border-border/30 bg-popover">
          {customHeader ? (
            <div className="flex-1 min-w-0">{customHeader}</div>
          ) : (
            <div className="flex items-center gap-2 min-w-0">
              {Icon && <Icon className="w-4 h-4 shrink-0" />}
              {title && (
                <span className="text-sm font-medium truncate">{title}</span>
              )}
            </div>
          )}
          <div className="flex items-center gap-1 shrink-0">
            {headerExtras}
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              onClick={onClose}
            >
              <X className="w-3 h-3" />
            </Button>
          </div>
        </div>
        {toolbar}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-4 text-center text-sm text-muted-foreground">
              {loadingMessage}
            </div>
          ) : empty ? (
            <div className="p-4 text-center text-sm text-muted-foreground">
              {emptyMessage}
            </div>
          ) : (
            children
          )}
        </div>
        {footer}
      </div>
    );
  }
);

PopoverPanelShell.displayName = 'PopoverPanelShell';

export { PopoverPanelShell };
