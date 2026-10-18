import { Dialog } from '@/components/dialogs/dialogs';
import { openWatchPanel, type TWatchTarget } from '@/features/app/deck';
import { openDialog } from '@/features/dialogs/actions';
import { getLayoutMode } from '@/hooks/use-appearance-settings';

/** The deck layout is a desktop shell; phones keep the drawer shell (main-view). */
const DECK_MIN_WIDTH = 768;

/**
 * Press Watch on a card: the synced player opens as a side panel in the
 * tab layout and as a dialog in the traditional one (and on a phone,
 * where the panel column does not exist). Same body either way.
 */
export const openWatch = (target: TWatchTarget) => {
  if (getLayoutMode() === 'deck' && window.innerWidth >= DECK_MIN_WIDTH) {
    openWatchPanel(target);
    return;
  }
  openDialog(Dialog.WATCH_TOGETHER, target);
};
