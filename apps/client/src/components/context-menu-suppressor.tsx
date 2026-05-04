import { useEffect } from 'react';

/**
 * Suppress the browser's native context menu everywhere except where the
 * user is editing text (input, textarea, contenteditable).
 *
 * Pulse exposes its own context menus (radix ContextMenu) wherever a
 * right-click action makes sense. Anywhere else — empty space, server
 * icons, member rows without a wired menu, link-preview chrome — the
 * native menu is just noise that breaks the visual style. Suppressing
 * it makes the right-click experience consistent: either the Pulse menu
 * appears, or nothing happens.
 *
 * Radix's ContextMenuTrigger calls preventDefault on its own synthetic
 * onContextMenu handler during the bubble phase, so by the time this
 * document-level listener runs `event.defaultPrevented` will be true
 * for any click that landed inside a Pulse menu — we skip those and
 * leave radix's flow untouched. Otherwise we preventDefault ourselves
 * to keep the browser menu from appearing.
 */
const ContextMenuSuppressor = () => {
  useEffect(() => {
    const handler = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (!target) return;
      // Allow native menu inside editable surfaces so paste / spellcheck
      // / dictionary lookup keep working in the message composer and any
      // text input.
      if (
        target.closest(
          'input, textarea, [contenteditable="true"], [contenteditable=""]'
        )
      ) {
        return;
      }
      // A Pulse ContextMenuTrigger already preventDefault-ed during
      // synthetic-event propagation; respect that.
      if (event.defaultPrevented) return;
      event.preventDefault();
    };
    document.addEventListener('contextmenu', handler);
    return () => document.removeEventListener('contextmenu', handler);
  }, []);
  return null;
};

export { ContextMenuSuppressor };
