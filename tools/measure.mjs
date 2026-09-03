#!/usr/bin/env node
/**
 * The claim, measured.
 *
 *     npm run measure
 *     EMBEDDINGS=openai OPENAI_API_KEY=… npm run measure
 *
 * Runs both retrievals over the same questions and reports the difference per
 * kind of question. Per kind, not as one average, because the finding is not
 * "this is better" — it is "the baseline is wrong in particular places, and
 * here they are".
 *
 * It also says which provider produced the numbers, and what that provider
 * leans towards, because the local one is lexical: it matches words rather than
 * meanings, which makes it unusually good at the very questions a real
 * embedding is worst at. A table that did not say so would be a table about
 * nothing.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build, readFolder } from '../src/index/build.js';
import { provider } from '../src/index/embed.js';
import { bySimilarityAlone, byWhatKindOfQuestionItIs } from '../src/ask/find.js';
import { KINDS, QUESTIONS, foundIt, foundItAtAll } from '../src/measure/questions.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const folder = path.join(here, '..', 'samples');

const chosen = provider();
const index = build(readFolder(folder), { provider: chosen });

console.log(`  ${index.documents.length} documents, ${index.chunks.length} pieces, ${QUESTIONS.length} questions`);
console.log(`  embeddings: ${index.provider}\n`);

if (index.lexical) {
  console.log('  This provider is LEXICAL: it matches words, not meanings. Read the table');
  console.log('  with that in mind — it flatters the baseline on anything written the way');
  console.log('  the document writes it, and punishes it on anything that is not.');
  console.log('  Run it again with EMBEDDINGS=openai to see the other shape.\n');
}

// --------------------------------------------------------------------- run it

const results = QUESTIONS.map((one) => {
  const history = one.history ?? [];

  // The baseline gets the question exactly as it arrived, which is the whole
  // point of it being the baseline: it has nowhere to put the history.
  const plain = bySimilarityAlone(one.ask, index);
  const knowing = byWhatKindOfQuestionItIs(one.ask, index, { history });

  return {
    ...one,
    plain: { first: foundIt(plain, one.answeredBy), anywhere: foundItAtAll(plain, one.answeredBy), found: plain },
    knowing: {
      first: foundIt(knowing.found, one.answeredBy),
      anywhere: foundItAtAll(knowing.found, one.answeredBy),
      how: knowing.how,
      found: knowing.found,
    },
  };
});

// ---------------------------------------------------------------- the table

const wide = Math.max(...KINDS.map((one) => one.length));

console.log(`  ${'question'.padEnd(wide)}   similarity alone   knowing the kind`);
console.log(`  ${'-'.repeat(wide)}   ----------------   ----------------`);

for (const kind of KINDS) {
  const mine = results.filter((one) => one.kind === kind);
  const plain = mine.filter((one) => one.plain.first).length;
  const knowing = mine.filter((one) => one.knowing.first).length;

  const arrow = knowing > plain ? '  ←' : knowing < plain ? '  ← WORSE' : '';

  console.log(
    `  ${kind.padEnd(wide)}   ${String(plain).padStart(8)}/${mine.length}        ${String(knowing).padStart(8)}/${mine.length}${arrow}`
  );
}

const plainAll = results.filter((one) => one.plain.first).length;
const knowingAll = results.filter((one) => one.knowing.first).length;

console.log(`  ${'-'.repeat(wide)}   ----------------   ----------------`);
console.log(
  `  ${'all of them'.padEnd(wide)}   ${String(plainAll).padStart(8)}/${results.length}        ${String(knowingAll).padStart(8)}/${results.length}`
);

// ------------------------------------------------------- what changed, and why

console.log('\n  Where they disagreed\n');

let disagreements = 0;

for (const one of results) {
  if (one.plain.first === one.knowing.first) continue;
  disagreements += 1;

  const better = one.knowing.first;
  console.log(`  ${better ? '+' : '-'} "${one.ask}"  (${one.kind})`);
  console.log(`      wanted:              ${one.answeredBy.document} / ${one.answeredBy.heading}`);
  console.log(`      similarity alone:    ${describe(one.plain.found[0])}`);
  console.log(`      knowing the kind:    ${describe(one.knowing.found[0])}`);
  console.log(`      how:                 ${one.knowing.how}\n`);
}

if (disagreements === 0) console.log('  They agreed on every question.\n');

// ------------------------------------------------------------ and the misses

const missed = results.filter((one) => !one.knowing.first);

if (missed.length > 0) {
  console.log('  Still wrong, knowing the kind\n');

  for (const one of missed) {
    console.log(`  ! "${one.ask}"  (${one.kind})`);
    console.log(`      wanted: ${one.answeredBy.document} / ${one.answeredBy.heading}`);
    console.log(`      got:    ${describe(one.knowing.found[0])}`);
    console.log(`      ${one.knowing.anywhere ? 'it was in the top five, just not first' : 'not in the top five at all'}\n`);
  }
}

/**
 * The exit code is about the ordinary questions only.
 *
 * A change that improves the awkward questions by breaking the plain ones is
 * not an improvement, and that is the regression worth failing on. The rest is
 * a report to read, not a gate: this number is expected to move as the corpus
 * and the questions grow.
 */
const ordinary = results.filter((one) => one.kind === 'ordinary');

// A regression is a question the baseline got RIGHT and this gets wrong. Not
// one they both miss: that is a limitation shared with the thing being compared
// against, and failing the run for it would mean the gate is really asking
// "is retrieval solved yet", which it is not and this cannot be.
const traded = ordinary.filter((one) => one.plain.first && !one.knowing.first);

if (traded.length > 0) {
  console.log(`  ${traded.length} ordinary question(s) that plain similarity got right, this gets wrong:`);
  for (const one of traded) console.log(`    "${one.ask}"`);
  console.log('  That is a trade, not an improvement.');
  process.exitCode = 1;
} else {
  console.log('  Nothing plain similarity got right was traded away.');
}

function describe(one) {
  if (!one) return '(nothing at all)';
  return `${one.chunk.document} / ${one.chunk.heading}   — ${one.why}`;
}
