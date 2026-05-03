import { Button } from '@/components/ui/button';
import { requestConfirmation } from '@/features/dialogs/actions';
import { disconnectFromServer } from '@/features/server/actions';
import { getTRPCClient } from '@/lib/trpc';
import { ChevronLeft, LogOut, Monitor, Palette, User, Lock, ShieldCheck, Volume2 } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';
import type { TServerScreenBaseProps } from '../screens';
import { Appearance } from './appearance';
import { Devices } from './devices';
import { Encryption } from './encryption';
import { Password } from './password';
import { Profile } from './profile';
import { SoundsNotifications } from './sounds-notifications';

type Section = 'profile' | 'password' | 'encryption' | 'appearance' | 'sounds' | 'devices';

type NavItem = {
  id: Section;
  label: string;
  icon: React.ReactNode;
};

type NavCategory = {
  heading: string;
  items: NavItem[];
};

const NAV_SECTIONS: NavCategory[] = [
  {
    heading: 'User Settings',
    items: [
      { id: 'profile', label: 'My Account', icon: <User className="h-4 w-4" /> },
      { id: 'password', label: 'Password', icon: <Lock className="h-4 w-4" /> },
      { id: 'encryption', label: 'Encryption', icon: <ShieldCheck className="h-4 w-4" /> }
    ]
  },
  {
    heading: 'App Settings',
    items: [
      { id: 'appearance', label: 'Appearance', icon: <Palette className="h-4 w-4" /> },
      { id: 'sounds', label: 'Sounds & Notifications', icon: <Volume2 className="h-4 w-4" /> },
      { id: 'devices', label: 'Voice & Video', icon: <Monitor className="h-4 w-4" /> }
    ]
  }
];

const SECTION_TITLES: Record<Section, string> = {
  profile: 'My Account',
  password: 'Password',
  encryption: 'Encryption',
  appearance: 'Appearance',
  sounds: 'Sounds & Notifications',
  devices: 'Voice & Video'
};

const SECTION_DESCRIPTIONS: Record<Section, string> = {
  profile: 'Update your personal information and settings.',
  password: 'Manage your account password.',
  encryption: 'Manage your end-to-end encryption keys.',
  appearance: 'Customize how the app looks.',
  sounds: 'Control sound effects and desktop notifications.',
  devices: 'Configure your audio and video devices.'
};

const SECTION_COMPONENTS: Record<Section, React.ComponentType> = {
  profile: Profile,
  password: Password,
  encryption: Encryption,
  appearance: Appearance,
  sounds: SoundsNotifications,
  devices: Devices
};

type TUserSettingsProps = TServerScreenBaseProps;

const UserSettings = memo(({ close }: TUserSettingsProps) => {
  const [activeSection, setActiveSection] = useState<Section>('profile');
  // `null` while loading; once resolved, an empty array means we got
  // an answer back and the user has no email-password identity.
  // The Password tab is hidden until we've heard from the server, so a
  // federated user never sees it flicker into view on slow networks.
  const [authProviders, setAuthProviders] = useState<string[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const trpc = getTRPCClient();
    if (!trpc) return;

    trpc.users.getAuthProviders
      .query()
      .then((res) => {
        if (cancelled) return;
        setAuthProviders(res.providers);
      })
      .catch(() => {
        // Network/auth failure — fall back to showing the Password tab
        // rather than hiding it, so a transient error doesn't lock a
        // local-account user out of changing their password. The
        // server-side gate is the authoritative reject.
        if (!cancelled) setAuthProviders(['email']);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const hasPasswordAuth = authProviders?.includes('email') ?? false;
  const visibleNavSections = NAV_SECTIONS.map((cat) => ({
    ...cat,
    items: cat.items.filter((item) => item.id !== 'password' || hasPasswordAuth)
  }));

  // If the user opened the Password section directly (e.g. via deep
  // link) and we've now learned they don't have password auth, bounce
  // them back to Profile so they don't sit on a hidden tab's content.
  useEffect(() => {
    if (
      authProviders !== null &&
      !hasPasswordAuth &&
      activeSection === 'password'
    ) {
      setActiveSection('profile');
    }
  }, [authProviders, hasPasswordAuth, activeSection]);

  const ActiveComponent = SECTION_COMPONENTS[activeSection];

  const handleLogOut = useCallback(async () => {
    const confirmed = await requestConfirmation({
      title: 'Log Out',
      message:
        'Are you sure you want to log out? Your end-to-end encryption keys will be cleared from this device. Make sure you have a backup of your keys before proceeding.',
      confirmLabel: 'Log Out',
      cancelLabel: 'Cancel',
      variant: 'danger'
    });

    if (!confirmed) return;

    disconnectFromServer();
  }, []);

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      {/* Mobile top nav */}
      <div className="flex h-14 items-center gap-4 border-b border-border px-4 md:hidden">
        <Button variant="ghost" size="icon" onClick={close}>
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <h1 className="text-lg font-semibold">Settings</h1>
      </div>
      <div className="flex overflow-x-auto border-b border-border px-4 md:hidden">
        {visibleNavSections.flatMap((cat) =>
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
        <button
          onClick={handleLogOut}
          className="flex shrink-0 items-center gap-1.5 border-b-2 border-transparent px-3 py-2 text-sm font-medium text-destructive hover:text-destructive/80 transition-colors"
        >
          <LogOut className="h-4 w-4" />
          Log Out
        </button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Desktop sidebar */}
        <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-card md:flex">
          <div className="flex h-14 items-center gap-4 border-b border-border px-4">
            <Button variant="ghost" size="icon" onClick={close}>
              <ChevronLeft className="h-5 w-5" />
            </Button>
            <h1 className="text-lg font-semibold">Settings</h1>
          </div>
          <nav className="flex-1 overflow-y-auto p-2">
            {visibleNavSections.map((category) => (
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
          <div className="border-t border-border p-2">
            <button
              onClick={handleLogOut}
              className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium text-destructive hover:bg-destructive/10 transition-colors"
            >
              <LogOut className="h-4 w-4" />
              Log Out
            </button>
          </div>
        </aside>

        {/* Content panel */}
        <main className="flex-1 overflow-y-auto p-6">
          <div className="mx-auto max-w-2xl">
            <div className="mb-6">
              <h2 className="text-xl font-semibold">
                {SECTION_TITLES[activeSection]}
              </h2>
              <p className="text-sm text-muted-foreground">
                {SECTION_DESCRIPTIONS[activeSection]}
              </p>
            </div>
            <ActiveComponent />
          </div>
        </main>
      </div>
    </div>
  );
});

export { UserSettings };
