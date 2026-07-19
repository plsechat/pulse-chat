import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Power, Server } from 'lucide-react';
import { memo, useEffect, useState } from 'react';

const Desktop = memo(() => {
  const [minimizeToTray, setMinimizeToTray] = useState(false);
  const [launchAtLogin, setLaunchAtLogin] = useState(false);

  useEffect(() => {
    window.pulseDesktop?.getSettings().then((s) => {
      setMinimizeToTray(s.minimizeToTray === true);
    });
    window.pulseDesktop?.getStartupEnabled?.().then((enabled) => {
      setLaunchAtLogin(enabled === true);
    });
  }, []);

  const handleMinimizeToTrayChange = (checked: boolean) => {
    setMinimizeToTray(checked);
    window.pulseDesktop?.updateSetting('minimizeToTray', checked);
  };

  const handleLaunchAtLoginChange = (checked: boolean) => {
    setLaunchAtLogin(checked);
    window.pulseDesktop?.setStartupEnabled?.(checked);
  };

  const handleChangeServer = () => {
    window.pulseDesktop?.disconnectServer();
  };

  return (
    <div className="space-y-8">
      {/* Server */}
      <div className="space-y-4">
        <div>
          <h3 className="text-lg font-semibold">Server</h3>
          <p className="text-sm text-muted-foreground">
            Switch to a different Pulse server.
          </p>
        </div>
        <Button variant="destructive" onClick={handleChangeServer}>
          <Server className="mr-2 h-4 w-4" />
          Change Server
        </Button>
      </div>

      {/* System Tray */}
      <div className="space-y-4">
        <div>
          <h3 className="text-lg font-semibold">System Tray</h3>
          <p className="text-sm text-muted-foreground">
            Keep Pulse running in the background when the window is closed.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Switch
            id="minimize-to-tray"
            checked={minimizeToTray}
            onCheckedChange={handleMinimizeToTrayChange}
          />
          <label
            htmlFor="minimize-to-tray"
            className="text-sm font-medium cursor-pointer"
          >
            Minimize to tray on close
          </label>
        </div>
      </div>

      {/* Startup */}
      <div className="space-y-4">
        <div>
          <h3 className="text-lg font-semibold">Startup</h3>
          <p className="text-sm text-muted-foreground">
            Open Pulse automatically when you sign in to your computer.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Switch
            id="launch-at-login"
            checked={launchAtLogin}
            onCheckedChange={handleLaunchAtLoginChange}
          />
          <label
            htmlFor="launch-at-login"
            className="text-sm font-medium cursor-pointer flex items-center gap-2"
          >
            <Power className="h-4 w-4" />
            Launch on startup
          </label>
        </div>
      </div>
    </div>
  );
});

export { Desktop };
