import z from 'zod';
import { pluginManager } from '../../plugins';
import { instanceOwnerProcedure } from '../../utils/procedures';
import {
  pluginIdSchema,
  settingKeySchema,
  settingValueSchema
} from './schemas';

const updateSettingRoute = instanceOwnerProcedure
  .input(
    z.object({
      pluginId: pluginIdSchema,
      key: settingKeySchema,
      value: settingValueSchema
    })
  )
  .mutation(async ({ input }) => {
    await pluginManager.updatePluginSetting(
      input.pluginId,
      input.key,
      input.value
    );
  });

export { updateSettingRoute };
