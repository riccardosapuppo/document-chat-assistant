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

/**
 * The words of a string, normalised, with the punctuation off the ends.
 *
 * Splitting on spaces alone leaves "range." and "range" as two different words,
 * and everything that compares words then quietly fails on whichever one
 * happened to end a sentence. It was worse than quiet here: a document's list
 * of names for itself picked up "tp-40," — with the comma — from a sentence in
 * the TP-60 manual mentioning the other machine, and a name for one document
 * that is really the name of another is the worst thing in that list.
 *
 * Punctuation is stripped from the ends only. Inside a word it is meaningful:
 * `tp-60` is a part number and `wide-format` is one idea, and splitting either
 * of them leaves two-letter fragments that match everything.
 */
export function words(text) {
  return normalise(text)
    .split(' ')
    .map((one) => one.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter(Boolean);
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

/**
 * A word with its commonest ending taken off.
 *
 * Deliberately crude, and worth being honest about why it exists at all: a
 * **lexical** index matches words, so "cleaned" and "Cleaning" are two
 * different things to it and a question about one does not find a section about
 * the other. That is not a failing of this project's idea, it is the standing
 * weakness of the tool — and a real embedding does not have it, which is
 * precisely the sort of difference `npm run measure` is there to show.
 *
 * A full stemmer is a large table of exceptions and a source of surprises
 * ("business" → "busi"). This takes off the four endings that account for most
 * of the mismatches and refuses to leave a stem shorter than four letters,
 * because a three-letter stem matches half the language.
 *
 * It is applied to the documents and to the questions by the same function, so
 * the two can never be stemmed differently — which is the failure mode that
 * makes a search quietly return nothing for a word that is plainly there.
 */
export function stem(word) {
  const said = String(word ?? '');

  for (const ending of ['ings', 'ing', 'edly', 'ed', 'est', 'es', 's']) {
    if (!said.endsWith(ending)) continue;

    const shorter = said.slice(0, -ending.length);
    if (shorter.length >= 4) return shorter;
  }

  return said;
}

/**
 * The words worth searching on: normalised, long enough, not empty, stemmed.
 *
 * The empty-word check happens **before** stemming, so the list can stay a list
 * of words people write rather than a list of stems nobody would recognise.
 */
export function meaningfulWords(text, { atLeast = 3 } = {}) {
  return words(text)
    .filter((one) => one.length >= atLeast && !EMPTY_WORDS.has(one))
    .map((one) => stem(one));
}
