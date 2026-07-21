import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { deleteServer } from '@/features/app/actions';
import {
  useActiveInstanceDomain,
  useActiveServerId,
  useJoinedServers
} from '@/features/app/hooks';
import { useCan, useIsInstanceOwner } from '@/features/server/hooks';
import { useOwnUserId } from '@/features/server/users/hooks';
import { Permission } from '@pulse/shared';
import {
  Bot,
  ChevronLeft,
  DoorOpen,
  Globe,
  IdCard,
  Server,
  Settings2,
  Shield,
  Smile,
  Ticket,
  Trash2,
  UserCog,
  Users as UsersIcon,
  Webhook
} from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';
import type { TServerScreenBaseProps } from '../screens';
import { AutoMod } from './automod';
import { Emojis } from './emojis';
import { Federation } from './federation';
import { InstanceRegistration } from './instance-registration';
import { InstanceServers } from './instance-servers';
import { InstanceUsers } from './instance-users';
import { General } from './general';
import { Invites } from './invites';
import { Nameplates } from './nameplates';
import { Roles } from './roles';
import { Users } from './users';
import { Webhooks } from './webhooks';

type Section =
  | 'general'
  | 'roles'
  | 'users'
  | 'invites'
  | 'emojis'
  | 'nameplates'
  | 'webhooks'
  | 'automod'
  | 'federation'
  | 'instance-users'
  | 'instance-servers'
  | 'instance-registration';

type NavItem = {
  id: Section;
  label: string;
  icon: React.ReactNode;
  /** Permission gate; undefined = always allowed once listed. */
  allowed: boolean;
};

const SECTION_TITLES: Record<Section, string> = {
  general: 'General',
  roles: 'Roles',
  users: 'Users',
  invites: 'Invites',
  emojis: 'Emojis',
  nameplates: 'Nameplates',
  webhooks: 'Webhooks',
  automod: 'Auto-Mod',
  federation: 'Federation',
  'instance-users': 'All Accounts',
  'instance-servers': 'All Servers',
  'instance-registration': 'Registration'
};

const SECTION_DESCRIPTIONS: Record<Section, string> = {
  general: 'Name, icon, and how people find and join this server.',
  roles: 'Roles, colors, and what each one can do.',
  users: 'Members, nicknames, kicks, and bans.',
  invites: 'Create and revoke invite links.',
  emojis: 'Custom emoji everyone here can use.',
  nameplates: 'Upload nameplate art members can equip.',
  webhooks: 'Post messages from external services.',
  automod: 'Automatic moderation rules.',
  federation: 'Peer this instance with others.',
  'instance-users':
    'Every account on this instance — ban, unban, or delete any of them.',
  'instance-servers':
    'Every server on this instance, its owner, and what it contains.',
  'instance-registration': 'Who can create accounts on this instance.'
};

const SECTION_COMPONENTS: Record<Section, React.ComponentType> = {
  general: General,
  roles: Roles,
  users: Users,
  invites: Invites,
  emojis: Emojis,
  nameplates: Nameplates,
  webhooks: Webhooks,
  automod: AutoMod,
  federation: Federation,
  'instance-users': InstanceUsers,
  'instance-servers': InstanceServers,
  'instance-registration': InstanceRegistration
};

type TServerSettingsProps = TServerScreenBaseProps;

