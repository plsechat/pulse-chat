import { t } from '../../utils/trpc';
import { acceptInstanceRoute } from './accept-instance';
import { addInstanceRoute } from './add-instance';
import { blockInstanceRoute } from './block-instance';
import { confirmJoinRoute } from './confirm-join';
import { discoverRemoteRoute } from './discover-remote';
import { ensureShadowUserRoute } from './ensure-shadow-user';
import { onFederationInstanceUpdateRoute } from './events';
import { generateKeysRoute } from './generate-keys';
import { getConfigRoute } from './get-config';
import { getJoinedRoute } from './get-joined';
import { joinRemoteRoute } from './join-remote';
import { leaveRemoteRoute } from './leave-remote';
import { listInstancesRoute } from './list-instances';
import { removeInstanceRoute } from './remove-instance';
import { requestTokenRoute } from './request-token';
import { setConfigRoute } from './set-config';

export const federationRouter = t.router({
  getConfig: getConfigRoute,
  setConfig: setConfigRoute,
  generateKeys: generateKeysRoute,
  listInstances: listInstancesRoute,
  addInstance: addInstanceRoute,
  acceptInstance: acceptInstanceRoute,
  removeInstance: removeInstanceRoute,
  blockInstance: blockInstanceRoute,
  requestToken: requestTokenRoute,
  discoverRemote: discoverRemoteRoute,
  joinRemote: joinRemoteRoute,
  confirmJoin: confirmJoinRoute,
  getJoined: getJoinedRoute,
  leaveRemote: leaveRemoteRoute,
  ensureShadowUser: ensureShadowUserRoute,
  onInstanceUpdate: onFederationInstanceUpdateRoute
});
