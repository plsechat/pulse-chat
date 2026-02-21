import { computePosition } from '@floating-ui/dom';
import type { Editor } from '@tiptap/core';
import { ReactRenderer } from '@tiptap/react';
import { MentionList, type MentionListRef } from '../mention-list';

export const MENTION_STORAGE_KEY = 'mention';

export type TMentionItem = {
  type: 'user' | 'role' | 'all';
  id: number;
  name: string;
  avatar?: { name: string } | null;
  color?: string;
  _identity?: string;
};

interface SuggestionProps {
  editor: Editor;
  query: string;
  clientRect?: (() => DOMRect | null) | null;
  command: (item: TMentionItem) => void;
}

export const MentionSuggestion = {
  char: '@',
  startOfLine: false,
  allowSpaces: false,
  items: ({ editor, query }: { editor: Editor; query: string }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const storage = (editor.storage as any)[MENTION_STORAGE_KEY];
    const users: { id: number; name: string; avatar: { name: string } | null; _identity?: string }[] =
      storage?.users ?? [];
    const roles: { id: number; name: string; color: string }[] =
      storage?.roles ?? [];
    const isDm: boolean = storage?.isDm ?? false;
    const ownUserId: number = storage?.ownUserId ?? 0;

    const q = query.toLowerCase();

    // In DMs, only show participant users — no @all or roles
    if (isDm) {
      return users
        .filter((u) => u.id !== ownUserId && u.name.toLowerCase().includes(q))
        .slice(0, 8)
        .map((u) => ({ type: 'user' as const, id: u.id, name: u.name, avatar: u.avatar, _identity: u._identity }));
    }

    // @all mention — show when query matches "all" or "everyone"
    const allItem: TMentionItem[] =
      'all'.includes(q) || 'everyone'.includes(q)
        ? [{ type: 'all', id: 0, name: 'all' }]
        : [];

    const matchedRoles: TMentionItem[] = roles
      .filter((r) => r.name.toLowerCase().includes(q))
      .slice(0, 3)
      .map((r) => ({ type: 'role', id: r.id, name: r.name, color: r.color }));

    const matchedUsers: TMentionItem[] = users
      .filter((u) => u.id !== ownUserId && u.name.toLowerCase().includes(q))
      .slice(0, 8)
      .map((u) => ({ type: 'user', id: u.id, name: u.name, avatar: u.avatar, _identity: u._identity }));

    return [...allItem, ...matchedRoles, ...matchedUsers];
  },
  render: () => {
    let component: ReactRenderer | null = null;

    function reposition(clientRect: DOMRect) {
      if (!component?.element) return;

      const virtualElement = { getBoundingClientRect: () => clientRect };

      computePosition(virtualElement, component.element, {
        placement: 'top-start'
      }).then((pos) => {
        if (component?.element) {
          Object.assign(component.element.style, {
            left: `${pos.x}px`,
            top: `${pos.y}px`,
            position: pos.strategy === 'fixed' ? 'fixed' : 'absolute'
          });
        }
      });
    }

    return {
      onStart: (props: SuggestionProps) => {
        const filteredItems = MentionSuggestion.items({
          editor: props.editor,
          query: props.query
        });

        component = new ReactRenderer(MentionList, {
          props: {
            items: filteredItems,
            onSelect: (item: TMentionItem) => {
              props.command(item);

              if (
                component?.element &&
                document.body.contains(component.element)
              ) {
                document.body.removeChild(component.element);
              }

              component?.destroy();
              component = null;
            }
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          editor: props.editor as any
        });

        document.body.appendChild(component.element);
        const rect = props.clientRect?.();
        if (rect) {
          reposition(rect);
        }
      },
      onUpdate(props: SuggestionProps) {
        const filteredItems = MentionSuggestion.items({
          editor: props.editor,
          query: props.query
        });

        component?.updateProps({
          items: filteredItems,
          onSelect: (item: TMentionItem) => {
            props.command(item);

            if (
              component?.element &&
              document.body.contains(component.element)
            ) {
              document.body.removeChild(component.element);
            }

            component?.destroy();
            component = null;
          }
        });

        const rect = props.clientRect?.();
        if (rect) {
          reposition(rect);
        }
      },
      onKeyDown(props: { event: KeyboardEvent }) {
        const mentionListRef = component?.ref as MentionListRef | undefined;
        if (mentionListRef?.onKeyDown) {
          return mentionListRef.onKeyDown(props.event);
        }
        return false;
      },
      onExit() {
        if (component?.element && document.body.contains(component.element)) {
          document.body.removeChild(component.element);
        }

        component?.destroy();
        component = null;
      }
    };
  }
};
