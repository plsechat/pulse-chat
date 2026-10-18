import type { TCategorySettingsProps } from './category-settings';
import type { TChannelSettingsProps } from './channel-settings';
import type { TServerSettingsProps } from './server-settings';
import type { TUserSettingsProps } from './user-settings';

export enum ServerScreen {
  SERVER_SETTINGS = 'SERVER_SETTINGS',
  CHANNEL_SETTINGS = 'CHANNEL_SETTINGS',
  CATEGORY_SETTINGS = 'CATEGORY_SETTINGS',
  USER_SETTINGS = 'USER_SETTINGS'
}

export type TServerScreenBaseProps = {
  close: () => void;
  isOpen: boolean;
};

/** Props each screen expects — keeps the screens map honest per entry. */
export type TServerScreenPropsMap = {
  [ServerScreen.SERVER_SETTINGS]: TServerSettingsProps;
  [ServerScreen.CHANNEL_SETTINGS]: TChannelSettingsProps;
  [ServerScreen.USER_SETTINGS]: TUserSettingsProps;
  [ServerScreen.CATEGORY_SETTINGS]: TCategorySettingsProps;
};
