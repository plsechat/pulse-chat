import { useChannels } from '@/features/server/channels/hooks';
import { useUsers } from '@/features/server/users/hooks';
import { useDismissOnOutsideClick } from '@/hooks/use-dismiss-on-outside-click';
import { Hash, User, X } from 'lucide-react';
import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { Button } from '../ui/button';

export type TSearchFilters = {
  channelId?: number;
  userId?: number;
  hasFile?: boolean;
  hasLink?: boolean;
};

type TSearchFiltersProps = {
  filters: TSearchFilters;
  onFiltersChange: (filters: TSearchFilters) => void;
};

type TFilterChipProps = {
  label: string;
  onRemove: () => void;
};

const FilterChip = memo(({ label, onRemove }: TFilterChipProps) => (
  <div className="h-6 pl-2.5 pr-1.5 inline-flex items-center gap-1 bg-primary/10 text-primary text-xs rounded-full">
    <span>{label}</span>
    <button type="button" onClick={onRemove} className="hover:text-destructive">
      <X className="w-3 h-3" />
    </button>
  </div>
));

const SearchFilters = memo(({ filters, onFiltersChange }: TSearchFiltersProps) => {
  const channels = useChannels();
  const users = useUsers();
  const [showChannelPicker, setShowChannelPicker] = useState(false);
  const [showUserPicker, setShowUserPicker] = useState(false);

  // The sub-pickers are plain absolute-positioned divs (not Radix), so
  // outside-click dismiss must be wired by hand or they strand open.
  // Each ref wraps trigger + dropdown, matching the top-bar popover
  // pattern (trigger clicks toggle; anything else dismisses). Escape is
  // covered by PopoverPanelShell's window listener closing the whole
  // search popover, which unmounts these with it.
  const channelPickerRef = useRef<HTMLDivElement>(null);
  const userPickerRef = useRef<HTMLDivElement>(null);
  const closeChannelPicker = useCallback(() => setShowChannelPicker(false), []);
  const closeUserPicker = useCallback(() => setShowUserPicker(false), []);
  useDismissOnOutsideClick(showChannelPicker, channelPickerRef, closeChannelPicker);
  useDismissOnOutsideClick(showUserPicker, userPickerRef, closeUserPicker);

  const selectedChannel = useMemo(
    () => channels.find((c) => c.id === filters.channelId),
    [channels, filters.channelId]
  );

  const selectedUser = useMemo(
    () => users.find((u) => u.id === filters.userId),
    [users, filters.userId]
  );

  const removeFilter = useCallback(
    (key: keyof TSearchFilters) => {
      const next = { ...filters };
      delete next[key];
      onFiltersChange(next);
    },
    [filters, onFiltersChange]
  );

  const textChannels = useMemo(
    () => channels.filter((c) => c.type === 'TEXT'),
    [channels]
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {selectedChannel && (
          <FilterChip
            label={`in: #${selectedChannel.name}`}
            onRemove={() => removeFilter('channelId')}
          />
        )}
        {selectedUser && (
          <FilterChip
            label={`from: ${selectedUser.name}`}
            onRemove={() => removeFilter('userId')}
          />
        )}
        {filters.hasFile && (
          <FilterChip
            label="has: file"
            onRemove={() => removeFilter('hasFile')}
          />
        )}
        {filters.hasLink && (
          <FilterChip
            label="has: link"
            onRemove={() => removeFilter('hasLink')}
          />
        )}
      </div>

      <div className="flex flex-wrap gap-1">
        {!filters.channelId && (
          <div className="relative" ref={channelPickerRef}>
            <Button
              variant="secondary"
              size="sm"
              className="h-6 rounded-full px-2.5 text-xs bg-secondary/70 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors duration-150"
              onClick={() => setShowChannelPicker(!showChannelPicker)}
            >
              <Hash className="w-3 h-3 mr-1" />
              Channel
            </Button>
            {showChannelPicker && (
              <div className="absolute top-full left-0 mt-1 z-50 w-48 max-h-40 overflow-y-auto p-1 rounded-md border border-border bg-popover shadow-lg">
                {textChannels.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="w-full text-left rounded-sm px-2 py-1.5 text-xs hover:bg-accent/50 transition-colors duration-100 flex items-center gap-1.5"
                    onClick={() => {
                      onFiltersChange({ ...filters, channelId: c.id });
                      setShowChannelPicker(false);
                    }}
                  >
                    <Hash className="w-3 h-3 text-muted-foreground" />
                    {c.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {!filters.userId && (
          <div className="relative" ref={userPickerRef}>
            <Button
              variant="secondary"
              size="sm"
              className="h-6 rounded-full px-2.5 text-xs bg-secondary/70 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors duration-150"
              onClick={() => setShowUserPicker(!showUserPicker)}
            >
              <User className="w-3 h-3 mr-1" />
              From
            </Button>
            {showUserPicker && (
              <div className="absolute top-full left-0 mt-1 z-50 w-48 max-h-40 overflow-y-auto p-1 rounded-md border border-border bg-popover shadow-lg">
                {users.map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    className="w-full text-left rounded-sm px-2 py-1.5 text-xs hover:bg-accent/50 transition-colors duration-100"
                    onClick={() => {
                      onFiltersChange({ ...filters, userId: u.id });
                      setShowUserPicker(false);
                    }}
                  >
                    {u.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {!filters.hasFile && (
          <Button
            variant="secondary"
            size="sm"
            className="h-6 rounded-full px-2.5 text-xs bg-secondary/70 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors duration-150"
            onClick={() => onFiltersChange({ ...filters, hasFile: true })}
          >
            has: file
          </Button>
        )}

        {!filters.hasLink && (
          <Button
            variant="secondary"
            size="sm"
            className="h-6 rounded-full px-2.5 text-xs bg-secondary/70 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors duration-150"
            onClick={() => onFiltersChange({ ...filters, hasLink: true })}
          >
            has: link
          </Button>
        )}
      </div>
    </div>
  );
});

export { SearchFilters };
