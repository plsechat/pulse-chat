/**
 * Conservative ReDoS validator. JavaScript's RegExp engine is backtracking;
 * patterns like `^(a+)+$` can hang the single-threaded Bun event loop on
 * adversarial input. Real fix is RE2 (linear-time), tracked as a Phase 6
 * follow-up; this is the Phase 1 lockdown.
 *
 * Strategy:
 *   1. Cap pattern length (long patterns are rarely benign automod rules
 *      and give attackers more room to construct catastrophic backtracking).
 *   2. Compile-check.
 *   3. Time the pattern against a small set of canonical adversarial inputs.
 *      Any input that takes longer than `BUDGET_MS` indicates the pattern
 *      backtracks badly — reject it.
 *
 * This catches the well-known shapes (`(a+)+`, `(a*)*`, `(.+)*`, etc.) without
 * needing to parse the regex AST. It is NOT exhaustive; a determined attacker
 * who studies these inputs could craft a pattern that's slow only on different
 * inputs. RE2 is the proper defense.
 */

const MAX_PATTERN_LENGTH = 256;
const BUDGET_MS = 50;

const ADVERSARIAL_INPUTS = [
  // Prefix attacks: long run of a single char followed by a non-match
  'a'.repeat(50) + '!',
  'a'.repeat(100) + '!',
  // Alternating chars
  'aA'.repeat(50),
  'ab'.repeat(50) + '!',
  // Common word followed by junk
  'word'.repeat(25) + '!'
];

export type SafeRegexResult =
  | { ok: true }
  | { ok: false; reason: string };

export function validateSafeRegex(pattern: string): SafeRegexResult {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return { ok: false, reason: `Pattern exceeds max length (${MAX_PATTERN_LENGTH})` };
  }

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, 'i');
  } catch (err) {
    return { ok: false, reason: `Invalid regex: ${(err as Error).message}` };
  }

  for (const input of ADVERSARIAL_INPUTS) {
    const start = performance.now();
    try {
      regex.test(input);
    } catch {
      // engine threw — treat as unsafe
      return { ok: false, reason: 'Regex engine threw on canonical input' };
    }
    const elapsed = performance.now() - start;
    if (elapsed > BUDGET_MS) {
      return {
        ok: false,
        reason: `Pattern is too slow (${elapsed.toFixed(1)}ms on adversarial input — possible ReDoS)`
      };
    }
  }

  return { ok: true };
}
