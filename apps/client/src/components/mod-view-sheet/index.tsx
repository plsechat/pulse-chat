import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { setModViewOpen } from '@/features/app/actions';
import { useModViewOpen } from '@/features/app/hooks';
import { useEscapeKey } from '@/hooks/use-escape-key';
import { lazy, memo, Suspense, useCallback } from 'react';

// The sheet's body (admin data, activity tabs, permissions) is
// moderator-only and never part of the first paint; it loads on first
// open. The placeholder matches the body's own loading state, so an
// opening sheet looks the same whether the chunk or the data is what
// is still arriving.
const ContentWrapper = lazy(() =>
  import('./content-wrapper').then((m) => ({ default: m.ContentWrapper }))
);

const ContentLoading = () => (
  <div className="flex h-full items-center justify-center">
    <p className="text-muted-foreground">Loading...</p>
  </div>
);

const ModViewSheet = memo(() => {
  const { isOpen, userId } = useModViewOpen();

  const handleClose = useCallback(() => {
    setModViewOpen(false);
  }, []);

  useEscapeKey(handleClose, isOpen);

  return (
    <Sheet defaultOpen={false} open={isOpen}>
      <SheetContent close={handleClose}>
        <SheetTitle className="sr-only">User Moderation Panel</SheetTitle>
        {userId && (
          <Suspense fallback={<ContentLoading />}>
            <ContentWrapper userId={userId} />
          </Suspense>
        )}
      </SheetContent>
    </Sheet>
  );
});

export { ModViewSheet };
