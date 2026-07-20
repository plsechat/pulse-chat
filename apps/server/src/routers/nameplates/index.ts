import { t } from '../../utils/trpc';
import { addNameplateRoute } from './add-nameplate';
import { deleteNameplateRoute } from './delete-nameplate';
import { getNameplatesRoute } from './get-nameplates';

export const nameplatesRouter = t.router({
  add: addNameplateRoute,
  delete: deleteNameplateRoute,
  getAll: getNameplatesRoute
});
