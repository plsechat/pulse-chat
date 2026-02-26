import { mergeAttributes, Node } from '@tiptap/core';

/**
 * Custom inline node for server custom emojis.
 *
 * The built-in @tiptap/extension-emoji looks up emojis from `this.options.emojis`
 * (set once at editor creation) which means newly-uploaded custom emojis can't be
 * inserted until the page is refreshed. This extension sidesteps that by storing
 * the emoji id, name, and image URL directly in the node attributes — no lookup needed.
 *
 * Renders as <img data-emoji-id data-emoji-name class="emoji-image" />
 * which matches the format that tiptap-to-tokens.ts already converts to <:name:id>.
 */
export const CustomEmojiNode = Node.create({
  name: 'customEmoji',
  inline: true,
  group: 'inline',
  selectable: false,
  atom: true,

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-emoji-id'),
        renderHTML: (attributes) => ({ 'data-emoji-id': attributes.id })
      },
      name: {
        default: null,
        parseHTML: (element) =>
          element.getAttribute('data-emoji-name') || element.getAttribute('alt'),
        renderHTML: (attributes) => ({ 'data-emoji-name': attributes.name })
      },
      src: {
        default: null,
        parseHTML: (element) => element.getAttribute('src'),
        renderHTML: (attributes) => ({ src: attributes.src })
      }
    };
  },

  parseHTML() {
    return [{ tag: 'img[data-emoji-id]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'img',
      mergeAttributes(HTMLAttributes, {
        class: 'emoji-image',
        draggable: 'false',
        alt: HTMLAttributes['data-emoji-name'] || ''
      })
    ];
  },

  renderText({ node }) {
    return `:${node.attrs.name}:`;
  }
});
