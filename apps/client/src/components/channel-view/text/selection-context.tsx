import { createContext, memo, useCallback, useContext, useMemo, useState } from 'react';

type SelectionContextType = {
  selectionMode: boolean;
  selectedIds: Set<number>;
  toggleSelection: (messageId: number) => void;
  clearSelection: () => void;
  enterSelectionMode: () => void;
  exitSelectionMode: () => void;
};

const SelectionContext = createContext<SelectionContextType>({
  selectionMode: false,
  selectedIds: new Set(),
  toggleSelection: () => {},
  clearSelection: () => {},
  enterSelectionMode: () => {},
  exitSelectionMode: () => {}
});

const SelectionProvider = memo(
  ({ children }: { children: React.ReactNode }) => {
    const [selectionMode, setSelectionMode] = useState(false);
    const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

    const toggleSelection = useCallback((messageId: number) => {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(messageId)) next.delete(messageId);
        else next.add(messageId);
        return next;
      });
    }, []);

    const clearSelection = useCallback(() => {
      setSelectedIds(new Set());
    }, []);

    const enterSelectionMode = useCallback(() => {
      setSelectionMode(true);
      setSelectedIds(new Set());
    }, []);

    const exitSelectionMode = useCallback(() => {
      setSelectionMode(false);
      setSelectedIds(new Set());
    }, []);

    const value = useMemo(
      () => ({
        selectionMode,
        selectedIds,
        toggleSelection,
        clearSelection,
        enterSelectionMode,
        exitSelectionMode
      }),
      [
        selectionMode,
        selectedIds,
        toggleSelection,
        clearSelection,
        enterSelectionMode,
        exitSelectionMode
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

export { SelectionProvider, useSelection };
