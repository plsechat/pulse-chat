/**
 * Native tooltip text for a community entry: the name on the first line
 * and the description, when there is one, below it. Browsers render the
 * newline in a `title`.
 */
const communityTooltip = (
  name: string,
  description?: string | null
): string => {
  const trimmed = description?.trim();
  return trimmed ? `${name}\n${trimmed}` : name;
};

export { communityTooltip };
