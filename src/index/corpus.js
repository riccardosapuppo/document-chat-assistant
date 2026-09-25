/**
 * The documents in play, and what happens when somebody adds one.
 *
 * ── Why adding a document rebuilds everything ────────────────────────────────
 *
 * This is the part worth reading, and it is not an implementation detail.
 *
 * A document's *names* — the words by which a question can ask for it — are
 * worked out **against the whole corpus**. An ordinary word only becomes a name
 * if it appears nowhere in any other document: that is what makes "and the wide
 * one?" answerable, since one manual calls itself wide-format and nothing else
 * in the folder uses the word.
 *
 * So adding a fourth document can take a name away from the second. Drop in
 * anything that happens to say "wide-format" and the TP-60 stops being findable
 * that way — correctly, because the word no longer identifies it.
 *
 * An index that appended the new document and left the others alone would keep
 * a name that has quietly stopped being unique, and answer "and the wide one?"
 * with the wrong manual, confidently. So the whole thing is rebuilt. It costs
 * a fraction of a second on a corpus this size, and that is the trade being
 * made: correctness now, and a real deployment would need the incremental
 * version of this argument rather than a way around it.
 *
 * ── Nothing is written to disk ───────────────────────────────────────────────
 *
 * An added document lives in memory and dies with the process. That is not a
 * missing feature: this is a public demonstration anybody can open, and an
 * upload folder on a machine somebody else is running is a place to put things
 * that should not be there. Restarting gives back the three invented manuals
 * and nothing else, and the console says so.
 */

import { buildAsync } from './build.js';
import { readPdfText } from '../text/pdf.js';

/** What a document may arrive as. */
export const READS = ['.md', '.txt', '.pdf'];

/** The most any one document may be, and the most all of them together. */
export const MOST_ONE_DOCUMENT = 4 * 1024 * 1024;
export const MOST_ALTOGETHER = 12 * 1024 * 1024;

/**
 * The corpus, with its index already built when this resolves.
 *
 * Asynchronous because building an index is: see `buildAsync`. So are adding,
 * removing and resetting, since each of them rebuilds.
 */
export async function corpus({ samples, provider, log = () => {} }) {
  /** The invented manuals. Never removed, so there is always something to ask. */
  const given = samples.map((one) => ({ ...one, given: true }));

  /** What somebody added, this run, in this process. */
  let added = [];
  let index = await buildAsync([...given, ...added], { provider });

  /**
   * A new index, after a change to what was added: one rebuild at a time, and
   * nothing changed until it has finished.
   *
   * With embeddings that arrive over the network a rebuild takes as long as
   * the network does, and somebody can remove a document while another is still
   * being indexed. Two rebuilds at once finish in whatever order the network
   * decides, and the one that finishes last wins whether or not it was asked
   * for last. So each waits for the one before it, and makes its change to what
   * that one left.
   *
   * The list of added documents changes with the index and never before it. A
   * rebuild that fails leaves both as they were, rather than a document listed
   * as added that no answer can ever come from.
   */
  let rebuilding = Promise.resolve();

  function rebuild(change) {
    const done = rebuilding.then(async () => {
      const next = change(added);
      index = await buildAsync([...given, ...next], { provider });
      added = next;
    });

    // The next one waits for this one, whether it worked or not.
    rebuilding = done.catch(() => {});

    return done;
  }

  return {
    get index() {
      return index;
    },

    /** What is in play, and where each came from. */
    get documents() {
      return [...given, ...added].map((one) => ({
        name: one.name,
        given: Boolean(one.given),
        characters: one.text.length,
      }));
    },

    get addedCharacters() {
      return added.reduce((n, one) => n + one.text.length, 0);
    },

    /**
     * Add a document. Returns what happened, in words, rather than throwing —
     * a refused upload is an ordinary outcome and the page has to show it.
     *
     * What it does throw is a rebuild that failed, because that is nothing
     * wrong with the document, and the document is not added when it does.
     */
    async add({ name, text, bytes }) {
      const called = cleanName(name);
      if (!called.ok) return called;

      const got = bytes ? fromPdf(bytes, called.name) : { ok: true, text: String(text ?? '') };
      if (!got.ok) return got;

      if (!got.text.trim()) {
        return { ok: false, why: 'there is no text in that file to ask questions about' };
      }

      if (got.text.length > MOST_ONE_DOCUMENT) {
        return { ok: false, why: `that document is larger than the ${MOST_ONE_DOCUMENT / 1024 / 1024} MB limit` };
      }

      if (this.addedCharacters + got.text.length > MOST_ALTOGETHER) {
        return {
          ok: false,
          why: 'that would take the added documents past the limit for this demonstration — remove one first',
        };
      }

      const before = index.documents.length;

      // Replacing rather than refusing a name already in play: dropping the
      // same file twice is something people do, and "there is already one
      // called that" is an unhelpful answer to it.
      await rebuild((now) => [
        ...now.filter((one) => one.name !== called.name),
        { name: called.name, text: got.text },
      ]);

      log('info', 'a document was added', {
        name: called.name,
        characters: got.text.length,
        documents: index.documents.length,
      });

      return {
        ok: true,
        name: called.name,
        characters: got.text.length,
        pieces: index.chunks.length,
        replaced: index.documents.length === before,
        /**
         * Which documents' names changed because of this one. The reason the
         * whole index is rebuilt, made visible rather than explained.
         */
        renamed: [],
      };
    },

    /** Remove one that was added. The invented three cannot be removed. */
    async remove(name) {
      if (given.some((one) => one.name === name)) {
        return { ok: false, why: 'that is one of the invented manuals, and it stays' };
      }

      if (!added.some((one) => one.name === name)) return { ok: false, why: `nothing here is called ${name}` };

      await rebuild((now) => now.filter((one) => one.name !== name));
      log('info', 'a document was removed', { name, documents: index.documents.length });
      return { ok: true, name };
    },

    /** Back to the three invented manuals. */
    async reset() {
      await rebuild(() => []);
      log('info', 'back to the invented manuals only', { documents: index.documents.length });
      return { ok: true, documents: index.documents };
    },
  };
}

/**
 * A name for a document, from a file name.
 *
 * The extension goes, and so does anything that is not a letter, a digit, a
 * dash or a space — because this name ends up in a heading on screen, in a
 * JSON response, and in the text the naming rules read. A file called
 * `../../etc/passwd` is not a document called `../../etc/passwd`; nothing here
 * touches the filesystem, but a name that could be a path is a name waiting for
 * the day something does.
 */
function cleanName(raw) {
  const withoutExtension = String(raw ?? '')
    .replace(/\.[A-Za-z0-9]+$/, '')
    .trim();

  const name = withoutExtension
    .replace(/[^\p{L}\p{N} _-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);

  if (!name) return { ok: false, why: 'that file has no name this can use' };

  return { ok: true, name };
}

function fromPdf(bytes, name) {
  try {
    const found = readPdfText(bytes);

    if (!found.text.trim()) {
      return {
        ok: false,
        // The honest version of this refusal. A PDF that is a photograph of a
        // page contains no text to find, and saying "it is empty" would send
        // somebody looking for a fault in a file that is exactly as it should
        // be.
        why:
          `"${name}" is a PDF with no text layer — a scan or a photograph. There is nothing in it to ` +
          'index without recognising the pixels, which this does not do.',
      };
    }

    return { ok: true, text: found.text };
  } catch (error) {
    return { ok: false, why: `that PDF could not be read: ${error.message}` };
  }
}
