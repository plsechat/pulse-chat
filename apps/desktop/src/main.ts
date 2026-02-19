import { app, BrowserWindow, ipcMain, shell, net, Menu } from 'electron';
import path from 'path';
import { Store } from './lib/store';
import { loadWindowState, trackWindowState } from './lib/window-state';
import { setupPermissions, requestMediaAccess } from './lib/permissions';
import { createTray, destroyTray } from './lib/tray';
import { APP_NAME, PRELOAD_PATH, SERVER_SELECTOR_PATH } from './lib/constants';
import { getDriverStatus, installDriver, uninstallDriver } from './lib/audio-driver';
import { canCaptureSystemAudio, startSystemAudioCapture, stopSystemAudioCapture } from './lib/audio-capture';

const store = new Store();
let mainWindow: BrowserWindow | null = null;
let isQuitting = false;

function disconnectServer(): void {
  store.delete('serverUrl');
  store.delete('serverName');
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadFile(SERVER_SELECTOR_PATH);
  }
}

function createWindow(): BrowserWindow {
  const windowState = loadWindowState(store);

  const win = new BrowserWindow({
    title: APP_NAME,
    width: windowState.width,
    height: windowState.height,
    x: windowState.x,
    y: windowState.y,
    minWidth: 940,
    minHeight: 600,
    backgroundColor: '#313338',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
  });

  if (windowState.isMaximized) {
    win.maximize();
  }

  // Show window when ready
  win.once('ready-to-show', () => {
    win.show();
  });

  // Track window state changes
  trackWindowState(win, store);

  // Setup media permissions
  setupPermissions(win.webContents.session);

  // Handle external links — open in default browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    // Block dangerous URL schemes
    const lower = url.toLowerCase().trim();
    if (lower.startsWith('javascript:') || lower.startsWith('data:') || lower.startsWith('vbscript:')) {
      console.warn('[security] Blocked dangerous URL:', url);
      return { action: 'deny' };
    }

    try {
      const linkUrl = new URL(url);
      const serverUrl = store.get('serverUrl');

      // Allow same-origin navigation (e.g. OAuth popups)
      if (serverUrl) {
        const server = new URL(serverUrl);
        if (linkUrl.origin === server.origin) {
          return { action: 'allow' };
        }
      }

      // Only allow http/https external links
      if (linkUrl.protocol === 'http:' || linkUrl.protocol === 'https:') {
        shell.openExternal(url);
      }
    } catch {
      console.warn('[security] Blocked invalid URL:', url);
    }

    return { action: 'deny' };
  });

  // Minimize to tray on close instead of quitting (opt-in)
  win.on('close', (event) => {
    if (isQuitting) return;

    const minimizeToTray = store.get('minimizeToTray');
    if (minimizeToTray) {
      event.preventDefault();
      win.hide();
    }
  });

  // Load server or selector
  const serverUrl = store.get('serverUrl');
  if (serverUrl) {
    win.loadURL(serverUrl);
  } else {
    win.loadFile(SERVER_SELECTOR_PATH);
  }

  return win;
}

// IPC Handlers
function setupIpcHandlers(): void {
  ipcMain.handle('connect-to-server', async (_event, url: string) => {
    // Normalize URL
    let serverUrl = url.trim();
    if (!serverUrl.startsWith('http://') && !serverUrl.startsWith('https://')) {
      serverUrl = `https://${serverUrl}`;
    }
    // Remove trailing slash
    serverUrl = serverUrl.replace(/\/+$/, '');

    // Validate by fetching /info
    try {
      const response = await net.fetch(`${serverUrl}/info`);
      if (!response.ok) {
        return { success: false, error: `Server returned ${response.status}` };
      }

      const data = (await response.json()) as { name?: string; version?: string };

      store.set('serverUrl', serverUrl);
      store.set('serverName', data.name ?? 'Pulse Server');

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(serverUrl);
      }

      return { success: true, name: data.name, version: data.version };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Connection failed';
      return { success: false, error: message };
    }
  });

  ipcMain.handle('disconnect-server', () => {
    disconnectServer();
  });

  ipcMain.handle('get-settings', () => {
    return store.getAll();
  });

  ipcMain.handle('update-setting', (_event, key: string, value: unknown) => {
    if (key === 'minimizeToTray' && typeof value === 'boolean') {
      store.set('minimizeToTray', value);
    }
  });

  // Audio driver management (macOS)
  ipcMain.handle('audio-driver:status', () => getDriverStatus());
  ipcMain.handle('audio-driver:install', () => installDriver());
  ipcMain.handle('audio-driver:uninstall', () => uninstallDriver());

  // Audio capture lifecycle (macOS)
  ipcMain.handle('audio-capture:available', () => canCaptureSystemAudio());
  ipcMain.handle('audio-capture:start', () => startSystemAudioCapture());
  ipcMain.handle('audio-capture:stop', () => {
    stopSystemAudioCapture();
  });
}

// App lifecycle
app.on('before-quit', () => {
  isQuitting = true;
  destroyTray();
  // Ensure audio capture is cleaned up (restore default output device)
  stopSystemAudioCapture();
});

app.whenReady().then(async () => {
  // Request macOS system-level mic/camera access BEFORE creating the window
  await requestMediaAccess();

  // Application menu (ensures Cmd+Q works on macOS)
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: APP_NAME,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));

  setupIpcHandlers();
  mainWindow = createWindow();
  createTray(mainWindow, store, disconnectServer);

  app.on('activate', () => {
    // macOS: re-create window when dock icon clicked
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
    } else if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
    }
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
