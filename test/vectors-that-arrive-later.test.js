/**
 * Vectors that arrive after the code asking for them has moved on.
 *
 * The OpenAI provider fetches its vectors, so each one is a promise, and three
 * places asked for them without waiting. The measurement built its index with
 * a synchronous build; the service awaited a build of its own, threw it away,
 * and answered from the corpus's synchronous one; and neither search awaited a
 * question's vector. A promise compares as nothing, so every score was 0,
 * similarity alone found nothing for any question, and
 * `EMBEDDINGS=openai npm run measure` printed 0/12 for it with an exit code of
 * 0.
 *
 * Nothing here leaves the machine and no key is needed: `fetch` is answered in
 * this process by a stand-in for the embeddings endpoint.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { bySimilarityAlone, byWhatKindOfQuestionItIs } from '../src/ask/find.js';
import { api } from '../src/http/api.js';
import { buildAsync, readFolder } from '../src/index/build.js';
import { corpus } from '../src/index/corpus.js';
import { provider } from '../src/index/embed.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The embeddings endpoint, answered in this process.
 *
 * Every word of four letters or more is hashed to one of 512 directions, and a
 * text's vector is how often it says each. Deterministic, and two texts that
 * share a word point partly the same way, which is all a test of the plumbing
 * needs from it. Any other address is refused, so a test that tried to reach
 * the network would fail here rather than reach it.
 *
 * Nothing in it names anything outside it, because its source is also handed
 * to another process, at the bottom of this file.
 */
function standIn() {
  const vectorOf = (text) => {
    const vector = new Array(512).fill(0);

    for (const word of String(text).toLowerCase().match(/[a-z0-9][a-z0-9_-]{3,}/g) ?? []) {
      let hash = 2166136261;
      for (const letter of word) hash = Math.imul(hash ^ letter.charCodeAt(0), 16777619) >>> 0;
      vector[hash % vector.length] += 1;
    }

    return vector;
  };

  async function fetch(url, init = {}) {
    if (String(url) !== 'https://api.openai.com/v1/embeddings') {
      throw new Error(`nothing here reaches the network, and this was asked to reach ${url}`);
    }

    const { input } = JSON.parse(init.body);

    return Response.json({ data: input.map((text, index) => ({ index, embedding: vectorOf(text) })) });
  }

  return { fetch };
}

const service = standIn();
const theNetwork = globalThis.fetch;

// Before anything below can ask for a vector.
globalThis.fetch = service.fetch;

after(() => {
  globalThis.fetch = theNetwork;
});

/** An embeddings service that is there and will not answer. */
const refusing = async () => new Response('the service is overloaded', { status: 503 });

const remote = provider({ name: 'openai', key: 'not-a-key' });
const samples = readFolder(path.join(root, 'samples'));

/** A manual for something that is not a printer, as the screen check adds one. */
const KETTLE = [
  '# Coldstream K9 kettle',
  '',
  '## Filling it',
  'The maximum is 1.7 litres, marked inside the body.',
  '',
  '## Descaling',
  'Use citric acid every two months in hard water.',
].join('\n');

describe('a question, asked of an index whose vectors arrive over the network', () => {
  it('is compared with every passage once its own vector has arrived', async () => {
    const index = await buildAsync(samples, { provider: remote });
    const found = await bySimilarityAlone('how do I load a ribbon', index);

    assert.ok(found.length > 0, 'similarity alone found nothing: the question was compared before its vector arrived');
    assert.ok(found[0].score > 0 && found[0].score <= 1 + 1e-9, `the best score was ${found[0].score}`);
    assert.match(found[0].chunk.text, /ribbon/i);
  });

  it('by the search that looks at the question first, too', async () => {
    // No heading shares a word with this question and nothing in it is
    // literal, so whatever this search returns for it came from the vectors.
    // Comparing with a promise, it returned nothing at all.
    const index = await buildAsync(samples, { provider: remote });
    const knowing = await byWhatKindOfQuestionItIs('my labels come out faded on one side only', index);

    assert.ok(knowing.found.length > 0, 'the search that looks at the question first found nothing');
    assert.ok(knowing.found.every((one) => one.score > 0));
  });
});

