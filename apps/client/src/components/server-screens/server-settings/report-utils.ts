/**
 * The name a reviewer should act on: the server nickname they know the
 * person by, disambiguated by the account name when the two differ.
 * The short publicId beside it is the canonical check — it matches the
 * popover's "Copy User ID" and the All Accounts search.
 */
const targetLabel = (r: {
  targetName: string;
  targetNickname: string | null;
}): string =>
  r.targetNickname && r.targetNickname !== r.targetName
    ? `${r.targetNickname} (${r.targetName})`
    : r.targetName;

export { targetLabel };
