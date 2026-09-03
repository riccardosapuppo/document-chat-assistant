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
import { build, buildAsync, readFolder } from './index/build.js';
import { provider } from './index/embed.js';

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
const index = chosen.needsNetwork
  ? await buildAsync(documents, { provider: chosen })
  : build(documents, { provider: chosen });

const app = api({ index, log });

const server = app.listen(PORT, HOST, () => {
  log('info', 'listening', {
    console: `http://${HOST}:${PORT}`,
    documents: index.documents.length,
    pieces: index.chunks.length,
    embeddings: index.provider,
  });
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log('info', 'stopping');
    server.close(() => process.exit(0));
  });
}
