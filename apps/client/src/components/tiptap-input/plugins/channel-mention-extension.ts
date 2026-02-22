import { mergeAttributes, Node } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import Suggestion from '@tiptap/suggestion';
import {
  ChannelMentionSuggestion,
  CHANNEL_MENTION_STORAGE_KEY,
  type TChannelMentionItem
} from './channel-mention-suggestion';

export const ChannelMentionPluginKey = new PluginKey('channelMention');

export interface ChannelMentionOptions {
  channels: { id: number; name: string; type: string }[];
  suggestion: typeof ChannelMentionSuggestion;
}

export const ChannelMentionExtension = Node.create<ChannelMentionOptions>({
  name: CHANNEL_MENTION_STORAGE_KEY,
  group: 'inline',
  inline: true,
  selectable: false,
  atom: true,

  addOptions() {
    return {
      channels: [],
      suggestion: ChannelMentionSuggestion
    };
  },

  addStorage() {
    return {
      channels: this.options.channels
    };
  },

  addAttributes() {
    return {
      'data-type': {
        default: 'channel-mention',
        parseHTML: (element) => element.getAttribute('data-type'),
        renderHTML: (attributes) => ({
          'data-type': attributes['data-type']
        })
      },
      'data-channel-id': {
        default: null,
        parseHTML: (element) => element.getAttribute('data-channel-id'),
        renderHTML: (attributes) => ({
          'data-channel-id': attributes['data-channel-id']
        })
      },
      'data-channel-name': {
        default: null,
        parseHTML: (element) => element.getAttribute('data-channel-name'),
        renderHTML: (attributes) => ({
          'data-channel-name': attributes['data-channel-name']
        })
      }
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-type="channel-mention"]'
      }
    ];
  },

  renderHTML({ HTMLAttributes }) {
    const name = HTMLAttributes['data-channel-name'] ?? '';

    return [
      'span',
      mergeAttributes({ class: 'mention' }, HTMLAttributes),
      `#${name}`
    ];
  },

  renderText({ node }) {
    return `#${node.attrs['data-channel-name'] ?? ''}`;
  },

  addProseMirrorPlugins() {
    return [
      Suggestion<TChannelMentionItem, TChannelMentionItem>({
        editor: this.editor,
        pluginKey: ChannelMentionPluginKey,
        char: this.options.suggestion.char,
        startOfLine: this.options.suggestion.startOfLine,
        allowSpaces: this.options.suggestion.allowSpaces,
        items: this.options.suggestion.items,
        render: this.options.suggestion.render,
        command: ({ editor, range, props }) => {
          const nodeAfter = editor.view.state.selection.$to.nodeAfter;
          const overrideSpace = nodeAfter?.text?.startsWith(' ');

          if (overrideSpace) {
            range.to += 1;
          }

          editor
            .chain()
            .focus()
            .deleteRange(range)
            .insertContent([
              {
                type: this.name,
                attrs: {
                  'data-type': 'channel-mention',
                  'data-channel-id': String(props.id),
                  'data-channel-name': props.name
                }
              },
              { type: 'text', text: ' ' }
            ])
            .run();

          window.getSelection()?.collapseToEnd();
        }
      })
    ];
  }
});
