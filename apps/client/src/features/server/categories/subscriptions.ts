import { activeServerIdSelector } from '@/features/app/selectors';
import { combineUnsubscribes, subscribe } from '@/lib/subscription-helpers';
import { getTRPCClient } from '@/lib/trpc';
import { store } from '../../store';
import { addCategory, removeCategory, updateCategory } from './actions';

const subscribeToCategories = () => {
  const trpc = getTRPCClient();
  if (!trpc) return () => {};

  return combineUnsubscribes(
    subscribe('onCategoryCreate', trpc.categories.onCreate, (category) => {
      // Mirror the channel-create guard: drop categories that don't
      // belong to the active server (member-server events arriving
      // during a preview, colliding federated numeric ids).
      const activeServerId = activeServerIdSelector(store.getState());
      if (activeServerId && category.serverId !== activeServerId) return;
      addCategory(category);
    }),
    subscribe('onCategoryDelete', trpc.categories.onDelete, (categoryId) =>
      removeCategory(categoryId)
    ),
    subscribe('onCategoryUpdate', trpc.categories.onUpdate, (category) =>
      updateCategory(category.id, category)
    )
  );
};

export { subscribeToCategories };
