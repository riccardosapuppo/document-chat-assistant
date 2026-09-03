/**
 * The service, and the console it serves.
 *
 * One route matters: `POST /api/ask`, which answers a question **both ways** —
 * by plain similarity and by looking at the question first — and returns both
 * with the reasoning attached.
 *
 * Returning both is the whole design. A system that answers one way and shows
 * you the answer is asking to be believed; this shows what the ordinary
 * approach would have said next to what it says instead, so the difference is
 * something a reader can see rather than a claim they have to accept. On the
 * questions where they agree it says so, which is most of them and is the
 * honest half of the argument.
 *
 * There is no model here and nothing is generated. What comes back is the
 * passage itself, with its document and heading. A sentence assembled from
 * retrieved text would be the part everybody looks at and the part nobody can
 * check, and it would hide precisely what this project is about.
 */

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bySimilarityAlone, byWhatKindOfQuestionItIs } from '../ask/find.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * @param corpus the documents in play, and the index over them. Given rather
 *   than built here, because somebody adding a document rebuilds the whole
 *   index -- a document's NAMES depend on what else is in the corpus -- and
 *   that belongs in one place, which is `src/index/corpus.js`.
 */
export function api({ corpus, log = () => {} }) {
  // Read through a getter everywhere below: adding a document replaces the
  // index, and a route holding a reference taken at startup would go on
  // answering out of the corpus as it was before anybody added anything.
  const theIndex = () => corpus.index;
  const app = express();

  // Big enough for a PDF as base64, which is a third larger than the file.
  // The real limits are in `corpus.js`, where they can say why in words --
  // this one only stops a body nobody meant to send.
  app.use(express.json({ limit: '8mb' }));

  const root = path.join(here, '..', '..');

  /**
   * Nothing here is stored, and nothing is immutable either: these files carry
   * no hash in their names, so immutable would mean a change that never
   * arrives. `etag` and `lastModified` are separate options and both default to
   * on — turning off only the first leaves the revalidation that serves
   * somebody yesterday's page.
   */
  const never = {
    etag: false,
    lastModified: false,
    setHeaders(response) {
      response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    },
  };

  app.use(express.static(path.join(root, 'public'), never));

  app.get('/api/health', (_request, response) => {
    response.json({
      ok: true,
      documents: theIndex().documents,
      pieces: theIndex().chunks.length,
      embeddings: theIndex().provider,
      lexical: theIndex().lexical,
      generates: 'nothing — it returns the passage, with where it came from',
    });
  });

  /** What is indexed, and what each document is called. */
  app.get('/api/documents', (_request, response) => {
    response.json({
      documents: theIndex().documents.map((name) => ({
        name,
        pieces: theIndex().chunks.filter((one) => one.document === name).length,
        called: theIndex().called?.get(name) ?? [],
        // Which of them are the invented manuals, and which somebody added.
        given: corpus.documents.find((one) => one.name === name)?.given ?? false,
      })),
      addedCharacters: corpus.addedCharacters,
    });
  });

  /**
   * A question, answered both ways.
   *
   * `history` is the questions asked before it, in order. It is sent by the
   * caller rather than kept here on purpose: a conversation belongs to whoever
   * is having it, and a service that remembers one is a service that has to be
   * told when somebody has finished.
   */
  app.post('/api/ask', (request, response) => {
    const question = String(request.body?.question ?? '').trim();
    const history = Array.isArray(request.body?.history) ? request.body.history.map(String) : [];

    if (!question) return response.status(400).json({ error: 'what is the question?' });

    const index = theIndex();
    const plain = bySimilarityAlone(question, index, { most: 4 });
    const knowing = byWhatKindOfQuestionItIs(question, index, { history, most: 4 });

    const same = plain[0]?.chunk.id === knowing.found[0]?.chunk.id;

    log('info', 'asked', { question, how: knowing.how, same });

    response.json({
      question,
      // What the question was taken to be, and why. Shown on the screen: a
      // decision nobody can inspect is a decision nobody can correct.
      kind: {
        standsAlone: knowing.kind.standsAlone,
        leaning: knowing.kind.leaning,
        literal: knowing.kind.literal,
        terms: knowing.kind.terms,
        asked: knowing.asked,
        document: knowing.named?.document ?? null,
        documentWhy: knowing.named?.why ?? null,
      },
      how: knowing.how,
      same,
      plain: plain.map(asAnswer),
      knowing: knowing.found.map(asAnswer),
    });
  });

  /**
   * Add a document, and ask questions about it.
   *
   * JSON rather than a multipart upload, and that is a decision. Multipart
   * means a parser -- a dependency, or three hundred lines of boundary
   * handling -- to move bytes the page has already read. The page reads the
   * file, sends text as text and a PDF as base64, and this project keeps its
   * one dependency.
   *
   * NOTHING IS WRITTEN TO DISK. An added document lives in memory and dies
   * with the process. That is not a missing feature: an upload folder on a
   * machine somebody else is running is a place to put things that should not
   * be there, and this is a demonstration anybody can open.
   */
  app.post('/api/documents', (request, response) => {
    const name = String(request.body?.name ?? "").trim();
    if (!name) return response.status(400).json({ ok: false, why: "that upload has no file name" });

    const base64 = request.body?.base64;
    const text = request.body?.text;

    if (typeof base64 !== "string" && typeof text !== "string") {
      return response.status(400).json({ ok: false, why: "send either text or base64" });
    }

    const said = corpus.add({
      name,
      text,
      bytes: typeof base64 === "string" ? Buffer.from(base64, "base64") : null,
    });

    // 422 rather than 400 for a refusal: the request was well formed and the
    // document was not usable, which is a different thing and the page says
    // so differently.
    if (!said.ok) return response.status(422).json(said);

    response.json({
      ...said,
      documents: theIndex().documents,
      pieces: theIndex().chunks.length,
    });
  });

  /** Remove one that was added. The invented three stay. */
  app.delete('/api/documents/:name', (request, response) => {
    const said = corpus.remove(request.params.name);
    if (!said.ok) return response.status(404).json(said);

    response.json({ ...said, documents: theIndex().documents, pieces: theIndex().chunks.length });
  });

  /** Back to the three invented manuals. */
  app.post('/api/documents/reset', (_request, response) => {
    corpus.reset();
    response.json({ ok: true, documents: theIndex().documents, pieces: theIndex().chunks.length });
  });

  app.use((error, _request, response, _next) => {
    log('error', 'the request could not be handled', { why: error.message });
    response.status(500).json({ error: error.message });
  });

  return app;
}

/** A retrieved passage, as something a screen can show and a person can check. */
function asAnswer(one) {
  return {
    id: one.chunk.id,
    document: one.chunk.document,
    heading: one.chunk.heading,
    text: one.chunk.text,
    score: Number(one.score.toFixed(4)),
    why: one.why,
  };
}
