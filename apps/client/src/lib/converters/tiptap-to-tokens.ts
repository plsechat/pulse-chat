/**
 * Converts Tiptap HTML output to plain text with token syntax.
 *
 * Token format:
 *   User mention:    <@123>
 *   Role mention:    <@&456>
 *   @all:            @everyone
 *   Channel mention: <#789>
 *   Custom emoji:    <:name:42>
 *   Formatting:      **bold**, *italic*, ~~strike~~, `code`, ```lang\ncode\n```, > blockquote
 *   Paragraphs:      \n separated
 *   Links:           bare URL text
 */

function walkNodes(nodes: NodeListOf<ChildNode>, ctx: WalkContext): string {
  let result = '';
  for (const node of nodes) {
    result += walkNode(node, ctx);
  }
  return result;
}

interface WalkContext {
  insidePre: boolean;
  insideBlockquote: boolean;
}

function walkNode(node: Node, ctx: WalkContext): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ?? '';
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return '';

  const el = node as Element;
  const tag = el.tagName.toLowerCase();

  // --- Mention spans ---
  if (tag === 'span' && el.getAttribute('data-mention-type')) {
    const type = el.getAttribute('data-mention-type');
    const id = el.getAttribute('data-mention-id');

    if (type === 'all') return '@everyone';
    if (type === 'role' && id) return `<@&${id}>`;
    if (type === 'user' && id) return `<@${id}>`;
    return el.textContent ?? '';
  }

  // --- Channel mention spans ---
  if (
    tag === 'span' &&
    el.getAttribute('data-type') === 'channel-mention'
  ) {
    const id = el.getAttribute('data-channel-id');
    if (id) return `<#${id}>`;
    return el.textContent ?? '';
  }

  // --- Custom emoji & standard emoji images ---
  if (tag === 'img') {
    const emojiId = el.getAttribute('data-emoji-id');
    const emojiName = el.getAttribute('data-emoji-name') || el.getAttribute('alt');

    // Custom server emoji with an ID
    if (emojiId && emojiName) {
      return `<:${emojiName}:${emojiId}>`;
    }

    // Standard emoji rendered as img (Tiptap emoji extension) — use alt text (unicode or name)
    if (
      el.classList.contains('emoji-image') ||
      el.getAttribute('data-type') === 'emoji'
    ) {
      const alt = el.getAttribute('alt');
      if (alt) return alt;
    }

    return '';
  }

  // --- Code blocks: <pre><code>...</code></pre> ---
  if (tag === 'pre') {
    const codeEl = el.querySelector('code');
    if (codeEl) {
      const langClass = codeEl.getAttribute('class') ?? '';
      const lang = langClass.replace('language-', '');
      const code = codeEl.textContent ?? '';
      return `\`\`\`${lang}\n${code}\n\`\`\``;
    }
    return `\`\`\`\n${el.textContent ?? ''}\n\`\`\``;
  }

  // --- Inline code (not inside <pre>) ---
  if (tag === 'code' && !ctx.insidePre) {
    return `\`${el.textContent ?? ''}\``;
  }

  // --- Formatting ---
  if (tag === 'strong' || tag === 'b') {
    const inner = walkNodes(el.childNodes, ctx);
    return `**${inner}**`;
  }

  if (tag === 'em' || tag === 'i') {
    const inner = walkNodes(el.childNodes, ctx);
    return `*${inner}*`;
  }

  if (tag === 's' || tag === 'del') {
    const inner = walkNodes(el.childNodes, ctx);
    return `~~${inner}~~`;
  }

  if (tag === 'u') {
    const inner = walkNodes(el.childNodes, ctx);
    return `__${inner}__`;
  }

  // --- Blockquote ---
  if (tag === 'blockquote') {
    const inner = walkNodes(el.childNodes, { ...ctx, insideBlockquote: true });
    // Prefix each line with >
    const lines = inner.split('\n');
    return lines
      .map((line) => `> ${line}`)
      .join('\n');
  }

  // --- Links ---
  if (tag === 'a') {
    const href = el.getAttribute('href');
    if (href) return href;
    return el.textContent ?? '';
  }

  // --- Paragraphs ---
  if (tag === 'p') {
    const inner = walkNodes(el.childNodes, ctx);
    return inner + '\n';
  }

  // --- Line breaks ---
  if (tag === 'br') {
    return '\n';
  }

  // --- Lists ---
  if (tag === 'ul' || tag === 'ol') {
    let result = '';
    let index = 1;
    for (const child of el.children) {
      if (child.tagName.toLowerCase() === 'li') {
        const inner = walkNodes(child.childNodes, ctx);
        const prefix = tag === 'ol' ? `${index}. ` : '- ';
        result += prefix + inner.trimEnd() + '\n';
        index++;
      }
    }
    return result;
  }

  // --- Headings ---
  if (/^h[1-6]$/.test(tag)) {
    const level = Number(tag[1]);
    const inner = walkNodes(el.childNodes, ctx);
    return '#'.repeat(level) + ' ' + inner + '\n';
  }

  // --- Horizontal rule ---
  if (tag === 'hr') {
    return '---\n';
  }

  // --- Divs and other containers: just recurse ---
  return walkNodes(el.childNodes, ctx);
}

/**
 * Convert Tiptap HTML to plain text with token syntax.
 */
export function tiptapHtmlToTokens(html: string): string {
  if (!html) return '';

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  const ctx: WalkContext = { insidePre: false, insideBlockquote: false };
  let result = walkNodes(doc.body.childNodes, ctx);

  // Trim trailing newline (paragraphs add one)
  result = result.replace(/\n+$/, '');

  // Collapse 3+ consecutive newlines to \n\n
  result = result.replace(/\n{3,}/g, '\n\n');

  return result;
}
