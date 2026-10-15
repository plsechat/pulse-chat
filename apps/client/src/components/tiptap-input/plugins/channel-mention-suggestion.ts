import { computePosition } from '@floating-ui/dom';
import type { Editor } from '@tiptap/core';
import { ReactRenderer } from '@tiptap/react';
import type {
  SuggestionKeyDownProps,
  SuggestionProps
} from '@tiptap/suggestion';
import {
  ChannelMentionList,
  type ChannelMentionListRef
} from '../channel-mention-list';

export const CHANNEL_MENTION_STORAGE_KEY = 'channelMention';

export type TChannelMentionItem = {
  id: number;
  name: string;
  type: string;
  parentName?: string;
};

export type TChannelMentionStorage = {
  channels: TChannelMentionItem[];
};

declare module '@tiptap/core' {
  interface Storage {
    [CHANNEL_MENTION_STORAGE_KEY]: TChannelMentionStorage;
  }
}

type TChannelMentionSuggestionProps = SuggestionProps<
  TChannelMentionItem,
  TChannelMentionItem
>;

export const ChannelMentionSuggestion = {
  char: '#',
  startOfLine: false,
  allowSpaces: false,
  items: ({ editor, query }: { editor: Editor; query: string }) => {
    const channels: TChannelMentionItem[] =
      editor.storage[CHANNEL_MENTION_STORAGE_KEY]?.channels ?? [];

    const q = query.toLowerCase();

    const textChannels = channels.filter(
      (c) => c.type === 'TEXT' && c.name.toLowerCase().includes(q)
    );
    const forumPosts = channels.filter(
      (c) => c.type === 'THREAD' && c.parentName && c.name.toLowerCase().includes(q)
    );

    return [...textChannels, ...forumPosts].slice(0, 8);
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
      onStart: (props: TChannelMentionSuggestionProps) => {
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
          editor: props.editor
        });

        document.body.appendChild(component.element);
        const rect = props.clientRect?.();
        if (rect) {
          reposition(rect);
        }
      },
      onUpdate(props: TChannelMentionSuggestionProps) {
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
      onKeyDown(props: SuggestionKeyDownProps) {
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
