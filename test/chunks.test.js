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
