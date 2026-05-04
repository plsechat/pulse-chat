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
    subscribe('onRoleUpdate', trpc.roles.onUpdate, (role) =>
      updateRole(role.id, role)
    )
  );
};

export { subscribeToRoles };
