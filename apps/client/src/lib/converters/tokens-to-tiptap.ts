/**
 * Converts token-format plain text back to Tiptap-compatible HTML for editing.
 *
 * Requires context objects for resolving IDs to display names.
 */

export type TokenToTiptapContext = {
  users: Map<number, string>;
  roles: Map<number, string>;
  channels: Map<number, string>;
  emojis: Map<number, { name: string; src: string }>;
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function convertInline(text: string, ctx: TokenToTiptapContext): string {
  let result = text;

  // Custom emoji: <:name:id> → <img>
  result = result.replace(/<:(\w+):(\d+)>/g, (_match, name: string, id: string) => {
    const numId = Number(id);
    const emoji = ctx.emojis.get(numId);
    const src = emoji?.src ?? '';
    return `<img class="emoji-image" data-emoji-name="${escapeHtml(name)}" data-emoji-id="${id}" src="${escapeHtml(src)}" alt="${escapeHtml(name)}" />`;
  });

  // User mention: <@123> → <span>
  result = result.replace(/<@(\d+)>/g, (_match, id: string) => {
    const numId = Number(id);
    const name = ctx.users.get(numId) ?? 'Unknown';
    return `<span data-mention-type="user" data-mention-id="${id}" data-mention-name="${escapeHtml(name)}">@${escapeHtml(name)}</span>`;
  });

  // Role mention: <@&123> → <span>
  result = result.replace(/<@&(\d+)>/g, (_match, id: string) => {
    const numId = Number(id);
    const name = ctx.roles.get(numId) ?? 'Unknown';
    return `<span data-mention-type="role" data-mention-id="${id}" data-mention-name="${escapeHtml(name)}">@${escapeHtml(name)}</span>`;
  });

  // @everyone → <span>
  result = result.replace(/@everyone/g, '<span data-mention-type="all">@all</span>');

  // Channel mention: <#123> → <span>
  result = result.replace(/<#(\d+)>/g, (_match, id: string) => {
    const numId = Number(id);
    const name = ctx.channels.get(numId) ?? 'Unknown';
    return `<span data-type="channel-mention" data-channel-id="${id}" data-channel-name="${escapeHtml(name)}">#${escapeHtml(name)}</span>`;
  });

  // Bold: **text** → <strong>
  result = result.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Italic: *text* → <em>
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');

  // Strikethrough: ~~text~~ → <s>
  result = result.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // Underline: __text__ → <u>
  result = result.replace(/__(.+?)__/g, '<u>$1</u>');

  // Inline code: `code` → <code>
  result = result.replace(/(?<!`)`(?!`)([^`\n]+?)`(?!`)/g, '<code>$1</code>');

  return result;
}

export function tokensToTiptapHtml(
  text: string,
  ctx: TokenToTiptapContext
): string {
  if (!text) return '<p></p>';

  const lines = text.split('\n');
  const htmlParts: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block: ```lang ... ```
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // skip closing ```
      const langClass = lang ? ` class="language-${escapeHtml(lang)}"` : '';
      htmlParts.push(
        `<pre><code${langClass}>${escapeHtml(codeLines.join('\n'))}</code></pre>`
      );
      continue;
    }

    // Blockquote: > text
    if (line.startsWith('> ')) {
      const quoteLines: string[] = [line.slice(2)];
      i++;
      while (i < lines.length && lines[i].startsWith('> ')) {
        quoteLines.push(lines[i].slice(2));
        i++;
      }
      const innerHtml = quoteLines
        .map((l) => `<p>${convertInline(l, ctx)}</p>`)
        .join('');
      htmlParts.push(`<blockquote>${innerHtml}</blockquote>`);
      continue;
    }

    // Regular line → paragraph
    const converted = convertInline(line, ctx);
    htmlParts.push(`<p>${converted}</p>`);
    i++;
  }

  return htmlParts.join('');
}
