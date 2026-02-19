import { Tray, Menu, nativeImage, app } from 'electron';
import type { BrowserWindow } from 'electron';
import path from 'path';
import type { Store } from './store';

let tray: Tray | null = null;

export function destroyTray(): void {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

export function createTray(win: BrowserWindow, store: Store, onChangeServer: () => void): Tray {
  const iconPath = path.join(__dirname, '..', '..', 'assets', 'icon.png');
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });

  tray = new Tray(icon);
  tray.setToolTip('Pulse');

  const updateMenu = () => {
    const minimizeToTray = store.get('minimizeToTray') ?? false;

    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Show Pulse',
        click: () => {
          win.show();
          win.focus();
        },
      },
      {
        label: 'Minimize to Tray',
        type: 'checkbox',
        checked: minimizeToTray,
        click: (menuItem) => {
          store.set('minimizeToTray', menuItem.checked);
        },
      },
      { type: 'separator' },
      {
        label: 'Change Server',
        click: () => {
          win.show();
          win.focus();
          onChangeServer();
        },
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          app.quit();
        },
      },
    ]);

    tray!.setContextMenu(contextMenu);
  };

  updateMenu();

  tray.on('click', () => {
    if (win.isVisible()) {
      win.hide();
    } else {
      win.show();
      win.focus();
    }
  });

  return tray;
}
