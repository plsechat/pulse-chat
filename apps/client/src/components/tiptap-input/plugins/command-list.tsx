import { cn } from '@/lib/utils';
import { Terminal } from 'lucide-react';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from 'react';
import { paletteItemText, type TPalette, type TPaletteItem } from './command-palette';

interface CommandListProps {
  palette: TPalette | null;
  onSelect: (item: TPaletteItem) => void;
}

export interface CommandListRef {
  onKeyDown: (event: KeyboardEvent) => boolean;
}

/**
 * The command palette above the composer: one level at a time (the
 * commands, the verbs of one command, the choices of one argument),
 * each row with the plugin's logo, what to type, what it does and the
 * usage line. Focus stays in the editor; the list is a listbox whose
 * active row the arrow keys move and a live region reads out.
 */
const CommandList = forwardRef<CommandListRef, CommandListProps>(
  ({ palette, onSelect }, ref) => {
    const [selectedIndex, setSelectedIndex] = useState(0);
    const items = useMemo(() => palette?.items ?? [], [palette]);
    const listRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
      setSelectedIndex(0);
    }, [palette]);

    // Keep the active row in view when the arrow keys run past the edge.
    useEffect(() => {
      const active = items[selectedIndex];
      if (!active) return;
      listRef.current
        ?.querySelector(`#${CSS.escape(active.id)}`)
        ?.scrollIntoView({ block: 'nearest' });
    }, [items, selectedIndex]);

    const selectItem = useCallback(
      (index: number) => {
        const item = items[index];
        if (item) {
          onSelect(item);
        }
      },
      [items, onSelect]
    );

    const onKeyDown = useCallback(
      (event: KeyboardEvent): boolean => {
        if (items.length === 0) return false;

        switch (event.key) {
          case 'ArrowUp':
            event.preventDefault();
            setSelectedIndex((prev) =>
              prev <= 0 ? items.length - 1 : prev - 1
            );
            return true;
          case 'ArrowDown':
            event.preventDefault();
            setSelectedIndex((prev) =>
              prev >= items.length - 1 ? 0 : prev + 1
            );
            return true;
          case 'Enter':
          case 'Tab':
            event.preventDefault();
            selectItem(selectedIndex);
            return true;
          case 'Escape':
            // Not handled here: the suggestion plugin closes the list.
            return false;
          default:
            return false;
        }
      },
      [items, selectItem, selectedIndex]
    );

    useImperativeHandle(ref, () => ({
      onKeyDown
    }));

    if (!palette || items.length === 0) {
      return null;
    }

    const active = items[selectedIndex];
    const headingLogo = palette.level !== 'commands' ? items[0]?.logo : undefined;

    return (
      <div
        data-tiptap-suggestion
        data-testid="command-palette"
        data-level={palette.level}
        className="z-50 flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-border/70 bg-popover text-popover-foreground shadow-md"
      >
        <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5 text-[11px] text-muted-foreground">
          {headingLogo && (
            <img src={headingLogo} alt="" className="size-3.5 rounded-sm object-cover" />
          )}
          <span className={cn('truncate', palette.level !== 'commands' && 'font-mono')}>
            {palette.heading}
          </span>
          <span className="ml-auto shrink-0" aria-hidden="true">
            ↑↓ to choose, Tab to insert
          </span>
        </div>
        <div
          ref={listRef}
          role="listbox"
          aria-label={palette.heading}
          aria-activedescendant={active?.id}
          className="max-h-72 overflow-y-auto p-1"
        >
          {items.map((item, index) => (
            <button
              key={item.id}
              id={item.id}
              role="option"
              aria-selected={index === selectedIndex}
              tabIndex={-1}
              className={cn(
                'grid w-full cursor-default select-none grid-cols-[1.75rem_minmax(0,1fr)] items-start gap-x-2 rounded-lg px-2 py-1.5 text-left outline-none transition-colors hover:bg-accent/60',
                index === selectedIndex && 'bg-accent text-accent-foreground'
              )}
              type="button"
              onMouseMove={() => setSelectedIndex(index)}
              onClick={() => onSelect(item)}
            >
              <span className="flex size-7 items-center justify-center rounded-md bg-muted/70 text-muted-foreground">
                {item.logo ? (
                  <img src={item.logo} alt="" className="size-5 rounded-sm object-cover" />
                ) : (
                  <Terminal className="size-3.5" aria-hidden="true" />
                )}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="shrink-0 text-sm font-medium">{item.title}</span>
                  {item.description && (
                    <span className="truncate text-xs text-muted-foreground">
                      {item.description}
                    </span>
                  )}
                </span>
                {item.signature && (
                  <span className="truncate font-mono text-[11px] leading-4 text-muted-foreground/80">
                    {item.signature}
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>
        {/* Focus never leaves the editor, so the active row is read out here. */}
        <span className="sr-only" role="status" aria-live="polite">
          {active ? paletteItemText(active) : ''}
        </span>
      </div>
    );
  }
);

export { CommandList };
