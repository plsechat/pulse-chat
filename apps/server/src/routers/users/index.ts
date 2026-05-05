import { t } from '../../utils/trpc';
import { addRoleRoute } from './add-role';
import { banRoute } from './ban';
import { changeAvatarRoute } from './change-avatar';
import { changeBannerRoute } from './change-banner';
import {
  onUserCreateRoute,
  onUserDeleteRoute,
  onUserJoinRoute,
  onUserKickedRoute,
  onUserLeaveRoute,
  onUserUpdateRoute
} from './events';
import { getAuthProvidersRoute } from './get-auth-providers';
import { getMyIdRoute } from './get-my-id';
import { getPreferencesRoute } from './get-preferences';
import { getUserInfoRoute } from './get-user-info';
import { getUsersRoute } from './get-users';
import { kickRoute } from './kick';
import { removeRoleRoute } from './remove-role';
import { resolveByDescriptorRoute } from './resolve-by-descriptor';
import { setNicknameRoute, setUserNicknameRoute } from './set-nickname';
import { setStatusRoute } from './set-status';
import { unbanRoute } from './unban';
import { updatePasswordRoute } from './update-password';
import { updatePreferencesRoute } from './update-preferences';
import { updateUserRoute } from './update-user';

export const usersRouter = t.router({
  changeAvatar: changeAvatarRoute,
  changeBanner: changeBannerRoute,
  addRole: addRoleRoute,
  removeRole: removeRoleRoute,
  update: updateUserRoute,
  updatePassword: updatePasswordRoute,
  setStatus: setStatusRoute,
  setNickname: setNicknameRoute,
  setUserNickname: setUserNicknameRoute,
  getInfo: getUserInfoRoute,
  getAll: getUsersRoute,
  getMyId: getMyIdRoute,
  kick: kickRoute,
  ban: banRoute,
  unban: unbanRoute,
  onJoin: onUserJoinRoute,
  onLeave: onUserLeaveRoute,
  onUpdate: onUserUpdateRoute,
  onCreate: onUserCreateRoute,
  onDelete: onUserDeleteRoute,
  getPreferences: getPreferencesRoute,
  updatePreferences: updatePreferencesRoute,
  getAuthProviders: getAuthProvidersRoute,
  onKicked: onUserKickedRoute,
  resolveByDescriptor: resolveByDescriptorRoute
});
