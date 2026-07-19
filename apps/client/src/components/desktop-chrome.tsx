import { memo, useEffect } from 'react';

/**
 * Desktop-shell (Electron) frameless window integration. When the shell
 * reports 'overlay' chrome (Windows: hidden title bar, floating min/max/
 * close), this:
 *  - tags <html> with `titlebar-overlay` so index.css can turn the top bar
 *    into the window drag region (and pad it clear of the controls), and
 *  - recolors the OS-drawn window controls to the active theme, re-syncing
 *    whenever the ThemeProvider swaps the theme class on <html>.
 *
 * Renders nothing; in the browser (no pulseDesktop) it's a no-op.
 */

const syncOverlayColors = () => {
  const styles = getComputedStyle(document.documentElement);
  const color = styles.getPropertyValue('--background').trim();
  const symbolColor = styles.getPropertyValue('--muted-foreground').trim();
  if (color) {
    window.pulseDesktop?.setTitleBarOverlay?.({ color, symbolColor });
  }
};

const DesktopChrome = memo(() => {
  useEffect(() => {
    let observer: MutationObserver | undefined;
    let cancelled = false;

    window.pulseDesktop?.getWindowChrome?.().then((chrome) => {
      if (cancelled || chrome !== 'overlay') return;

      document.documentElement.classList.add('titlebar-overlay');
      syncOverlayColors();

      // ThemeProvider applies themes as classes on <html> — follow along.
      observer = new MutationObserver(syncOverlayColors);
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class']
      });
    });

    return () => {
      cancelled = true;
      observer?.disconnect();
    };
  }, []);

  return null;
});

export { DesktopChrome };
