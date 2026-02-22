import { Hash } from 'lucide-react';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useState
} from 'react';
import type { TChannelMentionItem } from './plugins/channel-mention-suggestion';

interface ChannelMentionListProps {
  items: TChannelMentionItem[];
  onSelect: (item: TChannelMentionItem) => void;
}

export interface ChannelMentionListRef {
  onKeyDown: (event: KeyboardEvent) => boolean;
}

const ChannelMentionList = forwardRef<
  ChannelMentionListRef,
  ChannelMentionListProps
>(({ items, onSelect }, ref) => {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    setSelectedIndex(0);
  }, [items]);

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

  if (items.length === 0) {
    return null;
  }

  return (
    <div className="bg-popover text-popover-foreground border rounded-md shadow-md min-w-[14rem] max-w-[20rem] p-1 z-50">
      {items.map((item, index) => (
        <button
          key={item.id}
          className={`w-full text-left px-2 py-1.5 text-sm rounded-sm hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex items-center gap-2 cursor-default select-none outline-none transition-colors ${
            index === selectedIndex ? 'bg-accent text-accent-foreground' : ''
          }`}
          type="button"
          onClick={() => onSelect(item)}
        >
          <Hash className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="truncate">{item.name}</span>
        </button>
      ))}
    </div>
  );
});

export { ChannelMentionList };
