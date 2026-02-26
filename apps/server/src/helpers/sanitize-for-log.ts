/**
 * Sanitize user-controlled strings before passing to the logger.
 * Strips newlines and control characters to prevent log injection / log forging.
 */
export function sanitizeForLog(input: unknown): string {
  if (input === null || input === undefined) return '';
  const str = String(input);
  // Replace newlines, carriage returns, and other control characters
  return str.replace(/[\r\n\x00-\x1f\x7f]/g, '');
}
