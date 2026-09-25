/**
 * The reader's own tests, from the project it is copied from.
 *
 * Every test here is in document-ocr-service's test/pdf-text.test.js at commit
 * 7c7f968, unedited but for the path it imports from, so that one added there
 * can be added here the same way. Left out: the ones that read that project's
 * sample PDFs, which are not in this repository, and the four about how wide a
 * code is, which test/pdf.test.js has had since this repository found that
 * defect for itself. The per-page ones are in test/pages.test.js.
 */

import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { describe, it } from 'node:test';

import { readPdfText } from '../src/text/pdf-text.js';

describe('when there is nothing to read', () => {
  it('declines an empty buffer', () => {
    const { text, why } = readPdfText(Buffer.alloc(0));

    assert.equal(text, '');
    assert.equal(why, 'this is not a PDF');
  });

  it('declines a PDF header with nothing behind it', () => {
    const { text, why } = readPdfText(Buffer.from('%PDF-1.7\n%%EOF\n'));

    assert.equal(text, '');
    assert.match(why, /no objects|no pages/);
  });

  it('does not throw on bytes that are not a document at all', () => {
    const noise = Buffer.from(Array.from({ length: 2048 }, (_, at) => (at * 37) % 256));

    assert.doesNotThrow(() => readPdfText(noise));
  });
});

/**
 * The smallest PDF that carries a text layer: one page, one font, one CMap.
 *
 * @param {{codespace: string, chars?: [string, string][], ranges?: string[], shown: string}} what
 *   `codespace` is the low bound of the code space range, and its LENGTH is
 *   what declares the width. `chars` map codes to characters, and `ranges` are
 *   `bfrange` lines written out as a producer writes them. `shown` is the hex
 *   string the page draws.
 */
function pdfWith({ codespace, chars = [], ranges = [], shown }) {
  const cmap = [
    '/CIDInit /ProcSet findresource begin 12 dict begin begincmap',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    `1 begincodespacerange\n<${codespace}> <${'F'.repeat(codespace.length)}>\nendcodespacerange`,
    ...(chars.length > 0
      ? [`${chars.length} beginbfchar`, ...chars.map(([code, unicode]) => `<${code}> <${unicode}>`), 'endbfchar']
      : []),
    ...(ranges.length > 0 ? [`${ranges.length} beginbfrange`, ...ranges, 'endbfrange'] : []),
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

/**
 * The other way of writing a range, which is the way Word writes it.
 *
 * `<lo> <hi> <base>` maps a run of codes onto a run of characters. When glyphs
 * sit side by side in a font and mean characters that do not, the producer
 * writes `<lo> <hi> [<a> <b>]` instead, one character each. Calibri's e and è
 * are such a pair, so a Word export read by a reader that knows one form comes
 * back without a single e in it: "Invoic 2026-0999 — Harbour Mdical Supplis
 * Ltd", counted as read. The map below is the one Word wrote for that line,
 * cut down to the letters of one word.
 */
describe('the array form of a range, which Word writes', () => {
  it('is read, rather than every letter it covers being dropped', () => {
    const invoice = pdfWith({
      codespace: '0000',
      chars: [
        ['002F', '0049'],
        ['015D', '0069'],
        ['017D', '006F'],
        ['01C0', '0076'],
      ],
      ranges: ['<010F> <0110> <0062>', '<011E> <011F> [<0065> <00E8>]', '<0175> <0176> <006D>'],
      shown: '002F017601C0017D015D0110011E',
    });

    assert.equal(readPdfText(invoice).text, 'Invoice');
  });

  it('and three characters in an array are not taken for a range of their own', () => {
    // Read as runs of three strings, `[<0041> <0042> <0043>]` looked like
    // "codes 41 to 42 are C onwards", and code 41 became C.
    const read = readPdfText(
      pdfWith({
        codespace: '0000',
        chars: [['0041', '005A']],
        ranges: ['<0010> <0012> [<0041> <0042> <0043>]'],
        shown: '0010001100120041',
      })
    );

    assert.equal(read.text, 'ABCZ');
  });

  it('and a range past the first plane counts up its last unit, instead of throwing', () => {
    // A mathematical capital A is two UTF-16 units. Adding one to the pair as a
    // single number is not a code point, and the reader threw: a 500, for a
    // valid PDF with an equation in it.
    const maths = pdfWith({ codespace: '0000', ranges: ['<0001> <0002> <D835DC00>'], shown: '00010002' });

    assert.equal(readPdfText(maths).text, '\u{1D400}\u{1D401}');
  });
});

/**
 * A text layer that is there and cannot be trusted.
 *
 * The README said a CID font with no ToUnicode map returns "no text layer
 * here". It did not: the glyph numbers were read as character codes, `<0024>`
 * came out as `$`, and a page of dollar signs and brackets came back "read from
 * the text layer of 1 page". The same shortcut was taken wherever a code could
 * not be turned into a character, so each of those is here, next to the cases
 * that must go on being read.
 */

/**
 * One page, showing `shown` in the font `font` (object 5), with any objects it
 * refers to numbered from 6.
 */
function pdfInFont(font, shown, { content = `BT /F1 12 Tf 72 720 Td ${shown} Tj ET`, more = [], trailer = '' } = {}) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    font,
    ...more,
  ];

  let out = '%PDF-1.4\n';
  objects.forEach((body, at) => {
    out += `${at + 1} 0 obj\n${body}\nendobj\n`;
  });

  return Buffer.from(`${out}trailer\n<< /Root 1 0 R ${trailer}>>\n%%EOF`, 'latin1');
}

