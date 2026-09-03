/**
 * Which document a question is about — before looking inside any of them.
 *
 * This step was missing from the first version, and the measurement found it
 * within a minute of existing. The two printer manuals have almost the same
 * headings: "Paper the tray will take", "Margins", "Replacing the print head",
 * "Network settings". So "how heavy can the label stock be on the TP-40"
 * retrieved the TP-60's paper section — the right section of the wrong machine,
 * which is the most convincing wrong answer a manual can give, because
 * everything about it looks right including the heading.
 *
 * No amount of better embedding fixes that. The two passages *are* about the
 * same thing; the difference between them is a name, and a name is matched, not
 * measured.
 *
 * Traced from the original, which built aliases out of a product name and a
 * part number for exactly this reason. What is added here is where the aliases
 * come from: **the document's own first lines**, rather than a list somebody
 * maintains beside it. A manual opens by saying what it is, and the words it
 * uses there that no other document uses are precisely the words somebody will
 * use to refer to it.
 */

import { EMPTY_WORDS, normalise, stem, words } from '../text/normalise.js';
import { variantsOf } from './what-kind-of-question.js';

/** Shortest alias worth matching on: below this it matches everything. */
const LONG_ENOUGH = 4;

/**
 * What a document calls itself, taken from its title and its opening.
 *
 * Two kinds of name, and they cannot follow the same rule:
 *
 *   1. **Part numbers**, from the title, in the four ways anybody writes one —
 *      `tp-40` is also `tp40`, `tp 40` and `tp/40`. Kept whatever else mentions
 *      them, because an identifier stays an identifier: the TP-60's manual
 *      talks about the TP-40 in its first paragraph, and a rule that dropped
 *      any name another document says would leave the TP-40 manual with no
 *      reliable name at all.
 *
 *   2. **Ordinary words**, from the title and the opening sentence, but only
 *      those that appear **nowhere in any other document**. That is what makes
 *      "and the wide one?" answerable: the TP-60 opens by calling itself
 *      wide-format and nothing else in the folder uses the word.
 *
 * The second rule was arrived at by measuring, and three weaker versions of it
 * are recorded in the comments below, each with the wrong answer it produced.
 */
export function whatEachIsCalled(documents) {
  const opening = new Map();
  const seenIn = new Map();

  for (const one of documents) {
    // The first sentence, and only that. A manual says what it is in its
    // opening line; by the second paragraph it is talking about other things,
    // and words scraped from there ("driver", "support", "three") become names
    // for a document that is not about them.
    const body = String(one.text ?? '').split('\n').slice(1).join(' ').trim();
    const first = body.split(/(?<=[.!?])\s/)[0] ?? '';

    opening.set(one.name, new Set(words(first).filter((word) => word.length >= LONG_ENOUGH && !EMPTY_WORDS.has(word)).map(stem)));

    // Counted over the WHOLE of every document, not over their opening lines.
    //
    // The weaker version of this — distinctive among the first sentences — let
    // "machine" become a name for the TP-60, because only its opening says it;
    // the TP-40 says it in the sentence after. And "range" became a name for
    // the TP-60 while also standing in the fault-code manual's title. A word
    // that appears anywhere in another document cannot be a name for this one.
    for (const word of new Set(words(one.text).map(stem))) seenIn.set(word, (seenIn.get(word) ?? 0) + 1);
  }

  const called = new Map();

  for (const one of documents) {
    const names = new Set();
    const title = String(one.text ?? '').split('\n')[0].replace(/^#+\s*/, '');

    /**
     * 1. The part numbers in the title, kept whatever else mentions them.
     *
     * A part number is an identifier; an ordinary word is not, and the two
     * cannot follow the same rule. The TP-60's manual mentions the TP-40 in its
     * first paragraph, and under a rule that dropped any name another document
     * says, the TP-40 manual would stop being called the TP-40 — which is the
     * only reliable name it has.
     */
    for (const code of title.match(/\b[A-Za-z]{1,5}[-_ ]?\d{2,}\b/g) ?? []) {
      for (const variant of variantsOf(code)) names.add(variant);
    }

    /**
     * 2. The other words in the title, but only those no other document uses.
     *
     * "Halden TP range: fault codes" gave the fault-code manual the name
     * "range" — and both printer manuals talk about the TP range constantly, so
     * a question mentioning it was routed to the codes. A common word in a
     * title is not a name.
     */
    const onlyIfNobodyElseSaysIt = [
      ...words(title).filter((word) => word.length >= LONG_ENOUGH && !EMPTY_WORDS.has(word)).map(stem),
      ...(opening.get(one.name) ?? []),
    ];

    /**
     * 3. And what only this document says about itself.
     *
     * Both of the above are filtered the same way and capped, longest first.
     * The tail of an unfiltered list is ordinary prose that happens to be
     * unique, and an ordinary word standing as a name for one document is how a
     * question about anything at all gets routed to it.
     */
    const distinctive = [...new Set(onlyIfNobodyElseSaysIt)]
      .filter((word) => seenIn.get(word) === 1)
      .sort((a, b) => b.length - a.length)
      .slice(0, 4);

    for (const word of distinctive) names.add(word);

    called.set(one.name, [...names]);
  }

  return called;
}

/**
 * Which document, if any, this question names.
 *
 * Matched by prefix rather than equality, because "the small printer" is asking
 * about the machine that calls itself "the smallest", and "the wide one" about
 * the one that calls itself "wide-format". Requiring the whole word would find
 * neither, and both are how people actually refer to a machine whose part
 * number they have not got in front of them.
 *
 * Returns nothing when two documents match equally well. Guessing between them
 * is how "the right section of the wrong machine" happens, and answering "which
 * of the two do you mean" is a better answer than a confident coin toss.
 */
export function whichDocument(question, called) {
  const asked = words(question).filter((one) => one.length >= LONG_ENOUGH).map(stem);
  if (asked.length === 0) return { document: null, why: 'nothing in it names a document', on: [] };

  const scores = new Map();

  for (const [document, names] of called) {
    const hits = [];

    for (const name of names) {
      const matched = asked.some((word) => word.startsWith(name) || name.startsWith(word));
      if (matched) hits.push(name);
    }

    // A longer alias is a stronger signal than a short one: "tp40" says more
    // than "printer", which every manual in the folder contains.
    if (hits.length > 0) scores.set(document, { hits, weight: hits.reduce((all, one) => all + one.length, 0) });
  }

  if (scores.size === 0) return { document: null, why: 'nothing in it names a document', on: [] };

  const ranked = [...scores.entries()].sort((a, b) => b[1].weight - a[1].weight);
  const [best, second] = ranked;

  if (second && second[1].weight === best[1].weight) {
    return {
      document: null,
      why: `it could be ${ranked.map(([one]) => one).join(' or ')}, and guessing between them is how the right section of the wrong machine gets returned`,
      on: [],
    };
  }

  return { document: best[0], why: `it says ${best[1].hits.map((one) => `"${one}"`).join(', ')}`, on: best[1].hits };
}

/**
 * The same question, restricted to one document's pieces.
 *
 * A filter rather than a boost. A boost lets a very similar passage from the
 * wrong machine outrank a merely good one from the right machine, which is the
 * failure this whole module exists to prevent — and the passage from the wrong
 * machine is *always* very similar, because the manuals are written from the
 * same template.
 */
export function only(document, index) {
  return {
    ...index,
    chunks: index.chunks.filter((one) => one.document === document),
  };
}
