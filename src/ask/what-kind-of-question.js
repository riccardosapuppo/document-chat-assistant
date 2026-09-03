/**
 * What kind of question this is — which decides how to look for the answer.
 *
 * This module is the argument of the whole project. A vector search is very
 * good at one thing: finding text that *means* something like the question. It
 * is bad, in a way that is easy to miss, at the questions people actually put
 * to a manual:
 *
 *   - **"and the other one?"** is not a question at all on its own. Embed it and
 *     you get the centroid of every short vague sentence in the corpus.
 *   - **"error E-4412"** has no semantic neighbours. A code is an arbitrary
 *     string; its embedding is near other arbitrary strings, which is to say
 *     near nothing useful. The right tool is a literal match.
 *   - **"the XR-200"** is the same product as "XR200", "xr 200" and "the
 *     two-hundred", and an embedding is only sometimes near all four.
 *
 * So before anything is retrieved, the question is looked at. Every branch here
 * exists because the plain similarity search gets that branch wrong, and
 * `npm run measure` reports by how much.
 *
 * The shapes are traced from the tool this was rebuilt from, which had learned
 * all of this the expensive way, in production, one class of complaint at a
 * time.
 */

import { EMPTY_WORDS, meaningfulWords, normalise, words } from '../text/normalise.js';

/**
 * Words that point at something said earlier instead of naming it.
 *
 * Both languages, because the manual is in one and the question arrives in
 * whichever the person types.
 */
const POINTS_BACKWARDS =
  /\b(it|its|that|those|these|this|the same|the other|the previous|the above|as said|as mentioned)\b|\b(quest[oaie]|quell[oaie]|quel|stess[oaie]|precedent[ei]|suddetto|come detto|di cui sopra)\b/;

/**
 * Is this question standing on its own, or leaning on the one before it?
 *
 * Two ways of leaning, and the second is the one everybody forgets:
 *
 *   1. It uses a pointing word — "and that one?", "how about the same for it".
 *   2. It is **too short to be about anything**. "and the price?" has no
 *      pointing word in it at all, and is no more answerable on its own.
 *
 * Getting this wrong is not a slightly worse answer. Retrieving for "and the
 * price?" returns whatever passage in the corpus is nearest to a question about
 * prices in general — confidently, with a citation, about the wrong product.
 */
export function leansOnWhatCameBefore(question) {
  const said = normalise(question);
  if (!said) return { yes: false, why: 'there is no question' };

  if (POINTS_BACKWARDS.test(said)) {
    const [pointing] = said.match(POINTS_BACKWARDS) ?? [];
    return { yes: true, why: `it says "${pointing}", which points at something said earlier` };
  }

  const spoken = words(said);

  if (spoken.length <= 4) {
    const carrying = spoken.filter((one) => !EMPTY_WORDS.has(one));

    if (carrying.length <= 1) {
      return {
        yes: true,
        why: `only ${carrying.length} word${carrying.length === 1 ? '' : 's'} in it carries any meaning, so it is not about anything yet`,
      };
    }
  }

  return { yes: false, why: 'it names what it is about' };
}

/**
 * Does this question contain something that must be matched **letter for
 * letter** rather than by meaning?
 *
 * An error code, a part number, a function name, a setting key. These are the
 * questions a vector search answers worst, and they are a large share of what
 * anybody asks a technical manual — because if you knew how to describe the
 * problem in words you would not be looking up a code.
 */
