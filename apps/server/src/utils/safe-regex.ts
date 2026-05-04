/**
 * Conservative ReDoS validator. JavaScript's RegExp engine is backtracking;
 * patterns like `^(a+)+$` can hang the single-threaded Bun event loop on
 * adversarial input. Real fix is RE2 (linear-time), tracked as a Phase 6
 * follow-up; this is the Phase 1 lockdown.
 *
 * Strategy (defense in depth):
 *   1. Cap pattern length.
 *   2. Static pattern check — scan the regex source for known catastrophic
 *      shapes (nested quantifiers). Reliable across engines.
 *   3. Compile-check.
 *   4. Time against canonical adversarial inputs. Catches what static
 *      detection misses, but is engine-dependent: modern JSC short-circuits
 *      some catastrophic patterns at runtime, which means a fast result
 *      here doesn't always mean the pattern is safe in another runtime.
 *
 * Static detection added 2026-05-02 after the timing-only heuristic accepted
 * `^(a+)+$` on the live server (faster CPU + JSC anti-backtracking than
 * the local test env).
 */

const MAX_PATTERN_LENGTH = 256;
const BUDGET_MS = 50;

const ADVERSARIAL_INPUTS = [
  // Prefix attacks: long run of a single char followed by a non-match
  'a'.repeat(100) + '!',
  'a'.repeat(500) + '!',
  // Alternating chars (defeats some short-circuit heuristics)
  'aA'.repeat(100),
  'ab'.repeat(100) + '!',
  // Common word followed by junk
  'word'.repeat(50) + '!'
];

// Regex shapes that are known to cause catastrophic backtracking in any
// backtracking engine. We match these against the user's regex source text
// directly — independent of any timing measurement.
const STATIC_REDOS_SHAPES: ReadonlyArray<{ name: string; re: RegExp }> = [
  // (X+)+ / (X*)* / (X+)* / (X*)+ — nested quantifier on a group whose
  // contents themselves already contain a quantifier. Covers (a+)+ etc.
  {
    name: 'nested quantifier',
    re: /\([^()]*[*+?][^()]*\)\s*[*+?{]/
  },
  // (.+)+ / (.*)* — wildcard with double quantifier. Subsumed by the rule
  // above for many cases but explicit for clarity in error messages.
  {
    name: 'wildcard with nested quantifier',
    re: /\(\.[*+?]\)\s*[*+?{]/
  },
  // (\w+)+ / (\d*)* / (\s+)+ etc — character-class shorthand with double
  // quantifier.
  {
    name: 'character-class shorthand with nested quantifier',
    re: /\(\\[wdsWDS][*+?]\)\s*[*+?{]/
  }
];

export type SafeRegexResult =
  | { ok: true }
  | { ok: false; reason: string };

export function validateSafeRegex(pattern: string): SafeRegexResult {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return { ok: false, reason: `Pattern exceeds max length (${MAX_PATTERN_LENGTH})` };
  }

  for (const shape of STATIC_REDOS_SHAPES) {
    if (shape.re.test(pattern)) {
      return {
        ok: false,
        reason: `Pattern contains a known catastrophic backtracking shape (${shape.name})`
      };
    }
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
