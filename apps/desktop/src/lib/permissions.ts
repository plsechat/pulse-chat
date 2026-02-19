import { desktopCapturer, systemPreferences, dialog, shell } from 'electron';
import type { Session } from 'electron';

/** Request macOS system-level mic/camera/screen access. */
export async function requestMediaAccess(): Promise<void> {
  if (process.platform !== 'darwin') return;

  // Mic + Camera — check status first, only prompt if not already granted
  const micCurrent = systemPreferences.getMediaAccessStatus('microphone');
  const camCurrent = systemPreferences.getMediaAccessStatus('camera');

  if (micCurrent !== 'granted') {
    await systemPreferences.askForMediaAccess('microphone');
  }
  if (camCurrent !== 'granted') {
    await systemPreferences.askForMediaAccess('camera');
  }

  console.log(`[permissions] microphone: ${micCurrent}, camera: ${camCurrent}`);

  // Screen Recording — no askForMediaAccess API, must be triggered by usage.
  // Check current status and prompt if needed.
  const screenStatus = systemPreferences.getMediaAccessStatus('screen');
  console.log(`[permissions] screen recording: ${screenStatus}`);

  if (screenStatus !== 'granted') {
    // Trigger the macOS permission prompt by attempting a screen capture.
    // On first run, this causes macOS to show "Pulse would like to record
    // the screen" dialog (on macOS 14+) or add it to System Settings.
    try {
      await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
    } catch {
      // Expected to fail if permission not yet granted
    }

    // Re-check after the attempt
    const updatedStatus = systemPreferences.getMediaAccessStatus('screen');
    console.log(`[permissions] screen recording (after trigger): ${updatedStatus}`);

    if (updatedStatus !== 'granted') {
      // Show a dialog guiding the user to System Settings
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        title: 'Screen Recording Permission Required',
        message: 'Pulse needs Screen & System Audio Recording permission for screen sharing and system audio capture.',
        detail: 'Please grant access in System Settings > Privacy & Security > Screen & System Audio Recording, then restart Pulse.',
        buttons: ['Open System Settings', 'Later'],
        defaultId: 0,
      });

      if (response === 0) {
        // Open the Screen Recording pane in System Settings
        shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
      }
    }
  }
}

export function setupPermissions(session: Session): void {
  // Grant all permission requests from the loaded Pulse server.
  // Electron's default without a handler is to auto-approve, but we set one
  // explicitly to ensure media, display-capture, etc. are always granted.
  const ALLOWED_PERMISSIONS = new Set([
    'media', 'display-capture', 'mediaKeySystem',
    'midi', 'midiSysex', 'notifications', 'fullscreen'
  ]);

  session.setPermissionRequestHandler((_webContents, permission, callback) => {
    const granted = ALLOWED_PERMISSIONS.has(permission);
    console.log(`[permissions] request: ${permission} -> ${granted ? 'granted' : 'denied'}`);
    callback(granted);
  });

  session.setPermissionCheckHandler((_webContents, permission) => {
    const granted = ALLOWED_PERMISSIONS.has(permission);
    console.log(`[permissions] check: ${permission} -> ${granted ? 'granted' : 'denied'}`);
    return granted;
  });

  // Required for getDisplayMedia() — screen sharing in voice channels.
  // On Windows: use the legacy callback path so we can enable loopback audio capture.
  // On macOS/Linux: use the native OS picker (ScreenCaptureKit on macOS) for full
  // hardware-accelerated quality. The legacy desktopCapturer path ignores getDisplayMedia
  // constraints (resolution, frameRate) and throttles bitrate via software encoding.
  if (process.platform === 'win32') {
    session.setDisplayMediaRequestHandler(async (_request, callback) => {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      if (sources.length > 0) {
        callback({ video: sources[0], audio: 'loopback' } as { video: Electron.DesktopCapturerSource });
      }
    });
  } else {
    session.setDisplayMediaRequestHandler(null, { useSystemPicker: true });
  }
}
