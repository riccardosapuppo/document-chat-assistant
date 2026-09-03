/**
 * Finding the passages that answer a question.
 *
 * Two ways of doing it live here, and having both is the point.
 *
 * **`bySimilarityAlone`** is the baseline: embed the question, compare it with
 * every chunk, return the nearest. It is what almost every "chat with your
 * documents" is, and on a question phrased in ordinary words it is very good.
 *
 * **`byWhatKindOfQuestionItIs`** looks at the question first and picks the tool
 * that suits it. It is the same similarity search plus three departures, and
 * each departure exists because the baseline gets that class of question wrong
 * in a way that produces a confident, cited, wrong answer.
 *
 * `npm run measure` runs both over the same questions and reports the
 * difference per class, which is the only honest way to present it: the
 * baseline is not bad everywhere, it is bad in particular places, and saying
 * which is more useful than a single number.
 */

import { whatKindOfQuestion } from './what-kind-of-question.js';
import { only, whichDocument } from './which-document.js';
import { meaningfulWords, normalise } from '../text/normalise.js';

/**
 * How much a heading match is worth, beside a similarity score of at most 1.
 *
 * Chosen so that saying a whole heading outweighs a merely good passage
 * elsewhere, and saying half of one does not. It is a number picked by
 * measuring rather than by reasoning: npm run measure is what says whether it
 * is right, and it is reported per kind of question so a value that helps one
 * kind at the cost of another cannot hide.
 */
const HEADING_COUNTS = 0.35;

/**
 * The nearest chunks, by meaning alone.
 *
 * @returns {{ chunk: object, score: number, why: string }[]}
 */
