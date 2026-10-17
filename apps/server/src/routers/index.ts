import { t } from '../utils/trpc';
import { adminRouter } from './admin';
import { categoriesRouter } from './categories';
import { reportsRouter } from './reports';
import { channelsRouter } from './channels';
import { dmsRouter } from './dms';
import { emojisRouter } from './emojis';
import { eventsRouter } from './events';
import { federationRouter } from './federation';
import { filesRouter } from './files';
import { followsRouter } from './follows';
import { friendsRouter } from './friends';
import { importRouter } from './import';
import { invitesRouter } from './invites';
import { messagesRouter } from './messages';
import { nameplatesRouter } from './nameplates';
import { notesRouter } from './notes';
import { notificationsRouter } from './notifications';
import { othersRouter } from './others';
import { scheduledRouter } from './scheduled';
import { searchRouter } from './search';
import { pluginsRouter } from './plugins';
import { pollsRouter } from './polls';
import { rolesRouter } from './roles';
import { serversRouter } from './servers';
import { threadsRouter } from './threads';
import { usersRouter } from './users';
import { voiceRouter } from './voice';
import { webhooksRouter } from './webhooks';
import { automodRouter } from './automod';
import { blocksRouter } from './blocks';
import { e2eeRouter } from './e2ee';

const appRouter = t.router({
  admin: adminRouter,
  reports: reportsRouter,
  others: othersRouter,
  messages: messagesRouter,
  users: usersRouter,
  channels: channelsRouter,
  files: filesRouter,
  emojis: emojisRouter,
  events: eventsRouter,
  nameplates: nameplatesRouter,
  roles: rolesRouter,
  invites: invitesRouter,
  voice: voiceRouter,
  categories: categoriesRouter,
  plugins: pluginsRouter,
  friends: friendsRouter,
  import: importRouter,
  dms: dmsRouter,
  servers: serversRouter,
  notes: notesRouter,
  notifications: notificationsRouter,
  search: searchRouter,
  threads: threadsRouter,
  webhooks: webhooksRouter,
  automod: automodRouter,
  blocks: blocksRouter,
  federation: federationRouter,
  e2ee: e2eeRouter,
  polls: pollsRouter,
  scheduled: scheduledRouter,
  follows: followsRouter
});

type AppRouter = typeof appRouter;

export { appRouter };
export type { AppRouter };
