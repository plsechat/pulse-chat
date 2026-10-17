import { useEventEditor, useOpenEventId } from '@/features/events/hooks';
import { lazy, memo, Suspense } from 'react';

// The sheet and the editor are planner surfaces; they load with the
// planner chunk the first time one opens, not with the chat.
const EventSheetHost = lazy(() =>
  import('./event-sheet').then((m) => ({ default: m.EventSheetHost }))
);
const EventEditorHost = lazy(() =>
  import('./event-editor').then((m) => ({ default: m.EventEditorHost }))
);

/**
 * Mount point for the event sheet and the create/edit dialog. Lives in
 * the content wrapper so both open from the planner, from a chat card
 * and from a reminder alike.
 */
const EventSurfaces = memo(() => {
  const eventId = useOpenEventId();
  const editor = useEventEditor();

  if (eventId === undefined && !editor) return null;

  return (
    <Suspense fallback={null}>
      {eventId !== undefined && <EventSheetHost />}
      {editor && <EventEditorHost />}
    </Suspense>
  );
});

export { EventSurfaces };
