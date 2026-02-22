import { createContext, memo, useCallback, useContext, useMemo, useRef, useState } from 'react';

type SelectionContextType = {
  selectionMode: boolean;
  selectedIds: Set<number>;
  handleSelect: (messageId: number, modifiers: { shift?: boolean; ctrl?: boolean }) => void;
  clearSelection: () => void;
  enterSelectionMode: () => void;
  exitSelectionMode: () => void;
  setMessageIds: (ids: number[]) => void;
};

const SelectionContext = createContext<SelectionContextType>({
  selectionMode: false,
  selectedIds: new Set(),
  handleSelect: () => {},
  clearSelection: () => {},
  enterSelectionMode: () => {},
  exitSelectionMode: () => {},
  setMessageIds: () => {}
});

const SelectionProvider = memo(
  ({ children }: { children: React.ReactNode }) => {
    const [selectionMode, setSelectionMode] = useState(false);
    const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
    const lastSelectedIdRef = useRef<number | null>(null);
    const messageIdsRef = useRef<number[]>([]);

    const setMessageIds = useCallback((ids: number[]) => {
      messageIdsRef.current = ids;
    }, []);

    const handleSelect = useCallback(
      (messageId: number, modifiers: { shift?: boolean; ctrl?: boolean }) => {
        setSelectedIds((prev) => {
          // Shift+Click: select range from last selected to current
          if (modifiers.shift && lastSelectedIdRef.current !== null) {
            const ids = messageIdsRef.current;
            const lastIdx = ids.indexOf(lastSelectedIdRef.current);
            const currentIdx = ids.indexOf(messageId);

            if (lastIdx !== -1 && currentIdx !== -1) {
              const start = Math.min(lastIdx, currentIdx);
              const end = Math.max(lastIdx, currentIdx);
              const next = new Set(prev);
              for (let i = start; i <= end; i++) {
                next.add(ids[i]!);
              }
              return next;
            }
          }

          // Ctrl/Cmd+Click: toggle individual without clearing others
          if (modifiers.ctrl) {
            const next = new Set(prev);
            if (next.has(messageId)) next.delete(messageId);
            else next.add(messageId);
            lastSelectedIdRef.current = messageId;
            return next;
          }

          // Plain click: toggle individual (same as ctrl for selection mode)
          const next = new Set(prev);
          if (next.has(messageId)) next.delete(messageId);
          else next.add(messageId);
          lastSelectedIdRef.current = messageId;
          return next;
        });
      },
      []
    );

    const clearSelection = useCallback(() => {
      setSelectedIds(new Set());
      lastSelectedIdRef.current = null;
    }, []);

    const enterSelectionMode = useCallback(() => {
      setSelectionMode(true);
      setSelectedIds(new Set());
      lastSelectedIdRef.current = null;
    }, []);

    const exitSelectionMode = useCallback(() => {
      setSelectionMode(false);
      setSelectedIds(new Set());
      lastSelectedIdRef.current = null;
    }, []);

    const value = useMemo(
      () => ({
        selectionMode,
        selectedIds,
        handleSelect,
        clearSelection,
        enterSelectionMode,
        exitSelectionMode,
        setMessageIds
      }),
      [
        selectionMode,
        selectedIds,
        handleSelect,
        clearSelection,
        enterSelectionMode,
        exitSelectionMode,
        setMessageIds
      ]
    );

    return (
      <SelectionContext.Provider value={value}>
        {children}
      </SelectionContext.Provider>
    );
  }
);

const useSelection = () => useContext(SelectionContext);

// eslint-disable-next-line react-refresh/only-export-components
export { SelectionProvider, useSelection };
