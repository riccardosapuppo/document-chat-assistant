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
 *
 * ── A page that cannot be read is left out, and named ────────────────────────
 *
 * A PDF is read a page at a time, and a page's text is taken only when every
 * glyph on it can be turned into a character (see `src/text/pdf-text.js`). The
 * other pages, a scan or a font nothing in the file explains, are set aside
 * with the reason. The reader was written for a service that sends those pages
 * to an engine that reads pixels. Nothing here reads pixels, so what becomes of
 * them is decided here.
 *
 * The document is indexed from the pages that carry their text, and the others
 * are named, with the reason, wherever the document is: in the answer to the
 * upload, on the screen it was dropped on, in the list of documents for as long
 * as it is in it, and in the log. A question whose answer is on one of them is
 * answered from somewhere else, and the sentence says so, because that is what
 * leaving a page out costs.
 *
 * Refusing the whole document is what that service does when it has no key,
 * and it would be wrong here. There, a key would read the page, and a caller
 * written before pages were named would take what was read for the whole. Here
 * no key reads anything, so a refusal would be for good: a contract turned away
 * for its scanned signature page, a manual for the photograph on its cover. And
 * the one caller is this console, which shows what was left out.
 *
 * What is never done is index a page the reader set aside, or close up the
 * words it could not read. The copy of the reader this replaced did both: a CID
 * font's glyph numbers read as letters, a Word export without a single "e", a
 * scanned second page dropped with nobody told. A PDF with no page that can be
 * read at all is refused, naming the pages and why, as a scan always was.
 */

import { buildAsync } from './build.js';
import { pageWords } from '../text/pages.js';
import { readPdfText } from '../text/pdf-text.js';

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

    /**
     * What is in play, where each came from, and which pages of it were not
     * read: said for as long as the document is here, not only when it
     * arrived.
     */
    get documents() {
      return [...given, ...added].map((one) => ({
        name: one.name,
        given: Boolean(one.given),
        characters: one.text.length,
        unread: one.unread ?? [],
        notRead: notReadSaid(one.unread),
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

      const got = bytes ? fromPdf(bytes, called.name) : { ok: true, text: String(text ?? ''), unread: [] };
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
        { name: called.name, text: got.text, unread: got.unread },
      ]);

      const notRead = notReadSaid(got.unread);
      const detail = { name: called.name, characters: got.text.length, documents: index.documents.length };

      if (notRead) log('warn', 'a document was added without some of its pages', { ...detail, unread: got.unread });
      else log('info', 'a document was added', detail);

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
        // How many pages a PDF has, and which of them are not in the index and
        // why: numbered from one, empty when every page was read, and said as a
        // sentence for whoever is looking at the screen.
        ...(got.pages === undefined ? {} : { pages: got.pages }),
        unread: got.unread,
        notRead,
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

/**
 * A PDF, as the text the index can take from it, or why it can take none.
 *
 * The pages the reader set aside travel with the document from here on, as
 * `unread`: see the top of this file for why it is indexed without them.
 */
function fromPdf(bytes, name) {
  let found;

  try {
    found = readPdfText(bytes);
  } catch (error) {
    return { ok: false, why: `that PDF could not be read: ${error.message}` };
  }

  if (found.text.trim()) return { ok: true, text: found.text, pages: found.pages.length, unread: found.unread };

  // Nothing to index, said in the reader's words, which name the pages and the
  // reason for each. This used to call every such file a scan or a photograph,
  // and a PDF in a font nothing explains is not a photograph of anything.
  if (found.unread.length > 0) {
    return {
      ok: false,
      why:
        `"${name}" has no page this can read: ${found.why}. There is nothing in it to index ` +
        'without recognising the pixels, which this does not do.',
      unread: found.unread,
    };
  }

  if (found.pages.length > 0) return { ok: false, why: `"${name}" has nothing written in it: ${found.why}.` };

  // About the file as a whole: encrypted, not a PDF, or pages the reader could
  // not be sure of the order of, whose why can begin by saying what it read.
  return { ok: false, why: `"${name}" was not added: ${found.why}.` };
}

/**
 * The pages left out of the index, in one sentence, or null when none were.
 *
 * Grouped by reason the way the reader groups them, and ending on what it
 * means here, which is the part somebody can act on: a question about one of
 * those pages is answered out of the pages that were read, or out of another
 * document, and nothing on the screen would otherwise say so.
 */
function notReadSaid(unread = []) {
  if (unread.length === 0) return null;

  const one = unread.length === 1;

  const byReason = new Map();
  for (const { page, why } of unread) byReason.set(why, [...(byReason.get(why) ?? []), page]);

  const reasons =
    byReason.size === 1
      ? `${one ? 'it has' : 'they have'} ${unread[0].why}`
      : [...byReason]
          .map(([why, pages]) => `${pageWords(pages)} ${pages.length === 1 ? 'has' : 'have'} ${why}`)
          .join('; ');

  const pages = pageWords(unread.map((each) => each.page));

  return (
    `${pages[0].toUpperCase()}${pages.slice(1)} ${one ? 'was' : 'were'} not read: ${reasons}. ` +
    `Nothing on ${one ? 'it' : 'them'} is in the index, so a question about what ${one ? 'it says' : 'they say'} ` +
    'will be answered from somewhere else.'
  );
}
