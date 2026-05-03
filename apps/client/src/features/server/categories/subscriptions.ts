import { combineUnsubscribes, subscribe } from '@/lib/subscription-helpers';
import { getTRPCClient } from '@/lib/trpc';
import { addCategory, removeCategory, updateCategory } from './actions';

const subscribeToCategories = () => {
  const trpc = getTRPCClient();
  if (!trpc) return () => {};

  return combineUnsubscribes(
    subscribe('onCategoryCreate', trpc.categories.onCreate, (category) =>
      addCategory(category)
    ),
    subscribe('onCategoryDelete', trpc.categories.onDelete, (categoryId) =>
      removeCategory(categoryId)
    ),
    subscribe('onCategoryUpdate', trpc.categories.onUpdate, (category) =>
      updateCategory(category.id, category)
    )
  );
};

export { subscribeToCategories };
