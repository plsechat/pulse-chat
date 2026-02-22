import { useModViewOpen } from '@/features/app/hooks';
import { closeServerScreens } from '@/features/server-screens/actions';
import { useServerScreenInfo } from '@/features/server-screens/hooks';
import { X } from 'lucide-react';
import { createElement, memo, useCallback, useEffect, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { CategorySettings } from './category-settings';
import { ChannelSettings } from './channel-settings';
import { ServerScreen } from './screens';
import { ServerSettings } from './server-settings';
import { UserSettings } from './user-settings';

const ScreensMap = {
  [ServerScreen.SERVER_SETTINGS]: ServerSettings,
  [ServerScreen.CHANNEL_SETTINGS]: ChannelSettings,
  [ServerScreen.USER_SETTINGS]: UserSettings,
  [ServerScreen.CATEGORY_SETTINGS]: CategorySettings
};

const portalRoot = document.getElementById('portal')!;

type TComponentWrapperProps = {
  children: React.ReactNode;
};

const ComponentWrapper = ({ children }: TComponentWrapperProps) => {
  const { isOpen } = useModViewOpen();

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // when mod view is open, do not close server screens
      if (isOpen) return;

      if (e.key === 'Escape') {
        closeServerScreens();
      }
    },
    [isOpen]
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleKeyDown]);

  return (
    <>
      {/* Darkened backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/60 animate-in fade-in duration-150"
        onClick={closeServerScreens}
      />
      {/* Floating card */}
      <div className="fixed inset-4 md:inset-8 lg:inset-12 z-50 rounded-xl bg-background overflow-hidden shadow-2xl flex flex-col animate-in fade-in zoom-in-95 duration-150">
        <button
          type="button"
          onClick={closeServerScreens}
          className="absolute top-3 right-3 z-10 h-9 w-9 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          <X className="h-5 w-5" />
        </button>
        {children}
      </div>
    </>
  );
};

const ServerScreensProvider = memo(() => {
  const { isOpen, props, openServerScreen } = useServerScreenInfo();

  let component: JSX.Element | null = null;

  if (openServerScreen && ScreensMap[openServerScreen]) {
    const baseProps = {
      ...props,
      isOpen,
      close: closeServerScreens
    };

    // @ts-expect-error - é lidar irmoum
    component = createElement(ScreensMap[openServerScreen], baseProps);
  }

  const realIsOpen = isOpen && !!component;

  if (realIsOpen) {
    portalRoot.style.display = 'block';
  } else {
    portalRoot.style.display = 'none';
  }

  if (!realIsOpen) return null;

  return createPortal(
    <ComponentWrapper>{component}</ComponentWrapper>,
    portalRoot
  );
});

export { ServerScreensProvider };
