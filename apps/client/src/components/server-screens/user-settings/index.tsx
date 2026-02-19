import { Button } from '@/components/ui/button';
import { ChevronLeft, Monitor, Palette, User, Lock, ShieldCheck } from 'lucide-react';
import { memo, useState } from 'react';
import type { TServerScreenBaseProps } from '../screens';
import { Appearance } from './appearance';
import { Devices } from './devices';
import { Encryption } from './encryption';
import { Password } from './password';
import { Profile } from './profile';

type Section = 'profile' | 'password' | 'encryption' | 'appearance' | 'devices';

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
      { id: 'devices', label: 'Voice & Video', icon: <Monitor className="h-4 w-4" /> }
    ]
  }
];

const SECTION_TITLES: Record<Section, string> = {
  profile: 'My Account',
  password: 'Password',
  encryption: 'Encryption',
  appearance: 'Appearance',
  devices: 'Voice & Video'
};

const SECTION_DESCRIPTIONS: Record<Section, string> = {
  profile: 'Update your personal information and settings.',
  password: 'Manage your account password.',
  encryption: 'Manage your end-to-end encryption keys.',
  appearance: 'Customize how the app looks.',
  devices: 'Configure your audio and video devices.'
};

const SECTION_COMPONENTS: Record<Section, React.ComponentType> = {
  profile: Profile,
  password: Password,
  encryption: Encryption,
  appearance: Appearance,
  devices: Devices
};

type TUserSettingsProps = TServerScreenBaseProps;

const UserSettings = memo(({ close }: TUserSettingsProps) => {
  const [activeSection, setActiveSection] = useState<Section>('profile');
  const ActiveComponent = SECTION_COMPONENTS[activeSection];

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* Mobile top nav */}
      <div className="flex h-14 items-center gap-4 border-b border-border px-4 md:hidden">
        <Button variant="ghost" size="icon" onClick={close}>
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <h1 className="text-lg font-semibold">Settings</h1>
      </div>
      <div className="flex overflow-x-auto border-b border-border px-4 md:hidden">
        {NAV_SECTIONS.flatMap((cat) =>
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
            {NAV_SECTIONS.map((category) => (
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
