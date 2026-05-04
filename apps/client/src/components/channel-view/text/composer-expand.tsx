import { ChevronDown, ChevronUp } from 'lucide-react';
import { memo, useCallback, useEffect, useRef } from 'react';

const MIN_COMPOSER_HEIGHT = 120;
const MAX_COMPOSER_HEIGHT_RATIO = 0.8;

/**
 * Toggle button to flip the composer between single-line and multiline
 * modes. In multiline mode plain Enter inserts a newline and Shift+Enter
 * sends — the inverse of the default. The chevron points up when collapsed
 * (clicking expands) and down when expanded (clicking collapses), matching
 * the user's mental model of "pull the composer up to grow it".
 */
const ComposerExpandToggle = memo(
  ({
    expanded,
    onToggle
  }: {
    expanded: boolean;
    onToggle: () => void;
  }) => {
    return (
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center justify-center w-full h-4 rounded-t text-muted-foreground/60 hover:text-foreground hover:bg-muted/40 transition-colors cursor-pointer"
        title={
          expanded
            ? 'Collapse composer (Enter sends)'
            : 'Expand composer (Shift+Enter sends, drag the top edge to resize)'
        }
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronUp className="h-3 w-3" />
        )}
      </button>
    );
  }
);

/**
 * Drag handle painted along the top edge of the expanded composer.
 * Mouse-down captures the pointer; mouse-move computes the new height
 * relative to the original mouseDown anchor so the visible top edge
 * tracks the cursor exactly. The height is clamped to [MIN, 80% of
 * viewport] so the user can't shrink it below the toggle's reach or
 * push the message list off-screen.
 */
const ComposerResizer = memo(
  ({
    height,
    onHeightChange
  }: {
    height: number;
    onHeightChange: (h: number) => void;
  }) => {
    const startRef = useRef<{ y: number; height: number } | null>(null);

    const onMouseMove = useCallback(
      (e: MouseEvent) => {
        if (!startRef.current) return;
        const deltaY = startRef.current.y - e.clientY;
        const next = startRef.current.height + deltaY;
        const max = window.innerHeight * MAX_COMPOSER_HEIGHT_RATIO;
        const clamped = Math.max(MIN_COMPOSER_HEIGHT, Math.min(max, next));
        onHeightChange(clamped);
      },
      [onHeightChange]
    );

    const onMouseUp = useCallback(() => {
      startRef.current = null;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }, [onMouseMove]);

    const onMouseDown = useCallback(
      (e: React.MouseEvent) => {
        e.preventDefault();
        startRef.current = { y: e.clientY, height };
        document.body.style.cursor = 'ns-resize';
        document.body.style.userSelect = 'none';
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
      },
      [height, onMouseMove, onMouseUp]
    );

    useEffect(
      () => () => {
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
      },
      [onMouseMove, onMouseUp]
    );

    return (
      <div
        onMouseDown={onMouseDown}
        className="h-1 w-full cursor-ns-resize bg-border/40 hover:bg-primary/40 transition-colors"
        aria-label="Resize composer"
      />
    );
  }
);

export {
  ComposerExpandToggle,
  ComposerResizer,
  MIN_COMPOSER_HEIGHT
};
