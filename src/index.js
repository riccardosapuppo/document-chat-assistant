#!/usr/bin/env node
/**
 * Starts the service and the console.
 *
 *     npm start
 *
 * Nothing needed: no account, no key, no model, no database, no container. The
 * documents in `samples/` are read and indexed at startup, which for a corpus
 * this size takes less time than the port takes to bind.
 *
 * `EMBEDDINGS=openai OPENAI_API_KEY=… npm start` uses real embeddings instead,
 * and the console says which is in use — the two behave differently in ways
 * this project exists to show, so which one answered is part of the answer.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { api } from './http/api.js';
import { buildAsync, readFolder } from './index/build.js';
import { corpus } from './index/corpus.js';
import { provider } from './index/embed.js';
import { openInABrowser } from './open-a-browser.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 3700);
const HOST = process.env.HOST ?? '127.0.0.1';
const FOLDER = process.env.DOCUMENTS ?? path.join(here, '..', 'samples');

function log(level, message, detail = {}) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), level, message, ...detail })}\n`);
}

const chosen = provider();
const documents = readFolder(FOLDER);

if (documents.length === 0) {
  process.stderr.write(`\n  there are no .md or .txt documents in ${FOLDER}\n\n`);
  process.exit(1);
}

// The remote provider fetches; the local one does not. Both are awaited so the
// service never starts answering from a half-built index.
if (chosen.needsNetwork) await buildAsync(documents, { provider: chosen });

/**
 * The documents in play, which is not a fixed set.
 *
 * Somebody can drop a document into the console and ask questions about it,
 * and doing so rebuilds the whole index rather than appending to it -- because
 * a document is FOUND by names worked out against the whole corpus, and a
 * fourth document can take a name away from the second. See corpus.js.
 */
const held = corpus({ samples: documents, provider: chosen, log });

const app = api({ corpus: held, log });

const server = app.listen(PORT, HOST, () => {
  log('info', 'listening', {
    console: `http://${HOST}:${PORT}`,
    documents: held.index.documents.length,
    pieces: held.index.chunks.length,
    embeddings: held.index.provider,
  });

  // The page, in front of whoever started this. Never in CI, never without a
  // terminal, and never when told not to — see `open-a-browser.js`.
  const browser = openInABrowser(`http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}/`);
  log('info', browser.opened ? 'the page is open' : 'the page was not opened', { why: browser.why });
});

/**
 * A port that is already taken is a sentence, not a stack trace.
 *
 * Node's default for this is eleven lines of `at Server.setupListenHandle`
 * ending in EADDRINUSE, which says what happened to somebody who already knows
 * and nothing at all to anybody else. It happens on every second start during
 * development, and the thing the reader needs is the way out.
 */
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    log('error', `something is already listening on ${HOST}:${PORT}`, {
      likely: 'another copy of this service, or another project using the same port',
      try: `PORT=${PORT + 1} npm start`,
    });
    process.exit(1);
  }

  if (error.code === 'EACCES') {
    log('error', `not allowed to listen on port ${PORT}`, {
      likely: 'ports below 1024 need privileges this process does not have',
    });
    process.exit(1);
  }

  throw error;
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log('info', 'stopping');
    server.close(() => process.exit(0));
  });
}
