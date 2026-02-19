import { Toaster } from '@/components/ui/sonner';
import 'prosemirror-view/style/prosemirror.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';

import { StoreDebug } from './components/debug/store-debug.tsx';
import { DevicesProvider } from './components/devices-provider/index.tsx';
import { DialogsProvider } from './components/dialogs/index.tsx';
import { E2EESetupModal } from './components/e2ee-setup-modal.tsx';
import { Routing } from './components/routing/index.tsx';
import { ServerScreensProvider } from './components/server-screens/index.tsx';
import { ThemeProvider } from './components/theme-provider/index.tsx';
import { store } from './features/store.ts';
import { LocalStorageKey } from './helpers/storage.ts';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider
      defaultTheme="dark"
      storageKey={LocalStorageKey.VITE_UI_THEME}
    >
      <Toaster />
      <Provider store={store}>
        <StoreDebug />
        <DevicesProvider>
          <DialogsProvider />
          <E2EESetupModal />
          <ServerScreensProvider />
          <Routing />
        </DevicesProvider>
      </Provider>
    </ThemeProvider>
  </StrictMode>
);