export function bySimilarityAlone(question, index, { most = 5, headingCounts = 0 } = {}) {
  const asked = index.vectorFor(question);
  const inTheQuestion = new Set(meaningfulWords(question));

  return index.chunks
    .map((chunk) => {
      const score = index.alikeness(asked, chunk.vector);

      /**
       * A heading is the document's own statement of what a section is about,
       * and it is the shortest true summary anybody will ever write of it. A
       * question that uses its words is very probably about it.
       *
       * Off by default so that `bySimilarityAlone` stays the plain baseline the
       * measurement compares against. Turning it on inside the baseline would
       * be measuring an improved thing against itself and reporting no gain.
       */
      const heading = headingCounts === 0 ? 0 : shareOfHeading(chunk, inTheQuestion) * headingCounts;

      return {
        chunk,
        score: score + heading,
        why: heading > 0 ? `nearest by meaning, and headed "${chunk.heading}"` : 'nearest by meaning',
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, most)
    .filter((one) => one.score > 0);
}

/**
 * How much of a heading the question said, between 0 and 1.
 *
 * Words that merely **name the document** do not count. Every manual opens with
 * a section headed by its own title, and a question that says "on the TP-40"
 * scored a perfect heading match against "Halden TP-40 label printer" — so the
 * best answer to "how heavy can the label stock be on the TP-40" became the
 * front page of the manual, which is about nothing in particular and answers
 * nothing at all.
 *
 * Once the document has been chosen, its own name carries no information: every
 * section of it is equally about the TP-40.
 */
function shareOfHeading(chunk, inTheQuestion) {
  // The document's own title is not a subject. Every manual opens with a
  // section headed by its title, and a question saying "the label stock on the
  // TP-40" scored a perfect heading match against "Halden TP-40 label printer"
  // — so the best answer became the front page, which is about nothing in
  // particular and answers nothing at all.
  //
  // Compared against the title itself rather than against the document's list
  // of names for itself. That list is built by heuristics that tighten and
  // loosen as they are improved; the title does not move, and this rule has
  // nothing to do with those heuristics.
  if (chunk.heading && chunk.documentTitle && chunk.heading === chunk.documentTitle) return 0;

  const inTheTitle = new Set(meaningfulWords(chunk.documentTitle ?? ''));
  const said = meaningfulWords(chunk.heading ?? '').filter((one) => !inTheTitle.has(one));

  if (said.length === 0) return 0;

  return said.filter((one) => inTheQuestion.has(one)).length / said.length;
}

/**
 * Chunks containing a term **letter for letter**.
 *
 * The whole reason this exists: a code is an arbitrary string. Its embedding is
 * near other arbitrary strings, which is to say near nothing. Asked "what does
 * E-4412 mean", a similarity search returns the passage that is most *about*
 * error codes in general — often the introduction to the fault-code list, which
 * mentions codes constantly and explains none of them.
 */
export function byTheLetter(terms, index, { most = 5 } = {}) {
  const wanted = terms.map((one) => normalise(one)).filter(Boolean);
  if (wanted.length === 0) return [];

  const found = [];

  for (const chunk of index.chunks) {
    const inside = chunk.normalised;
    const hits = wanted.filter((one) => inside.includes(one));

    if (hits.length === 0) continue;

    // A chunk containing the term in its heading is about it; a chunk that
    // mentions it in passing is not. "See also E-4413" should not outrank the
    // section headed E-4413.
    const inTheHeading = normalise(chunk.heading ?? '').includes(hits[0]);

    found.push({
      chunk,
      score: hits.length + (inTheHeading ? 1 : 0),
      why: inTheHeading ? `headed "${chunk.heading}"` : `contains "${hits[0]}"`,
    });
  }

  return found.sort((a, b) => b.score - a.score).slice(0, most);
}

/**
 * A question that leaned on the one before it, made to stand on its own.
 *
 * Not by asking a model to rewrite it — that is a second thing to go wrong and
 * a second thing to pay for. The subject of the previous question is carried
 * forward and the new question is asked with it attached.
 *
 * Crude, and right far more often than it is wrong: "and the TP-60?" after
 * "what margin does the TP-40 need" is a question about margins, and the words
 * that make it one are all in the sentence before.
 */
export function standingOnItsOwn(question, previous) {
  if (!previous) return question;

  const already = new Set(meaningfulWords(question));
  const carried = meaningfulWords(previous).filter((one) => !already.has(one));

  return carried.length === 0 ? question : `${question} ${carried.join(' ')}`;
}

/**
 * The one to use.
 *
 * @returns {{ found: object[], kind: object, asked: string, how: string }}
 */
export function byWhatKindOfQuestionItIs(question, index, { history = [], most = 5 } = {}) {
  const kind = whatKindOfQuestion(question, { history });

  // 1. If it does not stand on its own, make it — before anything is searched
  //    for. Retrieving for "and the price?" returns whatever is nearest to a
  //    question about prices in general, confidently and about the wrong thing.
  const asked = kind.standsAlone ? question : standingOnItsOwn(question, kind.lastQuestion);

  /**
   * 2. Which document is it about?
   *
   * The manuals here are written from the same template, so the wrong machine's
   * section on a subject is always a close match — closer, often, than the
   * right machine's. No embedding fixes that: the difference between the two
   * passages is a name, and a name is matched, not measured.
   *
   * **The question in front of us decides, not the one before it.** That is not
   * a detail: "and the TP-60?" after a question about the TP-40 carries the
   * words of the old question forward, and those words contain "TP-40" — so the
   * carried subject out-voted the named one and the answer came back about the
   * machine the person had just stopped asking about. Which is the exact
   * failure the carrying-forward was added to prevent, arriving from the other
   * direction.
   */
  const itNames = whichDocument(question, index.called ?? new Map());
  const named = itNames.document ? itNames : whichDocument(asked, index.called ?? new Map());

  const searching = named.document ? only(named.document, index) : index;

  // 3. If it contains something literal, that is what to search for. The
  //    similarity search still runs, but underneath: a code that appears
  //    nowhere should fall back to meaning rather than return nothing.
  if (kind.literal.yes) {
    const exact = byTheLetter(kind.terms, searching, { most });

    if (exact.length > 0) {
      return {
        found: exact,
        kind,
        asked,
        how: `letter for letter, on ${kind.terms.map((one) => `"${one}"`).join(' and ')}`,
      };
    }

    return {
      found: bySimilarityAlone(asked, searching, { most, headingCounts: HEADING_COUNTS }),
      kind,
      asked,
      named,
      how: `nothing contains ${kind.terms.map((one) => `"${one}"`).join(' or ')}, so by meaning instead`,
    };
  }

  // 4. Otherwise, meaning — which is what it is good at.
  return {
    found: bySimilarityAlone(asked, searching, { most, headingCounts: HEADING_COUNTS }),
    kind,
    asked,
    named,
    how: [
      'by meaning',
      named.document ? `within ${named.document}, because ${named.why}` : null,
      kind.standsAlone ? null : 'with the subject carried from the question before',
    ]
      .filter(Boolean)
      .join(', '),
  };
}
