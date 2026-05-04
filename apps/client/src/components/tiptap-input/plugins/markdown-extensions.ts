import { markInputRule, markPasteRule } from '@tiptap/core';
import { Bold } from '@tiptap/extension-bold';
import { Underline } from '@tiptap/extension-underline';

// StarterKit's Bold extension matches BOTH `**text**` AND `__text__` for bold.
// Bold is registered before Underline, so its `__` input rule wins and
// `__underline__` becomes bold instead of underline. Strip the underscore
// rules from Bold so MarkdownUnderline below can claim them.
const starInputRegex = /(?:^|\s)(\*\*(?!\s+\*\*)((?:[^*]+))\*\*(?!\s+\*\*))$/;
const starPasteRegex = /(?:^|\s)(\*\*(?!\s+\*\*)((?:[^*]+))\*\*(?!\s+\*\*))/g;

const StarOnlyBold = Bold.extend({
  addInputRules() {
    return [markInputRule({ find: starInputRegex, type: this.type })];
  },
  addPasteRules() {
    return [markPasteRule({ find: starPasteRegex, type: this.type })];
  }
});

// Underline ships without a markdown shortcut. Add `__text__` so it pairs
// with Bold's `**text**`, matching what the renderer (token-content-renderer)
// understands and what users expect from Discord-flavored markdown.
const underscoreInputRegex = /(?:^|\s)(__(?!\s+__)((?:[^_]+))__(?!\s+__))$/;
const underscorePasteRegex = /(?:^|\s)(__(?!\s+__)((?:[^_]+))__(?!\s+__))/g;

const MarkdownUnderline = Underline.extend({
  addInputRules() {
    return [markInputRule({ find: underscoreInputRegex, type: this.type })];
  },
  addPasteRules() {
    return [markPasteRule({ find: underscorePasteRegex, type: this.type })];
  }
});

export { StarOnlyBold, MarkdownUnderline };
