import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { WatchPanel } from '@/components/watch-together/watch-panel';
import type { TWatchTarget } from '@/features/app/deck';
import { memo } from 'react';
import type { TDialogBaseProps } from '../types';

export type TWatchTogetherDialogProps = TDialogBaseProps & TWatchTarget;

/**
 * The watch card's player in the traditional layout (and on a phone),
 * where there is no panel column: the same body the tab layout shows in
 * its side panel, in a dialog.
 */
const WatchTogetherDialog = memo(({ isOpen, close, ...target }: TWatchTogetherDialogProps) => (
  <Dialog open={isOpen} onOpenChange={(open) => !open && close()}>
    <DialogContent className="flex max-h-[90vh] w-[min(56rem,calc(100vw-2rem))] max-w-none flex-col gap-0 p-0 sm:max-w-none">
      <DialogHeader className="px-4 pt-4">
        <DialogTitle>Watch together</DialogTitle>
        <DialogDescription className="sr-only">{target.card.title}</DialogDescription>
      </DialogHeader>
      <WatchPanel target={target} />
    </DialogContent>
  </Dialog>
));

export { WatchTogetherDialog };