const cidFont = (encoding, toUnicode = '') =>
  '<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+Arial ' +
  `/Encoding /${encoding} /DescendantFonts [6 0 R] ${toUnicode}>>`;

const HELVETICA = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

const DESCENDANT =
  '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ABCDEF+Arial ' +
  '/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> >>';

const cmapOf = (lines) => {
  const body = [
    '/CIDInit /ProcSet findresource begin 12 dict begin begincmap',
    '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange',
    ...lines,
    'endcmap end end',
  ].join('\n');
  return `<< /Length ${body.length} >>\nstream\n${body}\nendstream`;
};

describe('a text layer that cannot be trusted', () => {
  it('sets aside a CID font with no map, rather than reading its glyph numbers as letters', () => {
    // ABCDE in Arial is glyphs 36 to 40. Read as characters they are $%&'(.
    for (const encoding of ['Identity-H', 'Identity-V']) {
      const read = readPdfText(pdfInFont(cidFont(encoding), '<00240025002600270028>', { more: [DESCENDANT] }));

      assert.equal(read.text, '', `${encoding} gave ${JSON.stringify(read.text)}`);
      assert.deepEqual(read.unread.map((one) => one.page), [1]);
      assert.match(read.why, new RegExp(`a CID font, ${encoding}, with no ToUnicode map`));
    }
  });

  it('and so a Type3 font with no map, whose codes name drawings', () => {
    const type3 =
      '<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1 1] /FontMatrix [0.001 0 0 0.001 0 0] ' +
      '/CharProcs << >> /Encoding << /Differences [1 /g1 /g2] >> /FirstChar 1 /LastChar 2 /Widths [500 500] >>';

    const read = readPdfText(pdfInFont(type3, '(\\001\\002)'));

    assert.equal(read.text, '');
    assert.match(read.why, /a Type3 font with no ToUnicode map/);
  });

  it('but reads a CID font whose encoding is Unicode, which needs no map', () => {
    // UniGB-UCS2-H says the codes are UTF-16. Setting it aside would send a
    // readable page to be paid for.
    const read = readPdfText(pdfInFont(cidFont('UniGB-UCS2-H'), '<4E2D6587>', { more: [DESCENDANT] }));

    assert.equal(read.text, '中文');
    assert.deepEqual(read.unread, []);
  });

  it('sets aside a page that shows a code its map leaves out, rather than dropping the code', () => {
    const read = readPdfText(pdfWith({ codespace: '0000', chars: [['0001', '0041']], shown: '00010002' }));

    assert.equal(read.text, '');
    assert.match(read.why, /its ToUnicode map leaves out codes the page shows/);
  });

  it('finds a font defined on the page tree, and sets aside one defined nowhere', () => {
    const onTheTree = '/Resources << /Font << /F1 5 0 R >> >>';
    const inherited = Buffer.from(
      pdfInFont(HELVETICA, '(Inherited)')
        .toString('latin1')
        .replace(`${onTheTree} /Contents`, '/Contents')
        .replace('/Kids [3 0 R] /Count 1', `/Kids [3 0 R] /Count 1 ${onTheTree}`),
      'latin1'
    );
    assert.equal(readPdfText(inherited).text, 'Inherited');

    const nowhere = pdfInFont(HELVETICA, '', { content: 'BT /F2 12 Tf 72 720 Td (Nobody said) Tj ET' });
    assert.match(readPdfText(nowhere).why, /\/F2: the page does not define it/);
  });

  it('reads a hex string in a simple font one byte to a code', () => {
    // Two bytes at a time, Hello in Helvetica came out as 䡥汬.
    const winAnsi = HELVETICA.replace(' >>', ' /Encoding /WinAnsiEncoding >>');

    assert.equal(readPdfText(pdfInFont(winAnsi, '<48656C6C6F>')).text, 'Hello');
  });

  it('reads a literal string in a CID font two bytes to a code, as it reads a hex one', () => {
    const map = cmapOf(['1 beginbfchar', '<0124> <0041>', 'endbfchar']);
    const font = cidFont('Identity-H', '/ToUnicode 7 0 R ');

    assert.equal(readPdfText(pdfInFont(font, '(\\001$)', { more: [DESCENDANT, map] })).text, 'A');
  });

  it('sets aside a page that shows text in a way this does not parse, rather than read the rest of it', () => {
    // `"` sets the spacing and shows a string. Unparsed, "and not this" would
    // have gone missing from a page that still came back as read.
    const content = 'BT /F1 12 Tf 72 720 Td (Read) Tj 0 0 (and not this) " ET';
    const read = readPdfText(pdfInFont(HELVETICA, '', { content }));

    assert.equal(read.text, '');
    assert.match(read.why, /text shown in a way this reader does not parse/);
  });

  it('declines an encrypted file as encrypted, not as a scan', () => {
    const locked = pdfInFont(HELVETICA, '(Hello)', {
      more: ['<< /Filter /Standard /V 1 /R 2 /O <00> /U <00> /P -4 >>'],
      trailer: '/Encrypt 6 0 R ',
    });

    const read = readPdfText(locked);

    assert.equal(read.text, '');
    assert.equal(read.why, 'it is encrypted, and this reader does not decrypt');
  });

  it('and in a document of several pages, it is that page and only that page that goes on', () => {
    const one = 'BT /F1 12 Tf 72 720 Td (Typed) Tj ET';
    const two = 'BT /F2 12 Tf 72 720 Td <00240025> Tj ET';
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 7 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F2 8 0 R >> >> /Contents 6 0 R >>',
      `<< /Length ${one.length} >>\nstream\n${one}\nendstream`,
      `<< /Length ${two.length} >>\nstream\n${two}\nendstream`,
      HELVETICA,
      '<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+Arial /Encoding /Identity-H /DescendantFonts [9 0 R] >>',
      DESCENDANT,
    ];
    let out = '%PDF-1.4\n';
    objects.forEach((body, at) => {
      out += `${at + 1} 0 obj\n${body}\nendobj\n`;
    });

    const read = readPdfText(Buffer.from(`${out}trailer\n<< /Root 1 0 R >>\n%%EOF`, 'latin1'));

    assert.equal(read.text, 'Typed');
    assert.deepEqual(read.unread.map((one) => one.page), [2]);
  });
});

