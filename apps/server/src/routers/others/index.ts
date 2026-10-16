import { t } from '../../utils/trpc';
import { changeLogoRoute } from './change-logo';
import { onServerSettingsUpdateRoute } from './events';
import { getServerEmojisRoute } from './get-server-emojis';
import { getServerMembersRoute } from './get-server-members';
import { getServerVoiceStateRoute } from './get-server-voice-state';
import { getSettingsRoute } from './get-settings';
import { getStorageSettingsRoute } from './get-storage-settings';
import { handshakeRoute } from './handshake';
import { openSessionRoute } from './open-session';
import { updateSettingsRoute } from './update-settings';

export const othersRouter = t.router({
  openSession: openSessionRoute,
  /**
   * @deprecated Alias of `openSession`, kept for one release: federated
   * peers on the previous release call `others.joinServer` over remote
   * tRPC. v0.4.0 ships the alias; delete it in v0.5.0.
   */
  joinServer: openSessionRoute,
  handshake: handshakeRoute,
  updateSettings: updateSettingsRoute,
  changeLogo: changeLogoRoute,
  getSettings: getSettingsRoute,
  getServerMembers: getServerMembersRoute,
  getServerEmojis: getServerEmojisRoute,
  getServerVoiceState: getServerVoiceStateRoute,
  onServerSettingsUpdate: onServerSettingsUpdateRoute,
  getStorageSettings: getStorageSettingsRoute
});
