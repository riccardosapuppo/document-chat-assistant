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

export function api({ index, log = () => {} }) {
  const app = express();

  app.use(express.json({ limit: '1mb' }));

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
      documents: index.documents,
      pieces: index.chunks.length,
      embeddings: index.provider,
      lexical: index.lexical,
      generates: 'nothing — it returns the passage, with where it came from',
    });
  });

  /** What is indexed, and what each document is called. */
  app.get('/api/documents', (_request, response) => {
    response.json({
      documents: index.documents.map((name) => ({
        name,
        pieces: index.chunks.filter((one) => one.document === name).length,
        called: index.called?.get(name) ?? [],
      })),
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