/**
 * Files built to be slow, or to break it.
 *
 * This service has one thread, so a request that takes a minute takes it from
 * everybody. Each case below is a pattern the per-page reading added that read
 * to the end of its input from every place it might start: fine on a real file
 * and quadratic on one made for the purpose. The bounds are about a hundred
 * times what the fixed code takes, and a fraction of what the old took on the
 * same input, so a slow machine does not make them fail and a regression does.
 */
describe('a file built to be slow, or to break the reader', () => {
  const quickly = (build) => {
    const bytes = build();
    const started = performance.now();
    const read = readPdfText(bytes);
    return { read, ms: performance.now() - started };
  };

  it('reads a stream of inline pictures that never end in one pass, not once per picture', () => {
    // Before: 47 KB of these took 634 ms, and four times as long per doubling.
    const { read, ms } = quickly(() => pdfInFont(HELVETICA, '', { content: ' BI'.repeat(60_000) }));

    assert.ok(ms < 1500, `took ${Math.round(ms)} ms`);
    assert.match(read.why, /no text layer/);
  });

  it('reads a map full of arrays that are never closed in one pass', () => {
    // Before: ten seconds for this one.
    const { read, ms } = quickly(() =>
      pdfWith({ codespace: '0000', ranges: ['<0001> <0002> ['.repeat(20_000)], shown: '0001' })
    );

    assert.ok(ms < 1500, `took ${Math.round(ms)} ms`);
    assert.equal(read.text, '');
  });

  it('reads a content stream of unclosed literal strings in one pass, not once per string', () => {
    // The tokenizer coupled `(…)Tj`, so it looked for the close of a string —
    // and then the operator — from every `(`. A stream that is all open
    // parentheses sent that search to the end each time: 31 KB took 4.7 s
    // before the per-page reading, and about 18 s after it, on this machine.
    // 120 KB of them would be minutes. It is one forward pass now.
    const { read, ms } = quickly(() => pdfInFont(HELVETICA, '', { content: '('.repeat(120_000) }));

    assert.ok(ms < 1500, `took ${Math.round(ms)} ms`);
    assert.equal(read.text, '');
  });

  it('reads a content stream of unclosed array brackets in one pass', () => {
    // The same defect in the `[…]TJ` pattern: about 8 s for 40 KB of `[`.
    const { read, ms } = quickly(() => pdfInFont(HELVETICA, '', { content: '['.repeat(120_000) }));

    assert.ok(ms < 1500, `took ${Math.round(ms)} ms`);
    assert.equal(read.text, '');
  });

  it('does not stall on a content stream of deeply nested arrays', () => {
    // Balanced this time, and just as bad before: every `[` began a scan for a
    // `]…TJ` that was thousands of characters away. 8.5 s for 40 KB.
    const { read, ms } = quickly(() =>
      pdfInFont(HELVETICA, '', { content: '['.repeat(60_000) + ']'.repeat(60_000) })
    );

    assert.ok(ms < 1500, `took ${Math.round(ms)} ms`);
    assert.equal(read.text, '');
  });

  it('reads a ToUnicode map whose bfchar and bfrange blocks never close in one pass', () => {
    // `beginbfchar([\\s\\S]*?)endbfchar` looked for the end from every start, so
    // a map full of `beginbfchar` with no `endbfchar` read to the end of the
    // stream from each of them: quadratic, ~80 ms for 40 KB and four times that
    // per doubling. Found by two forward searches now.
    for (const opener of ['beginbfchar', 'beginbfrange']) {
      const withMap = HELVETICA.replace(' >>', ' /ToUnicode 6 0 R >>');
      const { read, ms } = quickly(() =>
        pdfInFont(withMap, '<0001>', { more: [cmapOf([`${opener} `.repeat(30_000)])] })
      );

      assert.ok(ms < 1500, `${opener} took ${Math.round(ms)} ms`);
      assert.match(read.why, /codes cannot be turned into characters/);
    }
  });

  it('does not throw on a page tree with more kids than a call can take as arguments', () => {
    const kids = Array.from({ length: 300_000 }, (_, at) => `${at + 10} 0 R`).join(' ');
    const tree = Buffer.from(
      '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
        `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count 300000 >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF`,
      'latin1'
    );

    assert.doesNotThrow(() => readPdfText(tree));
  });
});

