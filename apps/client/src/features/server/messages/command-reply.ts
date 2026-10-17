/**
 * The reply of a plugin command that did not run, read from the command
 * card the server wrote back into the message. The card shows it in
 * place; the person who typed the command also gets it as a toast, since
 * the card may be below the fold or in a channel they have left.
 */
const failedCommandReply = (content: string | null | undefined): string | null => {
  if (!content || !content.includes('<command')) return null;
  if (typeof DOMParser === 'undefined') return null;
  const doc = new DOMParser().parseFromString(content, 'text/html');
  const command = doc.querySelector('command');
  if (!command || command.getAttribute('data-status') !== 'failed') return null;
  const reply = command.getAttribute('data-response')?.trim();
  return reply ? reply.slice(0, 500) : null;
};

export { failedCommandReply };
