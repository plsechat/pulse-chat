import { UserAvatar } from '@/components/user-avatar';
import { Globe } from 'lucide-react';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useState
} from 'react';
import type { TMentionItem } from './plugins/mention-suggestion';

interface MentionListProps {
  items: TMentionItem[];
  onSelect: (item: TMentionItem) => void;
}

export interface MentionListRef {
  onKeyDown: (event: KeyboardEvent) => boolean;
}

const MentionList = forwardRef<MentionListRef, MentionListProps>(
  ({ items, onSelect }, ref) => {
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
            key={`${item.type}-${item.id}`}
            className={`w-full text-left px-2 py-1.5 text-sm rounded-sm hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex items-center gap-2 cursor-default select-none outline-none transition-colors ${
              index === selectedIndex ? 'bg-accent text-accent-foreground' : ''
            }`}
            type="button"
            onClick={() => onSelect(item)}
          >
            {item.type === 'all' ? (
              <div className="h-4 w-4 rounded-full shrink-0 bg-amber-500 flex items-center justify-center text-[8px] font-bold text-white">@</div>
            ) : item.type === 'user' ? (
              <UserAvatar
                userId={item.id}
                className="h-5 w-5"
                showStatusBadge={false}
              />
            ) : (
              <div
                className="h-4 w-4 rounded-full shrink-0"
                style={{ backgroundColor: item.color ?? '#808080' }}
              />
            )}
            <span className="truncate">
              {item.type === 'role' || item.type === 'all' ? `@${item.name}` : item.name}
            </span>
            {item.type === 'user' && item._identity?.includes('@') && (
              <Globe className="h-3 w-3 text-blue-500 shrink-0 ml-auto" />
            )}
            {item.type === 'all' && (
              <span className="text-xs text-muted-foreground ml-auto">Everyone</span>
            )}
            {item.type === 'role' && (
              <span className="text-xs text-muted-foreground ml-auto">Role</span>
            )}
          </button>
        ))}
      </div>
    );
  }
);

export { MentionList };