const LOOKS_LIKE_A_CODE = [
  // E-4412, ERR_2201, 0x8007000E — both cases in the hex, because a Windows
  // error is copied out of a dialog that writes it 0x8007000E and typed by
  // somebody who writes it 0x8007000e, and they are the same code.
  /\b(?:0[xX][0-9a-fA-F]{4,}|[A-Z]{1,5}[-_]?\d{3,}[A-Z]?)\b/,
  // a function or method: doThing(, Thing::method, thing->other
  /[A-Za-z_][A-Za-z0-9_]*\s*\(|::|->|=>/,
  // something quoted as literal
  /`[^`]+`/,
  // A SETTING_IN_SHOUTING_CASE
  /\b[A-Z][A-Z0-9_]{3,}\b/,
];

export function containsSomethingLiteral(question) {
  const said = String(question ?? '');

  for (const shape of LOOKS_LIKE_A_CODE) {
    const found = said.match(shape);
    if (found) return { yes: true, term: found[0], why: `"${found[0]}" is a literal, not a meaning` };
  }

  return { yes: false, term: null, why: 'nothing in it has to match letter for letter' };
}

/**
 * The literal terms worth searching for, most specific first.
 *
 * Ordered because the first one that finds anything wins: a question mentioning
 * both `E-4412` and `printAll()` is almost always about the code, and searching
 * for the common word first buries it.
 */
export function literalTermsIn(question) {
  const said = String(question ?? '');
  const found = [];

  for (const shape of LOOKS_LIKE_A_CODE) {
    for (const one of said.matchAll(new RegExp(shape.source, `g${shape.flags.replace('g', '')}`))) {
      found.push(one[0]);
    }
  }

  // Longer is more specific: "ERR_2201" before "ERR".
  return [...new Set(found)].sort((a, b) => b.length - a.length);
}

/**
 * Every way one name might be written.
 *
 * Traced from the original, which built these out of a product name and a part
 * number because the same machine appears in a manual as "the XR-200 Mark II",
 * in a question as "xr200", and on the invoice as "XR 200".
 *
 * A part number is split into its letters and its digits and put back together
 * four ways, which is the set of separators anybody actually types.
 */
export function waysOfWriting(name, code = '') {
  const found = new Set();

  const clean = normalise(name);
  const spoken = words(clean);

  const worthKeeping = (one) => one.length >= 3 && !EMPTY_WORDS.has(one);

  if (worthKeeping(clean)) found.add(clean);
  if (spoken[0] && worthKeeping(spoken[0])) found.add(spoken[0]);

  // The tail of a name is usually the distinguishing part: "the Northwind
  // XR-200" is asked about as "XR-200", never as "the Northwind".
  for (const howMany of [2, 3]) {
    const tail = spoken.slice(-howMany).join(' ');
    if (worthKeeping(tail)) found.add(tail);
  }

  for (const one of variantsOf(code)) found.add(one);

  return [...found].filter(worthKeeping);
}

/**
 * A part number, written the four ways people write it.
 *
 * `XR-200` is `xr/200`, `xr-200`, `xr 200` and `xr200`. Which one is in the
 * manual and which one is in the question are independent facts.
 */
export function variantsOf(code) {
  const said = String(code ?? '').trim();
  if (!said) return [];

  const together = said.replace(/\s+/g, '');
  const letters = together.replace(/[^A-Za-z]/g, '').toLowerCase();
  const digits = together.replace(/[^0-9]/g, '');

  if (!letters || !digits) return [normalise(said)].filter(Boolean);

  return [`${letters}/${digits}`, `${letters}-${digits}`, `${letters} ${digits}`, `${letters}${digits}`];
}

/**
 * Everything decided about one question, in one place.
 *
 * Returned as a description rather than acted on here: the point of this module
 * is that the decision is inspectable. `npm run measure` prints it, the console
 * shows it, and a wrong answer can be traced to the branch that produced it
 * rather than to "the model".
 */
export function whatKindOfQuestion(question, { history = [] } = {}) {
  const leaning = leansOnWhatCameBefore(question);
  const literal = containsSomethingLiteral(question);

  return {
    question: String(question ?? ''),
    standsAlone: !leaning.yes,
    leaning,
    literal,
    terms: literal.yes ? literalTermsIn(question) : [],
    meaningful: meaningfulWords(question),
    // Only useful when it does lean: the thing it is leaning on.
    lastQuestion: history.length > 0 ? history[history.length - 1] : null,
  };
}