const ServerSettings = memo(({ close }: TServerSettingsProps) => {
  const can = useCan();
  const isInstanceOwner = useIsInstanceOwner();
  const ownUserId = useOwnUserId();
  const activeServerId = useActiveServerId();
  const activeInstanceDomain = useActiveInstanceDomain();
  const joinedServers = useJoinedServers();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const activeServer = useMemo(
    () => joinedServers.find((s) => s.id === activeServerId),
    [joinedServers, activeServerId]
  );

  const isOwner = ownUserId != null && activeServer?.ownerId === ownUserId;

  const navSections = useMemo(() => {
    const categories: { heading: string; items: NavItem[] }[] = [
      {
        heading: 'Server',
        items: [
          {
            id: 'general',
            label: 'General',
            icon: <Settings2 className="h-4 w-4" />,
            allowed: can(Permission.MANAGE_SETTINGS)
          },
          {
            id: 'roles',
            label: 'Roles',
            icon: <Shield className="h-4 w-4" />,
            allowed: can(Permission.MANAGE_ROLES)
          },
          {
            id: 'users',
            label: 'Users',
            icon: <UsersIcon className="h-4 w-4" />,
            allowed: can(Permission.MANAGE_USERS)
          },
          {
            id: 'invites',
            label: 'Invites',
            icon: <Ticket className="h-4 w-4" />,
            allowed: can(Permission.MANAGE_INVITES)
          }
        ]
      },
      {
        heading: 'Expression',
        items: [
          {
            id: 'emojis',
            label: 'Emojis',
            icon: <Smile className="h-4 w-4" />,
            allowed: can(Permission.MANAGE_EMOJIS)
          },
          {
            id: 'nameplates',
            label: 'Nameplates',
            icon: <IdCard className="h-4 w-4" />,
            allowed: can(Permission.MANAGE_EMOJIS)
          }
        ]
      },
      {
        heading: 'Integrations',
        items: [
          {
            id: 'webhooks',
            label: 'Webhooks',
            icon: <Webhook className="h-4 w-4" />,
            allowed: can(Permission.MANAGE_WEBHOOKS)
          },
          {
            id: 'automod',
            label: 'Auto-Mod',
            icon: <Bot className="h-4 w-4" />,
            allowed: can(Permission.MANAGE_AUTOMOD)
          }
        ]
      },
      {
        // The instance-administration area: everything in this group is
        // the instance owner's alone (the operator who owns the first
        // server), never a mere MANAGE_SETTINGS holder, and only on the
        // home instance (not while viewing a federated server).
        heading: 'Instance',
        items: [
          {
            id: 'instance-users',
            label: 'All Accounts',
            icon: <UserCog className="h-4 w-4" />,
            allowed: !activeInstanceDomain && isInstanceOwner
          },
          {
            id: 'instance-servers',
            label: 'All Servers',
            icon: <Server className="h-4 w-4" />,
            allowed: !activeInstanceDomain && isInstanceOwner
          },
          {
            id: 'instance-registration',
            label: 'Registration',
            icon: <DoorOpen className="h-4 w-4" />,
            allowed: !activeInstanceDomain && isInstanceOwner
          },
          {
            id: 'federation',
            label: 'Federation',
            icon: <Globe className="h-4 w-4" />,
            allowed: !activeInstanceDomain && isInstanceOwner
          }
        ]
      }
    ];

    return categories
      .map((cat) => ({
        ...cat,
        items: cat.items.filter((item) => item.allowed)
      }))
      .filter((cat) => cat.items.length > 0);
  }, [can, activeInstanceDomain, isInstanceOwner]);

  const firstAllowed = navSections[0]?.items[0]?.id ?? 'general';
  const [activeSection, setActiveSection] = useState<Section>(firstAllowed);

  const handleDelete = useCallback(() => {
    if (activeServerId) {
      deleteServer(activeServerId);
    }
  }, [activeServerId]);

  const ActiveComponent = SECTION_COMPONENTS[activeSection];
  const isSectionAllowed = navSections.some((cat) =>
    cat.items.some((item) => item.id === activeSection)
  );

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      {/* Mobile top nav */}
      <div className="flex h-14 items-center gap-4 border-b border-border px-4 md:hidden">
        <Button variant="ghost" size="icon" onClick={close}>
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <h1 className="text-lg font-semibold">Server Settings</h1>
      </div>
      <div className="flex overflow-x-auto border-b border-border px-4 md:hidden">
        {navSections.flatMap((cat) =>
          cat.items.map((item) => (
            <button
              key={item.id}
              onClick={() => setActiveSection(item.id)}
              className={`flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                activeSection === item.id
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {item.icon}
              {item.label}
            </button>
          ))
        )}
        {isOwner && (
          <button
            onClick={() => setShowDeleteConfirm(true)}
            className="flex shrink-0 items-center gap-1.5 border-b-2 border-transparent px-3 py-2 text-sm font-medium text-destructive hover:text-destructive/80 transition-colors"
          >
            <Trash2 className="h-4 w-4" />
            Delete Server
          </button>
        )}
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Desktop sidebar */}
        <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-card md:flex">
          <div className="flex items-center gap-1 px-2 pt-4 pb-2">
            <Button variant="ghost" size="icon" onClick={close}>
              <ChevronLeft className="h-5 w-5" />
            </Button>
            <h1 className="min-w-0 truncate text-lg font-semibold">
              {activeServer?.name ?? 'Server Settings'}
            </h1>
          </div>
          <nav className="flex-1 overflow-y-auto p-2">
            {navSections.map((category) => (
              <div key={category.heading} className="mb-4">
                <h2 className="mb-1 px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {category.heading}
                </h2>
                {category.items.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => setActiveSection(item.id)}
                    className={`flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                      activeSection === item.id
                        ? 'bg-accent text-foreground'
                        : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                    }`}
                  >
                    {item.icon}
                    {item.label}
                  </button>
                ))}
              </div>
            ))}
          </nav>
          {isOwner && (
            <div className="border-t border-border p-2">
              <button
                onClick={() => setShowDeleteConfirm(true)}
                className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium text-destructive hover:bg-destructive/10 transition-colors"
              >
                <Trash2 className="h-4 w-4" />
                Delete Server
              </button>
            </div>
          )}
        </aside>

        {/* Content panel */}
        <main className="flex-1 overflow-y-auto p-6">
          <div className="mx-auto max-w-4xl">
            <div className="mb-6">
              <h2 className="text-xl font-semibold">
                {SECTION_TITLES[activeSection]}
              </h2>
              <p className="text-sm text-muted-foreground">
                {SECTION_DESCRIPTIONS[activeSection]}
              </p>
            </div>
            {isSectionAllowed && <ActiveComponent />}
          </div>
        </main>
      </div>

      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you sure?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete{' '}
              <strong>{activeServer?.name}</strong> and all of its data
              including channels, messages, and members. This action cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDelete}
            >
              Delete Server
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
});

export { ServerSettings };
