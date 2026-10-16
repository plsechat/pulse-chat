import { useModViewOpen } from '@/features/app/hooks';
import { closeServerScreens } from '@/features/server-screens/actions';
import { useServerScreenInfo } from '@/features/server-screens/hooks';
import { LazyFallback } from '@/components/lazy-fallback';
import { useEscapeKey } from '@/hooks/use-escape-key';
import { X } from 'lucide-react';
import {
  createElement,
  lazy,
  memo,
  Suspense,
  type ComponentType,
  type JSX
} from 'react';
import { createPortal } from 'react-dom';
import {
  ServerScreen,
  type TServerScreenBaseProps,
  type TServerScreenPropsMap
} from './screens';

// The settings screens are the largest app code outside the chat
// surface and none of them is needed to reach the first message, so
// each loads on first open. The map keeps its static shape so the
// opener-side typing below still holds per screen.
const ScreensMap: {
  [K in ServerScreen]: ComponentType<TServerScreenPropsMap[K]>;
} = {
  [ServerScreen.SERVER_SETTINGS]: lazy(() =>
    import('./server-settings').then((m) => ({ default: m.ServerSettings }))
  ),
  [ServerScreen.CHANNEL_SETTINGS]: lazy(() =>
    import('./channel-settings').then((m) => ({ default: m.ChannelSettings }))
  ),
  [ServerScreen.USER_SETTINGS]: lazy(() =>
    import('./user-settings').then((m) => ({ default: m.UserSettings }))
  ),
  [ServerScreen.CATEGORY_SETTINGS]: lazy(() =>
    import('./category-settings').then((m) => ({ default: m.CategorySettings }))
  )
};

/**
 * Screen-specific props travel through Redux as an untyped record
 * (`openServerScreen(screen, props)`); the opener owns their shape, so
 * this is the one boundary where that record is narrowed to the
 * screen's declared props.
 */
function renderScreen<K extends ServerScreen>(
  screen: K,
  props: TServerScreenBaseProps & Record<string, unknown>
) {
  return createElement(ScreensMap[screen], props as TServerScreenPropsMap[K]);
}

const portalRoot = document.getElementById('portal')!;

type TComponentWrapperProps = {
  children: React.ReactNode;
};

const ComponentWrapper = ({ children }: TComponentWrapperProps) => {
  const { isOpen } = useModViewOpen();

  // When mod view is open, do not close server screens — the mod
  // view sheet has its own escape-handler.
  useEscapeKey(closeServerScreens, !isOpen);

  return (
    <>
      {/* Darkened backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/60 animate-in fade-in duration-150"
        onClick={closeServerScreens}
      />
      {/* Floating card */}
      <div className="fixed inset-6 md:inset-14 lg:inset-20 z-50 rounded-xl bg-background overflow-hidden shadow-2xl flex flex-col animate-in fade-in zoom-in-95 duration-150">
        <button
          type="button"
          onClick={closeServerScreens}
          className="absolute top-3 right-3 z-10 h-9 w-9 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          <X className="h-5 w-5" />
        </button>
        <Suspense fallback={<LazyFallback />}>{children}</Suspense>
      </div>
    </>
  );
};

const ServerScreensProvider = memo(() => {
  const { isOpen, props, openServerScreen } = useServerScreenInfo();

  let component: JSX.Element | null = null;

  if (openServerScreen && ScreensMap[openServerScreen]) {
    component = renderScreen(openServerScreen, {
      ...props,
      isOpen,
      close: closeServerScreens
    });
  }

  const realIsOpen = isOpen && !!component;

  if (realIsOpen) {
    portalRoot.style.display = 'block';
    portalRoot.style.position = 'relative';
    portalRoot.style.zIndex = '50';
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
