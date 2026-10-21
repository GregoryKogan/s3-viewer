import test from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./loadTs.mjs";

// `loadTs` resolves source paths from the repo root, like the other suites.
const { findMatches, escapeRegExp, MAX_MATCHES } = await loadTs("src/lib/textSearch.ts");

const DEFAULTS = { caseSensitive: false, wholeWord: false, regex: false };
const find = (text, query, overrides = {}) => findMatches(text, query, { ...DEFAULTS, ...overrides });

test("literal queries report every non-overlapping hit with source offsets", () => {
  const result = find("hello world, world!", "world");
  assert.deepEqual(result, {
    matches: [
      { start: 6, end: 11 },
      { start: 13, end: 18 },
    ],
    error: null,
    capped: false,
  });

  // Plain `exec` semantics: the second `aa` in `aaa` overlaps the first.
  assert.deepEqual(find("aaa", "aa").matches, [{ start: 0, end: 2 }]);
});

test("case is ignored by default and respected when asked", () => {
  const text = "Cat cat CAT";
  assert.deepEqual(
    find(text, "cat").matches.map((match) => match.start),
    [0, 4, 8],
  );
  assert.deepEqual(find(text, "cat", { caseSensitive: true }).matches, [{ start: 4, end: 7 }]);
});

test("escapeRegExp turns pattern syntax into literal text", () => {
  assert.equal(escapeRegExp("a+b"), "a\\+b");
  assert.equal(
    escapeRegExp(".*+?^${}()|[]\\"),
    "\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\",
  );
});

test("a literal dot matches only a dot while a regex dot matches any character", () => {
  const text = "a.b axb";
  assert.deepEqual(find(text, ".").matches, [{ start: 1, end: 2 }]);

  const asPattern = find(text, ".", { regex: true });
  assert.equal(asPattern.matches.length, text.length);
  assert.deepEqual(asPattern.matches[0], { start: 0, end: 1 });
  assert.deepEqual(asPattern.matches.at(-1), { start: 6, end: 7 });
});

test("whole word keeps only standalone words in Latin text", () => {
  const text = "cat concatenate cats";
  assert.deepEqual(find(text, "cat", { wholeWord: true }).matches, [{ start: 0, end: 3 }]);
  // Without the toggle the middle of `concatenate` and the prefix of `cats` count.
  assert.equal(find(text, "cat").matches.length, 3);
});

test("whole word treats Unicode letters and digits as word characters", () => {
  assert.deepEqual(find("кот котик коты", "кот", { wholeWord: true }).matches, [{ start: 0, end: 3 }]);
  assert.equal(find("кот котик коты", "кот").matches.length, 3);

  // Underscores and digits are word characters too; only `cat.` is standalone.
  assert.deepEqual(find("cat_1 cat1 _cat cat.", "cat", { wholeWord: true }).matches, [
    { start: 16, end: 19 },
  ]);
});

test("whole word is ignored for regex queries", () => {
  const withToggle = find("concatenate", "cat", { regex: true, wholeWord: true });
  const withoutToggle = find("concatenate", "cat", { regex: true, wholeWord: false });
  assert.deepEqual(withToggle, withoutToggle);
  assert.deepEqual(withToggle.matches, [{ start: 3, end: 6 }]);

  // The pattern alone decides: `\bcat` refuses the same position in both modes.
  assert.deepEqual(find("concatenate", "\\bcat", { regex: true, wholeWord: true }).matches, []);
  assert.deepEqual(find("concatenate", "\\bcat", { regex: true, wholeWord: false }).matches, []);
});

test("invalid regex returns the engine message and no matches", () => {
  let engineMessage = null;
  try {
    new RegExp("(", "giu");
  } catch (error) {
    engineMessage = error.message;
  }
  assert.notEqual(engineMessage, null);

  const result = find("abc", "(", { regex: true });
  assert.deepEqual(result.matches, []);
  assert.equal(result.error, engineMessage);
  assert.equal(result.capped, false);
});

test("empty and whitespace queries follow the literal contract", () => {
  for (const [text, query] of [
    ["", "x"],
    ["some text", ""],
    ["", ""],
  ]) {
    assert.deepEqual(find(text, query), { matches: [], error: null, capped: false });
  }
  // A space is a real query, not something to trim away.
  assert.deepEqual(find("a b", " ").matches, [{ start: 1, end: 2 }]);
});

test("zero-width regex matches are skipped without looping", { timeout: 5000 }, () => {
  assert.deepEqual(find("abc", "^", { regex: true }), { matches: [], error: null, capped: false });
  assert.deepEqual(find("a b", "\\b", { regex: true }), { matches: [], error: null, capped: false });
  // Advancing into a surrogate pair would round `lastIndex` back down and repeat
  // the same match forever, so the loop must step over the whole character.
  assert.deepEqual(find("😀a", "(?=.)", { regex: true }), { matches: [], error: null, capped: false });
});

test("MAX_MATCHES caps a long literal match list", () => {
  assert.equal(MAX_MATCHES, 2000);

  // Exactly at the limit, the result is complete: no hit was cut off.
  const exactly = find("a".repeat(MAX_MATCHES), "a");
  assert.equal(exactly.matches.length, MAX_MATCHES);
  assert.equal(exactly.capped, false);

  const longer = find("a".repeat(MAX_MATCHES + 10), "a");
  assert.equal(longer.error, null);
  assert.equal(longer.capped, true);
  assert.equal(longer.matches.length, MAX_MATCHES);
  assert.deepEqual(longer.matches[0], { start: 0, end: 1 });
  assert.deepEqual(longer.matches.at(-1), { start: MAX_MATCHES - 1, end: MAX_MATCHES });

  const short = find("aaa", "a");
  assert.equal(short.capped, false);
  assert.equal(short.matches.length, 3);

  // Whole-word filtering runs before the cap, so the flag tracks valid hits.
  assert.equal(find("a ".repeat(MAX_MATCHES + 1), "a", { wholeWord: true }).capped, true);
});

test("the Unicode flag powers \\p{L} and keeps astral words intact", () => {
  assert.deepEqual(find("abc 123", "\\p{L}+", { regex: true }).matches, [{ start: 0, end: 3 }]);

  // U+10400 is a letter, so it is a word character even though it is two code units.
  const deseret = String.fromCodePoint(0x10400);
  assert.deepEqual(find(`${deseret}cat cat${deseret} cat`, "cat", { wholeWord: true }).matches, [
    { start: 12, end: 15 },
  ]);
});

test("a lone surrogate query never throws", () => {
  // V8 versions disagree on whether a lone surrogate is a syntax error under the
  // `u` flag; either outcome is fine as long as the matcher returns a result.
  const result = find("a\uD800b", "\uD800");
  assert.equal(result.capped, false);
  if (result.error === null) {
    assert.deepEqual(result.matches, [{ start: 1, end: 2 }]);
  } else {
    assert.deepEqual(result.matches, []);
  }
});
