/**
 * Turning text into something comparable.
 *
 * The assertions worth having here are about the two ways a similarity search
 * silently misranks: length, and common words.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { alikeness, learnFrom, provider, vectorFor } from '../src/index/embed.js';

const corpus = [
  'The tray takes paper between 60 and 200 grams per square metre.',
  'The margin can be set no smaller than 4 mm on any edge.',
  'Error E-4412 means the fuser did not reach temperature in time.',
  'The tray is released by pressing the grey catch on the left.',
  'Replace the drum every 40,000 pages or when print quality falls.',
];

const learned = learnFrom(corpus);

describe('how rare a word is', () => {
  it('is what makes similarity mean anything', () => {
    // Without it "the tray" and "the margin" are alike because both say "the".
    // "tray" appears in two of five; "drum" in one.
    assert.ok(
      (learned.weight.get('drum') ?? 0) > (learned.weight.get('tray') ?? 0),
      'a word in one document should weigh more than a word in two'
    );
  });

  it('and a word in every document still says a little, not nothing', () => {
    const everywhere = learnFrom(['paper here', 'paper there', 'paper everywhere']);

    assert.ok((everywhere.weight.get('paper') ?? 0) > 0, 'a weight of exactly zero throws information away');
  });
});

describe('one text as a vector', () => {
  it('is unit length, so long chunks do not outrank short ones', () => {
    // A comparison that does not divide out length ranks the longest chunk
    // first on every query, which looks like relevance and is not.
    for (const text of corpus) {
      const vector = vectorFor(text, learned);
      const length = Math.sqrt([...vector.values()].reduce((all, one) => all + one * one, 0));

      assert.ok(Math.abs(length - 1) < 1e-9, `length was ${length}`);
    }
  });

  it('flattens repetition rather than counting it', () => {
    // A word said eight times is not eight times as much about it as once.
    const once = vectorFor('drum', learned);
    const often = vectorFor('drum drum drum drum drum drum drum drum', learned);

    assert.ok(Math.abs((once.get('drum') ?? 0) - (often.get('drum') ?? 0)) < 1e-9);
  });

  it('and ignores a word the corpus has never seen', () => {
    // A question can contain anything; an unknown word must weigh nothing
    // rather than an undefined amount.
    const vector = vectorFor('quantum tray', learned);

    assert.equal(vector.has('quantum'), false);
    assert.ok(vector.has('tray'));
  });

  it('so a text made only of unknown words is comparable to nothing', () => {
    const nothing = vectorFor('quantum flibbertigibbet', learned);

    assert.equal(nothing.size, 0);
    assert.equal(alikeness(nothing, vectorFor(corpus[0], learned)), 0);
  });
});

describe('comparing two texts', () => {
  it('finds the passage about the thing asked about', () => {
    const question = vectorFor('what does the tray weigh limit', learned);

    const ranked = corpus
      .map((text) => ({ text, score: alikeness(question, vectorFor(text, learned)) }))
      .sort((a, b) => b.score - a.score);

    assert.match(ranked[0].text, /tray/);
  });

  it('and a text is perfectly alike itself', () => {
    const vector = vectorFor(corpus[2], learned);

    assert.ok(Math.abs(alikeness(vector, vector) - 1) < 1e-9);
  });
});

describe('choosing a provider', () => {
  it('is local by default, and local needs nothing', () => {
    const chosen = provider({ name: 'local' });

    assert.equal(chosen.name, 'local');
    assert.equal(chosen.needsNetwork, false);
  });

  it('says so about itself, because the difference changes what a measurement means', () => {
    // The local one is lexical: unusually good at a literal code, unusually bad
    // at a question phrased in words the document never uses. A measurement
    // that did not say which it used would be a number about nothing.
    assert.equal(provider({ name: 'local' }).lexical, true);
  });

  it('refuses openai without a key rather than falling back quietly', () => {
    // Falling back quietly is how somebody measures the wrong thing for a week
    // and then reports it.
    assert.throws(() => provider({ name: 'openai', key: undefined }), /needs OPENAI_API_KEY/);
  });

  it('and says what there is when asked for something else', () => {
    assert.throws(() => provider({ name: 'magic', key: 'x' }), /there is "local" and "openai"/);
  });
});
