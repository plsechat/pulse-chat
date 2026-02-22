import { useVoice } from '@/features/server/voice/hooks';
import { useEffect, useState } from 'react';

export const useKeyboardShortcuts = () => {
  const [shortcutsDialogOpen, setShortcutsDialogOpen] = useState(false);
  const voiceControls = useVoice();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ctrl+/ — toggle shortcuts dialog
      if ((e.metaKey || e.ctrlKey) && e.key === '/') {
        e.preventDefault();
        setShortcutsDialogOpen((prev) => !prev);
        return;
      }

      // Ctrl+Shift+M — toggle mic
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        voiceControls.toggleMic?.();
        return;
      }

      // Ctrl+Shift+D — toggle deafen
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        voiceControls.toggleSound?.();
        return;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [voiceControls]);

  return {
    shortcutsDialogOpen,
    setShortcutsDialogOpen
  };
};
