/**
 * How wide a character code is, which the reader used to assume.
 *
 * A PDF says nothing about its text in plain sight. A string in a content
 * stream is a run of CODES, and what each code means comes from the font's own
 * CMap. So does how many bytes one code takes, and that is the part this reader
 * guessed: it read four hex digits at a time, because an Identity-H CID font
 * uses two bytes per glyph and that is what it was built against.
 *
 * A font with single-byte codes writes `<010203>` and means three glyphs. Read
 * two bytes at a time it becomes `0x0102` and half of another, neither of which
 * is in the map, so every glyph came back empty. The page then had no text, the
 * document had no text layer, and a file with a perfectly good one was reported
 * as a scan that would need its pixels recognised.
 *
 * The fixtures here are built in this file rather than checked in as binaries:
 * a PDF nobody can read the source of proves nothing about a reader, and the
 * defect is small enough to write down exactly.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { hasTextLayer, readPdfText } from '../src/text/pdf.js';

/**
 * The smallest PDF that carries a text layer: one page, one font, one CMap.
 *
 * @param {{codespace: string, chars: [string, string][], shown: string}} what
 *   `codespace` is the low bound of the code space range, and its length is what
 *   declares the width. `chars` are the code-to-character pairs. `shown` is the
 *   hex string the page draws.
 */
function pdfWith({ codespace, chars, shown }) {
  const cmap = [
    '/CIDInit /ProcSet findresource begin 12 dict begin begincmap',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    `1 begincodespacerange\n<${codespace}> <${'F'.repeat(codespace.length)}>\nendcodespacerange`,
    `${chars.length} beginbfchar`,
    ...chars.map(([code, unicode]) => `<${code}> <${unicode}>`),
    'endbfchar',
    'endcmap end end',
  ].join('\n');

  const content = `BT 72 720 Td /F1 12 Tf<${shown}>Tj ET`;

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /TrueType /BaseFont /Test /ToUnicode 6 0 R >>',
    `<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream`,
  ];

  let out = '%PDF-1.4\n';
  objects.forEach((body, at) => {
    out += `${at + 1} 0 obj\n${body}\nendobj\n`;
  });
  out += 'trailer\n<< /Root 1 0 R >>\n%%EOF';

  return Buffer.from(out, 'latin1');
}

/** R, o, w — three codes of one byte, which is how a simple font writes them. */
const ONE_BYTE = pdfWith({
  codespace: '00',
  chars: [
    ['01', '0052'],
    ['02', '006F'],
    ['03', '0077'],
  ],
  shown: '010203',
});

/** The same word, from a font whose codes are two bytes wide. */
const TWO_BYTES = pdfWith({
  codespace: '0000',
  chars: [
    ['0001', '0052'],
    ['0002', '006F'],
    ['0003', '0077'],
  ],
  shown: '000100020003',
});

describe('a font whose codes are one byte wide', () => {
  it('is read, rather than reported as a scan', () => {
    const read = readPdfText(ONE_BYTE);

    assert.equal(read.text, 'Row');
    assert.match(read.why, /read from the text layer/);
  });

  it('and the document is not mistaken for one with no text layer', () => {
    // This is the sentence somebody saw instead of their document: the reader
    // found the page, found the string, decoded none of it, and concluded the
    // pixels would have to be recognised.
    assert.equal(hasTextLayer(ONE_BYTE), true);
  });
});

describe('a font whose codes are two bytes wide', () => {
  it('is still read, because that is what the reader was built against', () => {
    assert.equal(readPdfText(TWO_BYTES).text, 'Row');
  });
});

describe('the width is taken from the CMap and not from the string', () => {
  it('so the same bytes read differently under the two declarations', () => {
    // The point of the whole fix in one assertion: identical hex, and what it
    // says depends on what the font declared. A reader that decides for itself
    // gets one of these two wrong, always.
    const asOne = pdfWith({
      codespace: '00',
      chars: [['01', '0041'], ['02', '0042']],
      shown: '0102',
    });
    const asTwo = pdfWith({
      codespace: '0000',
      chars: [['0102', '005A']],
      shown: '0102',
    });

    assert.equal(readPdfText(asOne).text, 'AB');
    assert.equal(readPdfText(asTwo).text, 'Z');
  });

  it('and a CMap that declares nothing is read as two, which is where this started', () => {
    const silent = pdfWith({ codespace: '0000', chars: [['0001', '0058']], shown: '0001' });
    const withoutRange = Buffer.from(
      silent.toString('latin1').replace(/1 begincodespacerange[\s\S]*?endcodespacerange\n/, ''),
      'latin1'
    );

    assert.equal(readPdfText(withoutRange).text, 'X');
  });
});
