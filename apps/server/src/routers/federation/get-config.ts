import { getFederationConfig } from '../../utils/federation';
import { instanceOwnerProcedure } from '../../utils/procedures';

const getConfigRoute = instanceOwnerProcedure.query(async () => {
  return getFederationConfig();
});

export { getConfigRoute };
