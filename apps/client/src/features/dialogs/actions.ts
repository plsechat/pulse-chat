import { Dialog } from '@/components/dialogs/dialogs';
import type { TGenericObject } from '@pulse/shared';
import { store } from '../store';
import { dialogSliceActions } from './slice';

/**
 * Closing waits out the fade before the dialog stops rendering. A
 * dialog opened inside that window (a confirmation reached from a
 * popover right after a form dialog closed, say) must not be cleared
 * by the earlier close's timer: every open or close starts a new
 * generation and a close only lands if it is still the latest.
 */
let dialogGeneration = 0;

export const openDialog = (dialog: Dialog, props?: TGenericObject) => {
  dialogGeneration += 1;
  store.dispatch(dialogSliceActions.openDialog({ dialog, props }));
};

export const closeDialogs = () => {
  const generation = ++dialogGeneration;
  store.dispatch(dialogSliceActions.setClosing(true));

  // allow fade out animation to complete before stopping rendering, otherwise it looks choppy
  setTimeout(() => {
    if (generation !== dialogGeneration) return;
    store.dispatch(dialogSliceActions.closeDialogs());

    setTimeout(() => {
      // https://github.com/radix-ui/primitives/issues/1241
      // remove this after radix fixes the bug
      document.body.style.pointerEvents = '';
    }, 0);
  }, 150);
};

export const requestConfirmation = async ({
  title,
  message,
  confirmLabel,
  cancelLabel,
  variant = 'info',
  onConfirm,
  onCancel
}: {
  title?: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'info';
  onConfirm?: () => void;
  onCancel?: () => void;
}): Promise<boolean> => {
  return new Promise((resolve) => {
    openDialog(Dialog.CONFIRM_ACTION, {
      title,
      message,
      confirmLabel,
      cancelLabel,
      variant,
      onConfirm: () => {
        onConfirm?.();
        closeDialogs();
        resolve(true);
      },
      onCancel: () => {
        onCancel?.();
        closeDialogs();
        resolve(false);
      }
    });
  });
};

export const requestTextInput = async ({
  title,
  message,
  confirmLabel,
  cancelLabel,
  type = 'text',
  allowEmpty = false,
  autoClose = true,
  defaultValue
}: {
  title?: string;
  message?: string;
  type?: 'text' | 'password';
  confirmLabel?: string;
  cancelLabel?: string;
  allowEmpty?: boolean;
  autoClose?: boolean;
  defaultValue?: string;
}): Promise<string | undefined | null> => {
  return new Promise((resolve) => {
    openDialog(Dialog.TEXT_INPUT, {
      title,
      message,
      confirmLabel,
      cancelLabel,
      allowEmpty,
      type,
      defaultValue,
      onConfirm: (text: string) => {
        if (autoClose) {
          closeDialogs();
        }

        resolve(text);
      },
      onCancel: () => {
        resolve(null);
      }
    });
  });
};

export const resetDialogs = () => {
  dialogGeneration += 1;
  store.dispatch(dialogSliceActions.resetDialogs());
};