describe('the corpus the service answers from', () => {
  it('holds vectors, not promises of them, before the first question is asked', async () => {
    const held = await corpus({ samples, provider: remote });

    for (const chunk of held.index.chunks) {
      assert.ok(Array.isArray(chunk.vector), `${chunk.id} holds ${chunk.vector} rather than a vector`);
    }
  });

  it('and is rebuilt from them when somebody adds a document, which is then found', async () => {
    const held = await corpus({ samples, provider: remote });
    const said = await held.add({ name: 'kettle-manual.md', text: KETTLE });

    assert.equal(said.ok, true, said.why);

    const knowing = await byWhatKindOfQuestionItIs('how much water does the kettle hold', held.index);

    assert.equal(knowing.found[0]?.chunk.document, 'kettle-manual');
  });

  it('while a rebuild that fails changes nothing, rather than listing a document no answer can come from', async () => {
    const held = await corpus({ samples, provider: remote });
    const before = { documents: held.documents, index: held.index };

    globalThis.fetch = refusing;

    try {
      await assert.rejects(held.add({ name: 'kettle-manual.md', text: KETTLE }), /answered 503/);
    } finally {
      globalThis.fetch = service.fetch;
    }

    assert.deepEqual(held.documents, before.documents);
    assert.equal(held.index, before.index);
  });

  it('and rebuilds one at a time, so a slow one cannot finish on top of a later one', async () => {
    const held = await corpus({ samples, provider: remote });

    // Indexing the added document takes a while and the reset asked for after
    // it does not. Run side by side, the reset would finish first and the add
    // would then land on top of it, putting back what the reset took away.
    globalThis.fetch = async (url, init) => {
      if (String(init?.body).includes('slowly')) await new Promise((done) => setTimeout(done, 50));
      return service.fetch(url, init);
    };

    try {
      await Promise.all([held.add({ name: 'slow.md', text: '# Slow\n\nThis one is indexed slowly.' }), held.reset()]);
    } finally {
      globalThis.fetch = service.fetch;
    }

    const given = samples.map((one) => one.name);

    assert.deepEqual(held.index.documents, given, 'the index is not what the reset left');
    assert.deepEqual(
      held.documents.map((one) => one.name),
      given
    );
  });
});

describe('the service, when the embeddings service refuses', () => {
  it('says so in the answer, and is still there for the next question', async () => {
    // Express 4 ignores the promise a handler returns. Unless the failure is
    // handed on, the request hangs and the rejection ends the process.
    const held = await corpus({ samples, provider: remote });
    const server = api({ corpus: held }).listen(0, '127.0.0.1');
    await once(server, 'listening');

    // A request that never comes back is the failure being looked for, so it
    // is given five seconds rather than for ever: this fails, it does not hang.
    const ask = (question) =>
      theNetwork(`http://127.0.0.1:${server.address().port}/api/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question }),
        signal: AbortSignal.timeout(5_000),
      });

    try {
      globalThis.fetch = refusing;
      const refused = await ask('how do I load a ribbon');

      assert.equal(refused.status, 500);
      assert.match((await refused.json()).error, /answered 503/);

      globalThis.fetch = service.fetch;
      const answered = await ask('how do I load a ribbon');

      assert.equal(answered.status, 200);
      assert.ok((await answered.json()).plain.length > 0, 'the next question was not answered');
    } finally {
      globalThis.fetch = service.fetch;
      server.closeAllConnections();
      server.close();
    }
  });
});

describe('npm run measure, with those embeddings', () => {
  /**
   * The same stand-in, in front of the measurement's own fetch.
   *
   * The measurement is a program rather than a function, and `--import` is the
   * one way in before its first line runs. The stand-in's source goes as a
   * data URL, so nothing is written anywhere for the purpose.
   */
  const inFront = `data:text/javascript,${encodeURIComponent(`globalThis.fetch = (${standIn})().fetch;`)}`;

  it('scores similarity alone, instead of finding nothing for any question', () => {
    const run = spawnSync(process.execPath, ['--import', inFront, path.join('tools', 'measure.mjs')], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, EMBEDDINGS: 'openai', OPENAI_API_KEY: 'not-a-key' },
      timeout: 60_000,
    });

    const all = run.stdout.match(/all of them\s+(\d+)\/(\d+)\s+(\d+)\/(\d+)/);

    assert.ok(all, `the measurement printed no table:\n${run.stderr}`);
    assert.match(run.stdout, /embeddings: openai:/, 'it measured a provider other than the one asked for');
    assert.ok(Number(all[1]) > 0, `similarity alone found ${all[1]}/${all[2]}: the vectors were compared before they arrived`);
  });
});
