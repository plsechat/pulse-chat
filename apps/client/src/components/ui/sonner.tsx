import { useTheme } from 'next-themes';
import { useEffect } from 'react';
import { Toaster as Sonner, toast, type ToasterProps } from 'sonner';

/**
 * Dismiss every visible toast when the user clicks outside of any
 * toast. Sonner's defaults auto-dismiss by timeout and support swipe-
 * to-dismiss but don't react to "user clicked somewhere else", which
 * leaves stale success/error toasts hanging around longer than they
 * should. Listening on the document at the capture phase keeps the
 * click from reaching anything else first; ignoring clicks inside
 * `[data-sonner-toaster]` (Sonner's container element) prevents the
 * dismiss-on-click handler that lives on each toast — including the
 * close button — from racing this one.
 */
const useDismissToastsOnOutsideClick = () => {
  useEffect(() => {
    const handler = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (!target) return;
      if (target.closest('[data-sonner-toaster]')) return;
      toast.dismiss();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);
};

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = 'system' } = useTheme();
  useDismissToastsOnOutsideClick();

  return (
    <Sonner
      theme={theme as ToasterProps['theme']}
      className="toaster group"
      // `closeButton` exposes an explicit X on each toast so the user
      // can dismiss without waiting for the timeout; the outside-click
      // hook above covers "I'm done with this toast" without targeting
      // the X specifically.
      closeButton
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)'
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
