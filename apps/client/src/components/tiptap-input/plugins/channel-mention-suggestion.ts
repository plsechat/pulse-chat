import { computePosition } from '@floating-ui/dom';
import type { Editor } from '@tiptap/core';
import { ReactRenderer } from '@tiptap/react';
import {
  ChannelMentionList,
  type ChannelMentionListRef
} from '../channel-mention-list';

export const CHANNEL_MENTION_STORAGE_KEY = 'channelMention';

export type TChannelMentionItem = {
  id: number;
  name: string;
  type: string;
};

interface SuggestionProps {
  editor: Editor;
  query: string;
  clientRect?: (() => DOMRect | null) | null;
  command: (item: TChannelMentionItem) => void;
}

export const ChannelMentionSuggestion = {
  char: '#',
  startOfLine: false,
  allowSpaces: false,
  items: ({ editor, query }: { editor: Editor; query: string }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const storage = (editor.storage as any)[CHANNEL_MENTION_STORAGE_KEY];
    const channels: { id: number; name: string; type: string }[] =
      storage?.channels ?? [];

    const q = query.toLowerCase();

    return channels
      .filter(
        (c) => c.type === 'TEXT' && c.name.toLowerCase().includes(q)
      )
      .slice(0, 8);
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
        const filteredItems = ChannelMentionSuggestion.items({
          editor: props.editor,
          query: props.query
        });

        component = new ReactRenderer(ChannelMentionList, {
          props: {
            items: filteredItems,
            onSelect: (item: TChannelMentionItem) => {
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
        const filteredItems = ChannelMentionSuggestion.items({
          editor: props.editor,
          query: props.query
        });

        component?.updateProps({
          items: filteredItems,
          onSelect: (item: TChannelMentionItem) => {
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
        const listRef = component?.ref as ChannelMentionListRef | undefined;
        if (listRef?.onKeyDown) {
          return listRef.onKeyDown(props.event);
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
