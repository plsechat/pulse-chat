import { Dialog } from '@/components/dialogs/dialogs';
import type { TGenericObject } from '@pulse/shared';
import { store } from '../store';
import { dialogSliceActions } from './slice';

type TDialogDispatch = (action: ReturnType<(typeof dialogSliceActions)[keyof typeof dialogSliceActions]>) => unknown;

/**
 * Closing waits out the fade before the dialog stops rendering. A
 * dialog opened inside that window (a confirmation reached from a
 * popover right after a form dialog closed, say) must not be cleared
 * by the earlier close's timer: every open, close and reset starts a
 * new generation and a close only lands if it is still the latest.
 *
 * Built over a dispatcher so the timing can be exercised on a private
 * store; the app binds it to the root store below.
 */
export const createDialogController = (dispatch: TDialogDispatch) => {
  let generation = 0;

  const openDialog = (dialog: Dialog, props?: TGenericObject) => {
    generation += 1;
    dispatch(dialogSliceActions.openDialog({ dialog, props }));
  };

  const closeDialogs = () => {
    const mine = ++generation;
    dispatch(dialogSliceActions.setClosing(true));

    // allow fade out animation to complete before stopping rendering, otherwise it looks choppy
    setTimeout(() => {
      if (mine !== generation) return;
      dispatch(dialogSliceActions.closeDialogs());

      setTimeout(() => {
        // https://github.com/radix-ui/primitives/issues/1241
        // remove this after radix fixes the bug
        document.body.style.pointerEvents = '';
      }, 0);
    }, 150);
  };

  const resetDialogs = () => {
    generation += 1;
    dispatch(dialogSliceActions.resetDialogs());
  };

  return { openDialog, closeDialogs, resetDialogs };
};

const controller = createDialogController((action) => store.dispatch(action));

export const openDialog = controller.openDialog;
export const closeDialogs = controller.closeDialogs;

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

export const resetDialogs = controller.resetDialogs;
