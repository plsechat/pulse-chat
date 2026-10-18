import { invalidateChannelMembers } from '@/lib/e2ee';
import { combineUnsubscribes, subscribe } from '@/lib/subscription-helpers';
import { getTRPCClient } from '@/lib/trpc';
import { addRole, removeRole, updateRole } from './actions';

const subscribeToRoles = () => {
  const trpc = getTRPCClient();
  if (!trpc) return () => {};

  return combineUnsubscribes(
    subscribe('onRoleCreate', trpc.roles.onCreate, (role) => addRole(role)),
    subscribe('onRoleDelete', trpc.roles.onDelete, (roleId) =>
      removeRole(roleId)
    ),
    subscribe('onRoleUpdate', trpc.roles.onUpdate, (role) => {
      // A permission change on a role can open or close encrypted
      // channels for its members; the SKDM roster cache can't tell
      // which, so drop all of it.
      invalidateChannelMembers();
      updateRole(role.id, role);
    })
  );
};

export { subscribeToRoles };
