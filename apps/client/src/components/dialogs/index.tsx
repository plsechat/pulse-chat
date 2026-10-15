import { closeDialogs } from '@/features/dialogs/actions';
import { useDialogInfo } from '@/features/dialogs/hooks';
import { createElement, memo, type ComponentType } from 'react';
import { AssignRoleDialog } from './assign-role';
import ConfirmActionDialog from './confirm-action';
import { CreateCategoryDialog } from './create-category';
import { CreateChannelDialog } from './create-channel';
import { CreateInviteDialog } from './create-invite-dialog';
import { CreateServerDialog } from './create-server';
import { Dialog } from './dialogs';
import IdentityChangedDialog from './identity-changed';
import { PluginCommandsDialog } from './plugin-commands';
import { PluginLogsDialog } from './plugin-logs';
import { PluginSettingsDialog } from './plugin-settings';
import { TextInputDialog } from './text-input';
import type { TDialogBaseProps, TDialogPropsMap } from './types';

const DialogsMap: { [K in Dialog]: ComponentType<TDialogPropsMap[K]> } = {
  [Dialog.CONFIRM_ACTION]: ConfirmActionDialog,
  [Dialog.CREATE_CHANNEL]: CreateChannelDialog,
  [Dialog.TEXT_INPUT]: TextInputDialog,
  [Dialog.ASSIGN_ROLE]: AssignRoleDialog,
  [Dialog.CREATE_INVITE]: CreateInviteDialog,
  [Dialog.CREATE_CATEGORY]: CreateCategoryDialog,
  [Dialog.PLUGIN_LOGS]: PluginLogsDialog,
  [Dialog.PLUGIN_COMMANDS]: PluginCommandsDialog,
  [Dialog.PLUGIN_SETTINGS]: PluginSettingsDialog,
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

  return renderDialog(openDialog, {
    ...props,
    isOpen: realIsOpen,
    close: closeDialogs
  });
});

export { DialogsProvider };
