/**
 * Turning text into something that can be compared for similarity.
 *
 * Two providers, and the default is the one that needs nothing.
 *
 * **`local`** builds a term-frequency vector weighted by how rare each word is
 * in the corpus — tf-idf, which is fifty years old and still the honest
 * baseline. It needs no key, no model, no network and no gigabyte of weights,
 * it is deterministic, and it means this project runs the moment it is cloned.
 *
 * **`openai`** asks for real embeddings when `OPENAI_API_KEY` is set.
 *
 * **The local one is not a stand-in for the other, and the difference matters
 * to what this project claims.** tf-idf is *lexical*: it matches words, not
 * meanings. So it is unusually good at exactly the thing a real embedding is
 * worst at — an error code, a part number — and unusually bad at the thing an
 * embedding is best at, which is a question phrased in words the document never
 * uses. `npm run measure` reports per class of question and says which way each
 * provider leans, because a single number across all of them would hide the
 * whole point.
 */

import { meaningfulWords } from '../text/normalise.js';

/**
 * The vocabulary and how rare each word is, built once from the corpus.
 *
 * Rarity is what makes this work at all: without it "the printer" and "the
 * tray" are similar because they both contain "the". The weight of a word is
 * the log of how few documents contain it, so a word in every chunk weighs
 * almost nothing and a word in three chunks weighs a lot.
 */
export function learnFrom(texts, { atLeast = 3 } = {}) {
  const inHowMany = new Map();

  for (const text of texts) {
    for (const word of new Set(meaningfulWords(text, { atLeast }))) {
      inHowMany.set(word, (inHowMany.get(word) ?? 0) + 1);
    }
  }

  const total = Math.max(1, texts.length);
  const weight = new Map();

  for (const [word, count] of inHowMany) {
    // +1 inside the log so a word in every single chunk gets a weight of
    // something small rather than exactly zero: it still says a little.
    weight.set(word, Math.log(1 + total / count));
  }

  return { weight, total, atLeast };
}

/**
 * One text, as a sparse vector, already normalised to unit length.
 *
 * Unit length up front rather than dividing at comparison time: the length of a
 * chunk is not information about what it is about, and a comparison that does
 * not divide it out ranks long chunks above short ones on every query.
 */
export function vectorFor(text, learned) {
  const counts = new Map();

  for (const word of meaningfulWords(text, { atLeast: learned.atLeast })) {
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }

  const vector = new Map();
  let length = 0;

  for (const [word, count] of counts) {
    // A word the corpus has never seen carries no weight rather than an
    // undefined one — a question can contain anything.
    const weight = learned.weight.get(word);
    if (weight === undefined) continue;

    // The log flattens repetition: a word said eight times is not eight times
    // as much about it as a word said once.
    const value = (1 + Math.log(count)) * weight;

    vector.set(word, value);
    length += value * value;
  }

  length = Math.sqrt(length);
  if (length === 0) return vector;

  for (const [word, value] of vector) vector.set(word, value / length);

  return vector;
}

/**
 * How alike two unit vectors are, between 0 and 1.
 *
 * Walks the shorter one, because a sparse vector's cost is its number of words
 * and a question has a dozen while a chunk has two hundred.
 */
export function alikeness(a, b) {
  const [few, many] = a.size <= b.size ? [a, b] : [b, a];

  let total = 0;
  for (const [word, value] of few) {
    const other = many.get(word);
    if (other !== undefined) total += value * other;
  }

  return total;
}

/**
 * The provider, chosen from what is available rather than from a setting.
 *
 * An engine that declines has to say what is missing: asking for `openai`
 * without a key does not quietly fall back — falling back quietly is how
 * somebody measures the wrong thing for a week and reports it.
 */
export function provider({ name = process.env.EMBEDDINGS ?? 'local', key = process.env.OPENAI_API_KEY } = {}) {
  if (name === 'local') return localProvider();

  if (name === 'openai') {
    if (!key) {
      throw new Error(
        'EMBEDDINGS=openai needs OPENAI_API_KEY, and it is not set.\n' +
          '  Either set it, or leave EMBEDDINGS unset to use the local one, which needs nothing.\n' +
          '  This does not fall back on its own: measuring one provider while believing you\n' +
          '  measured the other is worse than refusing to start.'
      );
    }

    return openAiProvider({ key });
  }

  throw new Error(`there is no "${name}" provider — there is "local" and "openai"`);
}

function localProvider() {
  return {
    name: 'local',
    /** Lexical, so it flatters a literal search and struggles with paraphrase. */
    lexical: true,
    needsNetwork: false,

    learn: (texts) => learnFrom(texts),
    vector: (text, learned) => vectorFor(text, learned),
    alikeness,
  };
}

/**
 * Real embeddings, when somebody has a key and wants the comparison with them.
 *
 * Deliberately thin: this project's argument is about **which retrieval to
 * use for which question**, and that argument does not depend on whose
 * embeddings they are. Anything cleverer here would be a second thing to
 * maintain and a second thing to go wrong.
 */
function openAiProvider({ key, model = process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small' }) {
  const ask = async (inputs) => {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, input: inputs }),
    });

    if (!response.ok) {
      throw new Error(`the embeddings service answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }

    const said = await response.json();
    return said.data.map((one) => one.embedding);
  };

  return {
    name: `openai:${model}`,
    lexical: false,
    needsNetwork: true,

    // Nothing to learn from the corpus: the model already has.
    learn: () => ({ ask }),

    async vector(text, learned) {
      const [only] = await learned.ask([String(text ?? '')]);
      return dense(only);
    },

    /** Both are dense arrays here, already unit length from the service. */
    alikeness(a, b) {
      let total = 0;
      for (let at = 0; at < a.length; at += 1) total += a[at] * b[at];
      return total;
    },
  };
}

/** A dense array, made unit length so comparisons do not have to divide. */
function dense(values) {
  const length = Math.sqrt(values.reduce((all, one) => all + one * one, 0)) || 1;
  return values.map((one) => one / length);
}
