/**
 * Working out which document a question is about.
 *
 * This step exists because the measurement found its absence within a minute:
 * two manuals written from the same template have almost the same headings, so
 * a question about one retrieved the right section of the other — the most
 * convincing wrong answer a manual can give, since everything about it looks
 * right including the heading.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { only, whatEachIsCalled, whichDocument } from '../src/ask/which-document.js';

const documents = [
  {
    name: 'tp40',
    text: '# Halden TP-40 label printer\n\nThe TP-40 is a desktop thermal transfer printer for shelf labels. It is the smallest machine in the range.\n\n## Margins\n\nThe smallest margin is 4 mm.\n',
  },
  {
    name: 'tp60',
    text: '# Halden TP-60 label printer\n\nThe TP-60 is the wide-format machine in the TP range. It shares its ribbon with the TP-40.\n\n## Margins\n\nThe smallest margin is 6 mm at the sides.\n',
  },
  {
    name: 'codes',
    text: '# Halden TP range: fault codes\n\nEvery code the printers report on the status display.\n\n## E-4412\n\nThe head did not warm up.\n',
  },
];

const called = whatEachIsCalled(documents);

describe('what each document calls itself', () => {
  it('knows its part number, in the ways people write one', () => {
    const names = called.get('tp40');

    for (const spelling of ['tp-40', 'tp40', 'tp 40', 'tp/40']) {
      assert.ok(names.includes(spelling), `${spelling} is missing from ${names.join(', ')}`);
    }
  });

  it('and picks up what only it says about itself', () => {
    // "wide-format" appears in the TP-60 and nowhere else, which is what makes
    // "and the wide one?" answerable at all.
    assert.ok(called.get('tp60').includes('wide-format'), called.get('tp60').join(', '));
  });

  it('but not a word another document also uses', () => {
    // "machine" is in the TP-60's opening sentence and in the TP-40's second.
    // A word that appears anywhere in another document cannot be a name for
    // this one — the weaker rule, distinctive-among-openings, let it through
    // and routed general questions to whichever manual said it first.
    for (const [document, names] of called) {
      assert.equal(names.includes('machine'), false, `${document} claims "machine" as a name for itself`);
      assert.equal(names.includes('range'), false, `${document} claims "range" as a name for itself`);
    }
  });

  it('and never claims another document’s part number', () => {
    // The TP-60 manual mentions the TP-40 in its opening. Taking that as a name
    // for the TP-60 is the worst entry this list can hold.
    assert.equal(called.get('tp60').includes('tp-40'), false, called.get('tp60').join(', '));
  });
});

describe('which document a question names', () => {
  it('finds it by part number', () => {
    assert.equal(whichDocument('what margin does the TP-60 need', called).document, 'tp60');
  });

  it('and by the word only that document uses', () => {
    assert.equal(whichDocument('and the wide one?', called).document, 'tp60');
  });

  it('says which words gave it away', () => {
    assert.match(whichDocument('the TP-40 margin', called).why, /tp-40|tp40/);
  });

  it('names none when the question does not', () => {
    assert.equal(whichDocument('what is a margin', called).document, null);
  });

  it('and a word both titles share is nobody’s name', () => {
    // "label printer" is in both titles, so it names neither. It used to name
    // both, and the tie rule then had to break it — a rule that is never
    // reached is a rule that has stopped being tested, so the case is asserted
    // where it now actually happens.
    for (const [document, names] of called) {
      assert.equal(names.includes('printer'), false, `${document} claims "printer"`);
    }

    assert.equal(whichDocument('label printer', called).document, null);
  });

  it('and refuses to guess when a question names two of them', () => {
    // Guessing is how the right section of the wrong machine gets returned.
    const said = whichDocument('do the TP-40 and the TP-60 take the same ribbon', called);

    assert.equal(said.document, null);
    assert.match(said.why, /guessing between them/);
  });
});

describe('searching within one document', () => {
  it('leaves only its pieces, and keeps everything else about the index', () => {
    const index = { chunks: [{ document: 'tp40' }, { document: 'tp60' }, { document: 'tp40' }], provider: 'local' };
    const narrowed = only('tp40', index);

    assert.equal(narrowed.chunks.length, 2);
    assert.equal(narrowed.provider, 'local');
  });
});
