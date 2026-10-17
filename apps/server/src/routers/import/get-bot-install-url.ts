import type { TImportBotRequirement } from '../../types';
import { z } from 'zod';
import { IMPORT_BOT_PERMISSION_BITS } from '../../import/mapping';
import { importOwnerProcedure } from './_shared';

/**
 * The bot-install link carries exactly the two permissions the import
 * reads with, nothing more; the two privileged intents cannot travel
 * in a link (they are switched on in the application's settings), so
 * the wizard lists them in plain words next to it.
 */
const BOT_PERMISSIONS: TImportBotRequirement[] = [
  { name: 'View channels', why: 'to see which channels exist and what they are called' },
  { name: 'Read message history', why: 'to copy the messages people posted' }
];

const BOT_INTENTS: TImportBotRequirement[] = [
  { name: 'Server Members Intent', why: 'to list the members, so their names and roles come across' },
  { name: 'Message Content Intent', why: 'to read what messages say (without it they arrive empty)' }
];

const getBotInstallUrlRoute = importOwnerProcedure
  .input(
    z.object({
      applicationId: z.string().regex(/^\d{5,32}$/).optional()
    })
  )
  .query(({ input }) => {
    const url = input.applicationId
      ? `https://discord.com/oauth2/authorize?client_id=${input.applicationId}&scope=bot&permissions=${IMPORT_BOT_PERMISSION_BITS.toString()}`
      : null;

    return { url, permissions: BOT_PERMISSIONS, intents: BOT_INTENTS };
  });

export { getBotInstallUrlRoute };
