/**
 * The index: the documents, cut up, with something comparable attached.
 *
 * Held in memory, and that is a decision rather than a stage this has not
 * reached. The whole corpus here is three manuals; a database between the
 * chunks and the search would be machinery serving nothing, and it would hide
 * the part worth reading — which is how a question is turned into a search,
 * not where the rows live.
 *
 * What a real one needs instead is written down at the bottom of the README,
 * where it can be read as a judgement rather than found as an absence.
 */

import fs from 'node:fs';
import path from 'node:path';

import { cutUp } from './chunks.js';
import { whatEachIsCalled } from '../ask/which-document.js';
import { normalise } from '../text/normalise.js';

/**
 * The first line of each document, which is its title.
 *
 * Carried onto every piece so that the retrieval can tell a section heading
 * from the name of the whole document — they look identical otherwise, and the
 * front page of a manual answers no question at all.
 */
function titlesOf(documents) {
  return new Map(
    documents.map((one) => {
      const first = String(one.text ?? '').split('\n')[0] ?? '';
      return [one.name, first.replace(/^#+\s*/, '').trim() || null];
    })
  );
}

/**
 * Builds an index over some documents.
 *
 * `provider` decides what "comparable" means — see `embed.js`. Its vectors are
 * awaited whichever provider it is. The local one's are there the moment they
 * are asked for, and awaiting them costs nothing; the remote one's arrive over
 * the network, and one that has not arrived yet is a promise.
 *
 * A promise compares as nothing. This used to have a synchronous twin for the
 * local provider, and the measurement and the service both built with it
 * whichever provider was in use: with real embeddings every score came out 0,
 * similarity alone found nothing for any question, and nothing said so. There
 * is one way to build an index now, and it waits.
 */
export async function buildAsync(documents, { provider, size, overlap } = {}) {
  const chunks = documents.flatMap((one) => cutUp(one.name, one.text, { size, overlap }));

  if (chunks.length === 0) throw new Error('there is nothing in those documents to index');

  const titles = titlesOf(documents);

  const learned = await provider.learn(chunks.map((one) => one.text));

  for (const chunk of chunks) {
    chunk.vector = await provider.vector(chunk.text, learned);
    // Kept beside the text so the literal search does not normalise two hundred
    // chunks on every question.
    chunk.normalised = normalise(`${chunk.heading ?? ''} ${chunk.text}`);
    // The document's own title, carried on every piece of it: a heading that
    // is the title is the front page, not a section about a subject.
    chunk.documentTitle = titles.get(chunk.document) ?? null;
  }

  return {
    chunks,
    provider: provider.name,
    lexical: provider.lexical,
    documents: documents.map((one) => one.name),
    // What each document calls itself, worked out once. Everything that needs
    // to know which machine a question is about asks this.
    called: whatEachIsCalled(documents),
    // A question's vector, which is a promise whenever the provider's are:
    // whoever asks for one awaits it, for the same reason this function does.
    vectorFor: (text) => provider.vector(text, learned),
    alikeness: provider.alikeness,
  };
}

/** Every document in a folder, read as `{ name, text }`. */
export function readFolder(folder) {
  return fs
    .readdirSync(folder)
    .filter((one) => one.endsWith('.md') || one.endsWith('.txt'))
    .sort()
    .map((one) => ({
      name: one.replace(/\.(md|txt)$/, ''),
      text: fs.readFileSync(path.join(folder, one), 'utf8'),
    }));
}
