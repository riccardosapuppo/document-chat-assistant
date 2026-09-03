/**
 * Working out what kind of question arrived.
 *
 * Each of these is a class of question a plain similarity search answers badly,
 * and every wrong answer in this file would have been a confident one with a
 * citation attached — which is the worst kind.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  containsSomethingLiteral,
  leansOnWhatCameBefore,
  literalTermsIn,
  variantsOf,
  waysOfWriting,
  whatKindOfQuestion,
} from '../src/ask/what-kind-of-question.js';

describe('a question that leans on the one before it', () => {
  it('is recognised by the word that points backwards', () => {
    for (const said of [
      'and what about that one?',
      'is it the same for those?',
      'does the previous model do it too',
      'e quello invece?',
      'come detto, quanto costa',
    ]) {
      assert.equal(leansOnWhatCameBefore(said).yes, true, `"${said}" was treated as standing on its own`);
    }
  });

  it('and also when it is simply too short to be about anything', () => {
    // The one everybody forgets: "and the price?" has no pointing word in it,
    // and is no more answerable on its own than "and that one?".
    for (const said of ['and the price?', 'the weight?', 'e il prezzo?', 'why?']) {
      assert.equal(leansOnWhatCameBefore(said).yes, true, `"${said}" was treated as standing on its own`);
    }
  });

  it('but a short question that names its subject stands on its own', () => {
    for (const said of ['margin size?', 'XR-200 weight', 'installing the tray', 'what is the maximum paper weight']) {
      assert.equal(leansOnWhatCameBefore(said).yes, false, `"${said}" was treated as leaning`);
    }
  });

  it('and says which word gave it away', () => {
    // A decision nobody can inspect is a decision nobody can correct — this is
    // shown on the screen and printed by the measurement.
    assert.match(leansOnWhatCameBefore('and that one?').why, /that/);
    assert.match(leansOnWhatCameBefore('and the price?').why, /carries any meaning/);
  });
});

describe('a question with something literal in it', () => {
  it('recognises an error code', () => {
    for (const said of ['what does E-4412 mean', 'I get ERR_2201 on startup', 'error 0x8007000E']) {
      assert.equal(containsSomethingLiteral(said).yes, true, said);
    }
  });

  it('recognises a function or a method', () => {
    for (const said of ['what does printAll() do', 'Tray::reset behaviour', 'when is onReady => called']) {
      assert.equal(containsSomethingLiteral(said).yes, true, said);
    }
  });

  it('recognises a setting written in shouting case', () => {
    assert.equal(containsSomethingLiteral('what is MAX_SHEET_WEIGHT for').yes, true);
  });

  it('and leaves an ordinary question alone', () => {
    // The cost of being wrong here is a literal search for a word that appears
    // everywhere, which finds everything and ranks nothing.
    for (const said of [
      'how do I change the margins',
      'what paper does the tray take',
      'come si cambia il margine',
    ]) {
      assert.equal(containsSomethingLiteral(said).yes, false, said);
    }
  });

  it('puts the most specific term first, because the first one to find anything wins', () => {
    const found = literalTermsIn('does printAll() ever return E-4412');

    assert.ok(found.length >= 2);
    assert.ok(found[0].length >= found[found.length - 1].length);
  });
});

describe('the ways one name gets written', () => {
  it('splits a part number into its four spellings', () => {
    assert.deepEqual(variantsOf('XR-200'), ['xr/200', 'xr-200', 'xr 200', 'xr200']);
  });

  it('and copes with a code that is only letters or only digits', () => {
    assert.deepEqual(variantsOf('TRAY'), ['tray']);
    assert.deepEqual(variantsOf('200'), ['200']);
    assert.deepEqual(variantsOf(''), []);
  });

  it('keeps the tail of a long name, which is the part people say', () => {
    // "the Northwind XR-200 Mark II" is asked about as "XR-200 Mark II",
    // never as "the Northwind".
    const found = waysOfWriting('Northwind XR-200 Mark II', 'XR-200');

    assert.ok(found.includes('mark ii'), found.join(' | '));
    assert.ok(found.includes('xr200'), found.join(' | '));
  });

  it('and throws away the ones too short or too empty to search on', () => {
    // A one-letter alias matches everything, which is the same as matching
    // nothing while looking like it worked.
    for (const one of waysOfWriting('The A B', 'A1')) {
      assert.ok(one.length >= 3, `"${one}" is too short to be an alias`);
    }
  });
});

describe('everything decided about one question', () => {
  it('comes back as a description, not an action', () => {
    const said = whatKindOfQuestion('what does E-4412 mean');

    assert.equal(said.standsAlone, true);
    assert.equal(said.literal.yes, true);
    assert.deepEqual(said.terms, ['E-4412']);
  });

  it('and remembers what it would be leaning on', () => {
    const said = whatKindOfQuestion('and that one?', { history: ['what does the XR-200 weigh'] });

    assert.equal(said.standsAlone, false);
    assert.equal(said.lastQuestion, 'what does the XR-200 weigh');
  });
});
