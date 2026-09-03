/**
 * Making two ways of writing the same thing look the same.
 *
 * Everything downstream compares strings: an alias against a question, a code
 * against a chunk, a token against an index. If those comparisons are done on
 * raw text they fail on differences nobody meant — a non-breaking space pasted
 * out of a PDF, an accented letter written two ways, a hyphen that is really an
 * en dash because a word processor helpfully changed it.
 *
 * So there is one place that decides what "the same" means, and everything uses
 * it. Two normalisers that disagree slightly are worse than none: the mismatch
 * only shows up on the words that happen to differ, which is a small enough set
 * that nobody notices for months.
 */

/** Characters a document editor substitutes without being asked. */
const TIDIED = new Map([
  ['‘', "'"],
  ['’', "'"],
  ['‚', "'"],
  ['“', '"'],
  ['”', '"'],
  ['–', '-'],
  ['—', '-'],
  ['−', '-'],
  [' ', ' '],
  [' ', ' '],
  ['​', ''],
  ['﻿', ''],
]);

/**
 * Lower case, one kind of space, one kind of quote, no accents.
 *
 * `NFKD` then stripping the combining marks is what removes the accents: it
 * pulls "è" apart into "e" plus a mark and then drops the mark. Doing it the
 * other way round — a table of accented letters — is a table that is always
 * missing one.
 *
 * The accents go because a question typed in a hurry does not have them and a
 * manual does. Losing the distinction between "e" and "è" costs nothing here:
 * nothing in this project means one when it says the other.
 */
export function normalise(text) {
  let said = String(text ?? '');

  for (const [from, to] of TIDIED) said = said.split(from).join(to);

  return said
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** The words of a string, normalised, with the empty ones dropped. */
export function words(text) {
  return normalise(text).split(' ').filter(Boolean);
}

/**
 * Words that carry no meaning on their own.
 *
 * Two languages, because the documents are in one and the questions arrive in
 * whichever the person types. A list per language, chosen at query time, would
 * need to know which language a four-word question is in — and "come si fa" and
 * "come" are not enough to tell.
 *
 * This list is deliberately short. A long stop list starts removing words that
 * matter in a technical manual: "no", "not", "off" and "without" change the
 * meaning of a sentence about a setting, and dropping them is how a search for
 * "printing without margins" finds the page about margins.
 */
export const EMPTY_WORDS = new Set([
  // English
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have',
  'how', 'i', 'in', 'is', 'it', 'me', 'of', 'on', 'or', 'that', 'the', 'this',
  'to', 'was', 'what', 'when', 'where', 'which', 'you', 'your',
  // Italian
  'al', 'alla', 'alle', 'che', 'come', 'con', 'da', 'dei', 'del', 'della',
  'delle', 'di', 'e', 'gli', 'i', 'il', 'in', 'la', 'le', 'lo', 'mi', 'nel',
  'per', 'più', 'piu', 'quale', 'quali', 'si', 'su', 'sul', 'un', 'una', 'uno',
]);

/** The words worth searching on: normalised, long enough, and not empty ones. */
export function meaningfulWords(text, { atLeast = 3 } = {}) {
  return words(text).filter((one) => one.length >= atLeast && !EMPTY_WORDS.has(one));
}
