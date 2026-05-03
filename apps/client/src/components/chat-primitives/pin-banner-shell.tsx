import { ChevronDown, ChevronUp, Pin } from 'lucide-react';
import { memo, type ReactNode } from 'react';

/**
 * Shared visual shell for the slim "latest pinned message" banner
 * that lives under the channel/DM header. Channel and DM versions
 * fetch from different tRPC procedures, render through different
 * components (channel `MessageRenderer` vs DM's parse+serializer
 * pipeline), and listen to different bus events — but the banner
 * row itself, the expand/collapse interaction, the icon, and the
 * width-clamping rules for attached media are identical.
 *
 * Caller passes the resolved author name + plain-text preview, plus
 * a render-prop for the expanded body. The shell handles toggle
 * state, layout, and the muted background that ties it visually to
 * the surrounding chat surfaces.
 */
type TPinBannerShellProps = {
  authorName: string;
  previewText: string;
  expanded: boolean;
  onToggleExpanded: () => void;
  /** Rendered inside the expanded drawer. Caller controls the actual
   *  message rendering (channel and DM use different renderers). */
  expandedContent: ReactNode;
};

const PinBannerShell = memo(
  ({
    authorName,
    previewText,
    expanded,
    onToggleExpanded,
    expandedContent
  }: TPinBannerShellProps) => {
    return (
      <div className="hidden md:flex flex-col border-b border-border/60 bg-muted/30">
        <button
          type="button"
          onClick={onToggleExpanded}
          className="flex items-center gap-2 px-4 py-1.5 text-xs text-left hover:bg-muted/60 transition-colors cursor-pointer"
          title={expanded ? 'Collapse pinned message' : 'Expand pinned message'}
        >
          <Pin className="h-3 w-3 text-yellow-500 shrink-0" />
          <span className="font-semibold text-foreground/80 shrink-0">
            {authorName}
          </span>
          <span className="text-muted-foreground/80 truncate min-w-0 flex-1">
            {previewText || 'Pinned message'}
          </span>
          {expanded ? (
            <ChevronUp className="h-3 w-3 text-muted-foreground/60 shrink-0" />
          ) : (
            <ChevronDown className="h-3 w-3 text-muted-foreground/60 shrink-0" />
          )}
        </button>
        {expanded && (
          // Width-clamp images and video so wide attachments don't
          // burst the banner. Mirrors the pinned-messages-panel.
          <div className="px-4 pb-2 text-sm overflow-x-hidden [&_img]:max-w-full [&_img]:h-auto [&_video]:max-w-full">
            {expandedContent}
          </div>
        )}
      </div>
    );
  }
);

PinBannerShell.displayName = 'PinBannerShell';

export { PinBannerShell };
