/**
 * Cutting a document up.
 *
 * The assertions here are about the two ways a cut ruins retrieval: a piece
 * that ends mid-sentence, and a piece that spans two sections and therefore
 * belongs to neither question.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { cutUp, sections, windowed } from '../src/index/chunks.js';

describe('finding the sections', () => {
  it('cuts at a heading', () => {
    const found = sections(['# Installing', '', 'Run the installer.', '', '# Uninstalling', '', 'Use the control panel.'].join('\n'));

    assert.equal(found.length, 2);
    assert.deepEqual(
      found.map((one) => one.heading),
      ['Installing', 'Uninstalling']
    );
  });

  it('keeps the heading with the section it names', () => {
    // Often the only place the subject appears. "Set it to 4 mm" retrieves for
    // nothing; the same line under "Margins" retrieves for margins.
    const [first] = sections('# Margins\n\nSet it to 4 mm.\n');

    assert.match(first.text, /Margins/);
    assert.match(first.text, /4 mm/);
  });

  it('does not mistake an ordinary sentence for a heading', () => {
    // Being wrong in this direction cuts a paragraph in half, which is worse
    // than missing a heading and falling back to the window.
    const found = sections('The printer needs a moment to warm up\nand then it will accept the job.\n');

    assert.equal(found.length, 1);
  });

  it('and keeps text that appears before any heading', () => {
    const found = sections('A note before anything else.\n\n# Then a heading\n\nAnd its text.\n');

    assert.equal(found.length, 2);
    assert.match(found[0].text, /A note before/);
  });
});

describe('the sliding window', () => {
  const long = `${'Sentence one is here. '.repeat(60)}`;

  it('cuts a long section into more than one piece', () => {
    assert.ok(windowed(long, { size: 300, overlap: 60 }).length > 1);
  });

  it('and the pieces overlap, so a sentence across a cut is whole somewhere', () => {
    const pieces = windowed(long, { size: 300, overlap: 60 });
    const [first, second] = pieces;

    const tail = first.slice(-40);
    assert.ok(second.includes(tail.trim().split(' ').slice(-3).join(' ')), 'the pieces do not overlap at all');
  });

  it('ends a piece at a sentence boundary rather than mid-word', () => {
    for (const piece of windowed(long, { size: 300, overlap: 60 }).slice(0, -1)) {
      assert.match(piece, /[.\n]$/, `a piece ended mid-thought: …${piece.slice(-30)}`);
    }
  });

  it('but takes the hard cut when there is no boundary to back off to', () => {
    // A table or a long list has no full stops. Searching further back would
    // return a piece a third of the size, which is worse than a clean cut.
    const noStops = 'aaaa '.repeat(200);
    const pieces = windowed(noStops, { size: 300, overlap: 60 });

    assert.ok(pieces.length > 1);
    assert.ok(pieces[0].length > 200, `backed off too far: ${pieces[0].length} characters`);
  });

  it('never loops, whatever the overlap is set to', () => {
    // An overlap as wide as the window steps nowhere. This used to be a hang.
    assert.ok(windowed(long, { size: 200, overlap: 200 }).length > 1);
    assert.ok(windowed(long, { size: 200, overlap: 5000 }).length > 1);
  });

  it('has nothing to say about nothing', () => {
    assert.deepEqual(windowed(''), []);
    assert.deepEqual(windowed('   \n  '), []);
  });
});

describe('a whole document', () => {
  const manual = [
    '# Installing',
    '',
    'Run the installer and follow it.',
    '',
    '# Margins',
    '',
    'Set the margin to 4 mm. Anything smaller is refused by the tray.',
  ].join('\n');

  it('comes back as pieces that each say where they came from', () => {
    for (const piece of cutUp('tray-manual', manual)) {
      assert.equal(piece.document, 'tray-manual');
      assert.ok(piece.heading, 'a piece with no heading cannot be cited');
      assert.ok(piece.id.startsWith('tray-manual#'));
    }
  });

  it('and no piece spans two sections', () => {
    // A piece across the end of "Installing" and the start of "Margins"
    // retrieves for both questions and answers neither.
    for (const piece of cutUp('tray-manual', manual)) {
      const mentionsBoth = /Installing/.test(piece.text) && /Margins/.test(piece.text);
      assert.equal(mentionsBoth, false, piece.text);
    }
  });
});

/**
 * Where a piece begins, which nothing was looking after.
 *
 * The window backs off to a sentence boundary so a piece does not END
 * mid-thought. Nothing did the same for the start: the next piece begins at a
 * fixed step that knows nothing about where the last one really finished, and
 * on continuous text with few full stops — an invoice, a table, a price list —
 * it lands inside a word almost every time.
 *
 * That is the end somebody reads first. A passage offered as evidence that
 * opens with "ota variabile" is one nobody can check, which is the only thing
 * this project claims to be for.
 */
describe('where a piece begins', () => {
  /** Continuous prose with no full stops, which is what a bill looks like. */
  const flowing =
    'AGGIORNAMENTO CORRISPETTIVI In questa bolletta sono stati aggiornati i seguenti corrispettivi: ' +
    'voce di spesa per la materia energia con quota fissa e quota variabile applicata al consumo '.repeat(8);

  /** Whether the first word of a piece is a whole word of the source. */
  const startsWhole = (piece, source) => {
    const first = piece.split(/\s/)[0];
    if (!first) return true;
    return new RegExp(`(^|\\s)${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(source);
  };

  it('is a word boundary, not wherever the step happened to land', () => {
    for (const size of [200, 400, 900]) {
      const pieces = windowed(flowing, { size, overlap: Math.floor(size / 5) });

      for (const [at, piece] of pieces.entries()) {
        assert.equal(
          startsWhole(piece, flowing),
          true,
          `window ${size}, piece ${at + 1} begins mid-word: ${JSON.stringify(piece.slice(0, 40))}`
        );
      }
    }
  });

  it('and the words are all still there, because the overlap already held them', () => {
    // Trimming a fragment must not lose a word: the piece before it contains
    // the whole one. If it did lose one, this would be a worse defect than the
    // one being fixed, and a silent one.
    const pieces = windowed(flowing, { size: 200, overlap: 40 });
    const words = new Set(flowing.split(/\s+/).filter(Boolean));

    for (const word of words) {
      assert.ok(
        pieces.some((piece) => piece.includes(word)),
        `"${word}" is in the source and in no piece`
      );
    }
  });

  it('and a piece that begins the document is left alone', () => {
    const [first] = windowed(flowing, { size: 200, overlap: 40 });

    assert.ok(first.startsWith('AGGIORNAMENTO CORRISPETTIVI'), first.slice(0, 40));
  });
});