/**
 * Streams built to inflate far past anything this could use.
 *
 * A FlateDecode stream says nothing about how large it becomes, and a few
 * kilobytes of one byte repeated inflate to gigabytes. This reader used to
 * inflate whatever it was given and measure afterwards, so one small upload
 * built that way was the whole process's memory and, on the one thread it has,
 * the whole process's time. Now it stops decompressing at a ceiling — one per
 * stream, one for the document — while the bytes are being produced, and a
 * stream that reaches it is set aside as one it cannot decode, the same answer
 * a stream in a filter this does not undo already gets.
 *
 * The fixtures are built here: `Buffer.alloc` gives the flat input for free,
 * `deflateSync` makes it tiny, and the compressed bytes ride inside the PDF as
 * latin1, which is a byte-for-byte round trip.
 */
describe('a stream built to inflate past the ceiling', () => {
  /** A one-byte-per-code deflate of `size` bytes, as a latin1 string to embed. */
  const bomb = (size) => zlib.deflateSync(Buffer.alloc(size, 0x20)).toString('latin1');

  /** A PDF whose pages each carry one FlateDecode content stream from `deflated`. */
  function pdfOfDeflatedPages(deflated) {
    const pageId = (at) => 3 + at * 2;
    const fontId = 3 + deflated.length * 2;

    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      `<< /Type /Pages /Kids [${deflated.map((_, at) => `${pageId(at)} 0 R`).join(' ')}] /Count ${deflated.length} >>`,
    ];

    deflated.forEach((bytes, at) => {
      objects[pageId(at) - 1] =
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${pageId(at) + 1} 0 R >>`;
      objects[pageId(at)] = `<< /Filter /FlateDecode /Length ${bytes.length} >>\nstream\n${bytes}\nendstream`;
    });
    objects[fontId - 1] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

    let out = '%PDF-1.4\n';
    objects.forEach((body, at) => {
      out += `${at + 1} 0 obj\n${body}\nendobj\n`;
    });
    return Buffer.from(`${out}trailer\n<< /Root 1 0 R >>\n%%EOF`, 'latin1');
  }

  it('sets a page aside rather than inflating a 64 MB bomb from 64 KB of stream', () => {
    // 64 MB is past the 32 MB a single stream is allowed, so zlib is stopped in
    // the middle. Refused, not inflated and then judged, and nowhere near a
    // crash or a hang: the whole read is milliseconds.
    const one = bomb(64 * 1024 * 1024);
    assert.ok(one.length < 200 * 1024, `the compressed stream is ${(one.length / 1024).toFixed(0)} KB`);

    const started = performance.now();
    const read = readPdfText(pdfOfDeflatedPages([one]));
    const ms = performance.now() - started;

    assert.ok(ms < 2000, `took ${Math.round(ms)} ms`);
    assert.equal(read.text, '');
    assert.deepEqual(read.unread, [{ page: 1, why: 'content this reader cannot decode' }]);
  });

  it('stops at the document total when many streams each stay under the per-stream ceiling', () => {
    // Eight streams of 20 MB: each is well under the 32 MB a stream may reach,
    // so none is refused on its own, but together they pass the 128 MB the
    // whole document may inflate. The reader takes the pages it can and sets
    // the rest aside — which is the per-document ceiling doing its work, not
    // the per-stream one.
    const twentyMb = bomb(20 * 1024 * 1024);
    const read = readPdfText(pdfOfDeflatedPages(Array.from({ length: 8 }, () => twentyMb)));

    assert.ok(read.unread.length >= 1, 'the document total was never reached');
    assert.ok(read.unread.length < 8, 'every stream was refused, so this proves the per-stream limit, not the total');
    assert.ok(
      read.unread.every((one) => one.why === 'content this reader cannot decode'),
      JSON.stringify(read.unread)
    );
  });
});
