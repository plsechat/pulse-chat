import type { TAssignRoleDialogProps } from './assign-role';
import type { TConfirmActionDialogProps } from './confirm-action';
import type { TCreateCategoryDialogProps } from './create-category';
import type { TCreateChannelDialogProps } from './create-channel';
import type { TCreateInviteDialogProps } from './create-invite-dialog';
import type { TCreatePollDialogProps } from './create-poll';
import type { TCreateServerDialogProps } from './create-server';
import type { Dialog } from './dialogs';
import type { TGroupDmSettingsDialogProps } from './group-dm-settings';
import type { TIdentityChangedDialogProps } from './identity-changed';
import type { TPluginCommandsDialogProps } from './plugin-commands';
import type { TPluginLogsDialogProps } from './plugin-logs';
import type { TPluginSettingsDialogProps } from './plugin-settings';
import type { TSchedulePostDialogProps } from './schedule-post';
import type { TTextInputDialogProps } from './text-input';
import type { TWatchTogetherDialogProps } from './watch-together';

export type TDialogBaseProps = {
  close: () => void;
  isOpen: boolean;
};

/** Props each dialog expects — keeps the dialogs map honest per entry. */
export type TDialogPropsMap = {
  [Dialog.CONFIRM_ACTION]: TConfirmActionDialogProps;
  [Dialog.CREATE_CHANNEL]: TCreateChannelDialogProps;
  [Dialog.TEXT_INPUT]: TTextInputDialogProps;
  [Dialog.ASSIGN_ROLE]: TAssignRoleDialogProps;
  [Dialog.CREATE_INVITE]: TCreateInviteDialogProps;
  [Dialog.CREATE_CATEGORY]: TCreateCategoryDialogProps;
  [Dialog.PLUGIN_LOGS]: TPluginLogsDialogProps;
  [Dialog.PLUGIN_COMMANDS]: TPluginCommandsDialogProps;
  [Dialog.PLUGIN_SETTINGS]: TPluginSettingsDialogProps;
  [Dialog.CREATE_SERVER]: TCreateServerDialogProps;
  [Dialog.IDENTITY_CHANGED]: TIdentityChangedDialogProps;
  [Dialog.GROUP_DM_SETTINGS]: TGroupDmSettingsDialogProps;
  [Dialog.CREATE_POLL]: TCreatePollDialogProps;
  [Dialog.SCHEDULE_POST]: TSchedulePostDialogProps;
  [Dialog.WATCH_TOGETHER]: TWatchTogetherDialogProps;
};
