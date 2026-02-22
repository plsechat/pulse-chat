import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { memo } from 'react';

type TShortcut = {
  keys: string[];
  description: string;
};

type TShortcutGroup = {
  title: string;
  shortcuts: TShortcut[];
};

const isMac = navigator.platform.toLowerCase().includes('mac');
const mod = isMac ? '\u2318' : 'Ctrl';

const shortcutGroups: TShortcutGroup[] = [
  {
    title: 'Navigation',
    shortcuts: [
      { keys: [mod, 'K'], description: 'Toggle search' },
      { keys: [mod, '/'], description: 'Show keyboard shortcuts' }
    ]
  },
  {
    title: 'Voice',
    shortcuts: [
      { keys: [mod, 'Shift', 'M'], description: 'Toggle microphone' },
      { keys: [mod, 'Shift', 'D'], description: 'Toggle deafen' }
    ]
  }
];

type TKeyboardShortcutsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const ShortcutKey = ({ label }: { label: string }) => (
  <kbd className="inline-flex items-center justify-center min-w-[24px] h-6 px-1.5 rounded bg-muted border border-border text-xs font-mono text-foreground">
    {label}
  </kbd>
);

const KeyboardShortcutsDialog = memo(
  ({ open, onOpenChange }: TKeyboardShortcutsDialogProps) => {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Keyboard Shortcuts</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            {shortcutGroups.map((group) => (
              <div key={group.title}>
                <h3 className="text-xs font-semibold uppercase text-muted-foreground mb-2">
                  {group.title}
                </h3>
                <div className="space-y-2">
                  {group.shortcuts.map((shortcut) => (
                    <div
                      key={shortcut.description}
                      className="flex items-center justify-between py-1"
                    >
                      <span className="text-sm text-foreground">
                        {shortcut.description}
                      </span>
                      <div className="flex items-center gap-1">
                        {shortcut.keys.map((key, i) => (
                          <span key={i} className="flex items-center gap-1">
                            {i > 0 && (
                              <span className="text-muted-foreground text-xs">+</span>
                            )}
                            <ShortcutKey label={key} />
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    );
  }
);

export { KeyboardShortcutsDialog };
