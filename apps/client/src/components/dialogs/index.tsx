import { closeDialogs } from '@/features/dialogs/actions';
import { useDialogInfo } from '@/features/dialogs/hooks';
import { createElement, lazy, memo, Suspense, type ComponentType } from 'react';
import { AssignRoleDialog } from './assign-role';
import ConfirmActionDialog from './confirm-action';
import { CreateCategoryDialog } from './create-category';
import { CreateChannelDialog } from './create-channel';
import { CreateServerDialog } from './create-server';
import { Dialog } from './dialogs';
import IdentityChangedDialog from './identity-changed';
import { TextInputDialog } from './text-input';
import type { TDialogBaseProps, TDialogPropsMap } from './types';

// The plugin dialogs are admin-only surfaces with their own form and
// log machinery, and the invite dialog carries the date picker; none
// is part of the first paint, so each loads on first open.
const DialogsMap: { [K in Dialog]: ComponentType<TDialogPropsMap[K]> } = {
  [Dialog.CONFIRM_ACTION]: ConfirmActionDialog,
  [Dialog.CREATE_CHANNEL]: CreateChannelDialog,
  [Dialog.TEXT_INPUT]: TextInputDialog,
  [Dialog.ASSIGN_ROLE]: AssignRoleDialog,
  [Dialog.CREATE_INVITE]: lazy(() =>
    import('./create-invite-dialog').then((m) => ({ default: m.CreateInviteDialog }))
  ),
  [Dialog.CREATE_CATEGORY]: CreateCategoryDialog,
  [Dialog.PLUGIN_LOGS]: lazy(() =>
    import('./plugin-logs').then((m) => ({ default: m.PluginLogsDialog }))
  ),
  [Dialog.PLUGIN_COMMANDS]: lazy(() =>
    import('./plugin-commands').then((m) => ({ default: m.PluginCommandsDialog }))
  ),
  [Dialog.PLUGIN_SETTINGS]: lazy(() =>
    import('./plugin-settings').then((m) => ({ default: m.PluginSettingsDialog }))
  ),
  [Dialog.CREATE_SERVER]: CreateServerDialog,
  [Dialog.IDENTITY_CHANGED]: IdentityChangedDialog
};

/**
 * The dialog-specific props travel through Redux as an untyped record
 * (`openDialog(dialog, props)`); the opener owns their shape, so this
 * is the one boundary where that record is narrowed to the dialog's
 * declared props.
 */
function renderDialog<K extends Dialog>(
  dialog: K,
  props: TDialogBaseProps & Record<string, unknown>
) {
  return createElement(DialogsMap[dialog], props as TDialogPropsMap[K]);
}

const DialogsProvider = memo(() => {
  const { isOpen, openDialog, props, closing } = useDialogInfo();

  if (!openDialog || !DialogsMap[openDialog]) return null;

  const realIsOpen = isOpen && !closing;

  // A lazy dialog's chunk resolves before anything is on screen; the
  // dialog simply opens a beat later, so there is nothing to show
  // meanwhile.
  return (
    <Suspense fallback={null}>
      {renderDialog(openDialog, {
        ...props,
        isOpen: realIsOpen,
        close: closeDialogs
      })}
    </Suspense>
  );
});

export { DialogsProvider };
