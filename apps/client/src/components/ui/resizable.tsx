import { cn } from '@/lib/utils';
import { GripVertical } from 'lucide-react';
import {
  Group,
  Panel,
  Separator,
  type GroupProps,
  type PanelProps,
  type SeparatorProps
} from 'react-resizable-panels';

function ResizablePanelGroup(props: GroupProps) {
  return <Group {...props} />;
}

function ResizablePanel(props: PanelProps) {
  return <Panel {...props} />;
}

function ResizableHandle({
  className,
  ...props
}: SeparatorProps & { className?: string }) {
  return (
    <Separator
      className={cn(
        'relative flex w-px items-center justify-center bg-border',
        'after:absolute after:inset-y-0 after:-left-1 after:-right-1',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1',
        '[&[data-resize-handle-active]]:bg-primary/50',
        className
      )}
      {...props}
    >
      <div className="z-10 flex h-6 w-3 items-center justify-center rounded-sm border bg-border hover:bg-muted-foreground/20 transition-colors">
        <GripVertical className="h-3 w-3 text-muted-foreground" />
      </div>
    </Separator>
  );
}

export { ResizablePanelGroup, ResizablePanel, ResizableHandle };
