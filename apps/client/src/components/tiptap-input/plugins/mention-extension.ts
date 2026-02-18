import { mergeAttributes, Node } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import Suggestion from '@tiptap/suggestion';
import { MentionSuggestion, MENTION_STORAGE_KEY } from './mention-suggestion';
import type { TMentionItem } from './mention-suggestion';

export const MentionPluginKey = new PluginKey('mention');

export interface MentionOptions {
  users: { id: number; name: string; avatar: { name: string } | null }[];
  roles: { id: number; name: string; color: string }[];
  suggestion: typeof MentionSuggestion;
}

export const MentionExtension = Node.create<MentionOptions>({
  name: MENTION_STORAGE_KEY,
  group: 'inline',
  inline: true,
  selectable: false,
  atom: true,

  addOptions() {
    return {
      users: [],
      roles: [],
      suggestion: MentionSuggestion
    };
  },

  addStorage() {
    return {
      users: this.options.users,
      roles: this.options.roles
    };
  },

  addAttributes() {
    return {
      'data-mention-type': {
        default: 'user',
        parseHTML: (element) => element.getAttribute('data-mention-type'),
        renderHTML: (attributes) => ({
          'data-mention-type': attributes['data-mention-type']
        })
      },
      'data-mention-id': {
        default: null,
        parseHTML: (element) => element.getAttribute('data-mention-id'),
        renderHTML: (attributes) => ({
          'data-mention-id': attributes['data-mention-id']
        })
      },
      'data-mention-name': {
        default: null,
        parseHTML: (element) => element.getAttribute('data-mention-name'),
        renderHTML: (attributes) => ({
          'data-mention-name': attributes['data-mention-name']
        })
      }
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-mention-type]'
      }
    ];
  },

  renderHTML({ HTMLAttributes }) {
    const name = HTMLAttributes['data-mention-name'] ?? '';

    return [
      'span',
      mergeAttributes({ class: 'mention' }, HTMLAttributes),
      `@${name}`
    ];
  },

  renderText({ node }) {
    return `@${node.attrs['data-mention-name'] ?? ''}`;
  },

  addProseMirrorPlugins() {
    return [
      Suggestion<TMentionItem, TMentionItem>({
        editor: this.editor,
        pluginKey: MentionPluginKey,
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
                  'data-mention-type': props.type,
                  'data-mention-id': String(props.id),
                  'data-mention-name': props.name
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
