import { t } from '../utils/trpc';
import { categoriesRouter } from './categories';
import { channelsRouter } from './channels';
import { dmsRouter } from './dms';
import { emojisRouter } from './emojis';
import { federationRouter } from './federation';
import { filesRouter } from './files';
import { friendsRouter } from './friends';
import { invitesRouter } from './invites';
import { messagesRouter } from './messages';
import { notesRouter } from './notes';
import { notificationsRouter } from './notifications';
import { othersRouter } from './others';
import { searchRouter } from './search';
import { pluginsRouter } from './plugins';
import { rolesRouter } from './roles';
import { serversRouter } from './servers';
import { threadsRouter } from './threads';
import { usersRouter } from './users';
import { voiceRouter } from './voice';
import { webhooksRouter } from './webhooks';
import { automodRouter } from './automod';
import { e2eeRouter } from './e2ee';

const appRouter = t.router({
  others: othersRouter,
  messages: messagesRouter,
  users: usersRouter,
  channels: channelsRouter,
  files: filesRouter,
  emojis: emojisRouter,
  roles: rolesRouter,
  invites: invitesRouter,
  voice: voiceRouter,
  categories: categoriesRouter,
  plugins: pluginsRouter,
  friends: friendsRouter,
  dms: dmsRouter,
  servers: serversRouter,
  notes: notesRouter,
  notifications: notificationsRouter,
  search: searchRouter,
  threads: threadsRouter,
  webhooks: webhooksRouter,
  automod: automodRouter,
  federation: federationRouter,
  e2ee: e2eeRouter
});

type AppRouter = typeof appRouter;

export { appRouter };
export type { AppRouter };
