import Spinner from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { memo, useEffect, useState } from 'react';

type TLazyFallbackProps = {
  className?: string;
  /** How long to stay invisible before the spinner shows. */
  delayMs?: number;
};

/**
 * Suspense fallback for lazily loaded screens. A chunk that is already
 * cached resolves within a frame or two; painting a spinner for that
 * window would read as a flash on every open. The fallback therefore
 * renders nothing until `delayMs` has passed and only then admits that
 * something is still on its way.
 */
const LazyFallback = memo(({ className, delayMs = 150 }: TLazyFallbackProps) => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs]);

  if (!visible) return null;

  return (
    <div className={cn('flex h-full w-full items-center justify-center p-8', className)}>
      <Spinner size="sm" />
    </div>
  );
});

export { LazyFallback };
