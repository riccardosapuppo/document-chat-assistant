import assert from 'node:assert/strict';
import { once } from 'node:events';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { api } from '../src/http/api.js';
import { readFolder } from '../src/index/build.js';
import { corpus } from '../src/index/corpus.js';
import { provider } from '../src/index/embed.js';
import { readPdfText } from '../src/text/pdf-text.js';

/*
 * From here to the end of the first `describe`, this is document-ocr-service's
 * test/pages.test.js at commit 60c706b, unedited: the reader, a page at a time.
 * The rest of that file is about what that service then does with a page the
 * reader sets aside, which is not what this repository does, and in its place
 * is this repository's own.
 */

/**
 * A document read a page at a time.
 *
 * Whether to read the text layer or recognise pixels used to be decided once,
 * for the whole file. A PDF whose first page carries its text and whose second
 * is a scan came back as its first page, with a `why` that said both had been
 * read, and nothing anywhere to say the second had given nothing.
 *
 * The documents are built here rather than added to `samples/`: every sample
 * there was printed by a browser, and no browser prints a scan.
 */

/** A page of words, in a font with no surprises in it. */
const text = (words) => `BT /F1 12 Tf 72 720 Td (${words}) Tj ET`;

/** A page that is a picture and nothing else, which is what a scan is. */
const SCAN = 'q 612 0 0 792 0 0 cm /Im1 Do Q';

/** A page with nothing on it but the clip every browser starts a page with. */
const BLANK = 'q 0 0 612 792 re W n Q';

/** Word's empty page: two spaces, in a font. Text that can be read, and no ink. */
const SPACES = 'BT /F1 12 Tf 72 720 Td [( )] TJ 144 0 Td [( )] TJ ET';

const stream = (content, dict = '') => `<< ${dict}/Length ${content.length} >>\nstream\n${content}\nendstream`;

/**
 * The smallest PDF with these pages, in this order.
 *
 * @param {(string | {content: string, dict: string})[]} pages each a content
 *   stream, or one with something to say in its dictionary
 * @param {{backwards?: boolean}} options `backwards` writes the objects into the
 *   file last first, so the order they sit in is not the order of the pages
 */
function pdfOf(pages, { backwards = false } = {}) {
  const objects = new Map([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'],
    [4, stream('\x80', '/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 ')],
  ]);

  const ids = pages.map((_, at) => 5 + at * 2);
  objects.set(2, `<< /Type /Pages /Kids [${ids.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`);

  pages.forEach((page, at) => {
    const { content, dict = '' } = typeof page === 'string' ? { content: page } : page;
    objects.set(
      ids[at],
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
        `/Resources << /Font << /F1 3 0 R >> /XObject << /Im1 4 0 R >> >> /Contents ${ids[at] + 1} 0 R >>`
    );
    objects.set(ids[at] + 1, stream(content, dict));
  });

  const order = [...objects.keys()].sort((a, b) => (backwards ? b - a : a - b));

  let out = '%PDF-1.4\n';
  for (const id of order) out += `${id} 0 obj\n${objects.get(id)}\nendobj\n`;
  out += 'trailer\n<< /Root 1 0 R >>\n%%EOF';

  return Buffer.from(out, 'latin1');
}

describe('a document, read a page at a time', () => {
  it('reads every page from its text layer when every page has one', () => {
    const read = readPdfText(pdfOf([text('The first page'), text('The second page')]));

    assert.equal(read.text, 'The first page\n\nThe second page');
    assert.deepEqual(read.unread, []);
    assert.equal(read.why, 'read from the text layer of 2 pages');
  });

  it('sets aside a page that is only a picture, and does not count it as read', () => {
    const read = readPdfText(pdfOf([text('The first page'), SCAN]));

    assert.equal(read.text, 'The first page');
    assert.deepEqual(read.unread.map((one) => one.page), [2]);
    assert.match(read.unread[0].why, /no text layer/);

    // What this used to say, about a document it had read half of.
    assert.doesNotMatch(read.why, /2 pages/);
    assert.match(read.why, /^read from the text layer of page 1 of 2; page 2 has no text layer/);
  });

  it('reads a blank page as blank, and so the one Word writes, which is two spaces', () => {
    // Setting these aside would send a blank page to be paid for, or refuse a
    // document for want of a key because it ends with an empty page.
    const read = readPdfText(pdfOf([text('Before'), BLANK, SPACES, text('After')]));

    assert.deepEqual(read.unread, []);
    assert.equal(read.text, 'Before\n\nAfter');
    assert.match(read.why, /pages 2 and 3 are blank/);
  });

  it('takes the order of the pages from the page tree, not from where they sit in the file', () => {
    // Page 2 is sent to be recognised by its number. If the two sides count
    // differently, the wrong page is read and the right one never is.
    const read = readPdfText(pdfOf([text('One'), SCAN], { backwards: true }));

    assert.deepEqual(read.pages, ['One', '']);
    assert.deepEqual(read.unread.map((one) => one.page), [2]);
  });

  it('sets aside a page it cannot decompress, rather than taking it for blank', () => {
    const read = readPdfText(pdfOf([text('One'), { content: 'not what LZW looks like', dict: '/Filter /LZWDecode ' }]));

    assert.deepEqual(read.unread, [{ page: 2, why: 'content this reader cannot decode' }]);
  });
});

/**
 * What the chat does with a page the reader sets aside.
 *
 * The service the reader comes from sends such a page to an engine that reads
 * pixels, and refuses the document when it has no key for one. Nothing here
 * reads pixels and no key would change that, so the document is indexed from
 * the pages that carry their text, and the others are named with the reason
 * wherever the document is. A PDF with no page that can be read is refused.
 * The argument for that is at the top of src/index/corpus.js.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const samples = readFolder(path.join(root, 'samples'));

/** The three invented manuals, over the local index, which needs nothing. */
const theChat = (log) => corpus({ samples, provider: provider({ name: 'local' }), log });

/** ABCDE in Arial, glyphs 36 to 40, in a CID font with no map: `$%&'(` if read as characters. */
const GLYPHS = 'BT /F2 12 Tf 72 720 Td <00240025002600270028> Tj ET';

/** Pages that may use Helvetica, as /F1, and a CID font with no ToUnicode map, as /F2. */
function pdfInTwoFonts(pages) {
  const ids = pages.map((_, at) => 6 + at * 2);

  const objects = new Map([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, `<< /Type /Pages /Kids [${ids.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`],
    [3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'],
    [4, '<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+Arial /Encoding /Identity-H /DescendantFonts [5 0 R] >>'],
    [
      5,
      '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ABCDEF+Arial ' +
        '/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> >>',
    ],
  ]);

  pages.forEach((content, at) => {
    objects.set(
      ids[at],
      `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${ids[at] + 1} 0 R >>`
    );
    objects.set(ids[at] + 1, stream(content));
  });

  let out = '%PDF-1.4\n';
  for (const [id, body] of objects) out += `${id} 0 obj\n${body}\nendobj\n`;

  return Buffer.from(`${out}trailer\n<< /Root 1 0 R >>\n%%EOF`, 'latin1');
}

/** Everything the index holds from one document, as one string. */
const indexedFrom = (chat, name) =>
  chat.index.chunks
    .filter((one) => one.document === name)
    .map((one) => one.text)
    .join('\n');

describe('and what the chat does with a page it cannot read', () => {
  it('indexes the pages that carry their text, and names the one it left out, with the reason', async () => {
    const chat = await theChat();
    const said = await chat.add({ name: 'boiler.pdf', bytes: pdfOf([text('Descaling the boiler takes an hour'), SCAN]) });

    assert.equal(said.ok, true, said.why);
    assert.equal(said.pages, 2);
    assert.deepEqual(said.unread.map((one) => one.page), [2]);
    assert.match(said.unread[0].why, /no text layer/);

    // The sentence on the screen, which says what leaving the page out costs.
    assert.match(said.notRead, /^Page 2 was not read: it has no text layer/);
    assert.match(said.notRead, /a question about what it says will be answered from somewhere else\.$/);

    assert.match(indexedFrom(chat, 'boiler'), /Descaling the boiler takes an hour/);
  });

  it('does not index a page in a font nothing explains, even beside a page it reads', async () => {
    // What the copy of the reader this replaced put in the index: the glyph
    // numbers, read as letters, and returned as a passage.
    const chat = await theChat();
    const said = await chat.add({ name: 'kettle.pdf', bytes: pdfInTwoFonts([text('Descaling the kettle'), GLYPHS]) });

    assert.equal(said.ok, true, said.why);
    assert.deepEqual(said.unread.map((one) => one.page), [2]);
    assert.match(said.notRead, /\/F2: a CID font, Identity-H, with no ToUnicode map/);

    assert.match(indexedFrom(chat, 'kettle'), /Descaling the kettle/);
    assert.doesNotMatch(indexedFrom(chat, 'kettle'), /\$%&'\(/);
  });

  it('refuses a PDF with no page it can read, naming the page and why, and adds nothing', async () => {
    const chat = await theChat();
    const said = await chat.add({ name: 'scanned.pdf', bytes: pdfOf([SCAN]) });

    assert.equal(said.ok, false);
    assert.match(said.why, /^"scanned" has no page this can read: page 1 has no text layer/);
    assert.deepEqual(said.unread.map((one) => one.page), [1]);
    assert.equal(chat.index.documents.length, samples.length);
  });

  it('and says why in the reader\'s words, which are not always "a scan"', async () => {
    // Every refusal of a PDF used to call it a scan or a photograph. A PDF in a
    // font nothing explains has text on every page, and none of it readable.
    const chat = await theChat();
    const said = await chat.add({ name: 'glyphs.pdf', bytes: pdfInTwoFonts([GLYPHS]) });

    assert.equal(said.ok, false);
    assert.match(said.why, /page 1 has text in a font whose codes cannot be turned into characters/);
    assert.doesNotMatch(said.why, /photograph/);
  });

  it('goes on naming the page it left out for as long as the document is there', async () => {
    const chat = await theChat();
    await chat.add({ name: 'boiler.pdf', bytes: pdfOf([text('Descaling the boiler takes an hour'), SCAN]) });
    await chat.add({ name: 'kettle.md', text: '# Kettle\n\nIt holds 1.7 litres.' });

    const listed = (name) => chat.documents.find((one) => one.name === name);

    assert.match(listed('boiler').notRead, /^Page 2 was not read/);
    assert.deepEqual(listed('boiler').unread.map((one) => one.page), [2]);
    assert.equal(listed('kettle').notRead, null);
    assert.equal(listed('halden-fault-codes').notRead, null);

    await chat.remove('boiler');
    assert.equal(listed('boiler'), undefined);
  });

  it('and the service says so in the answer to the upload, in the list, and in the log', async () => {
    const logged = [];
    const chat = await theChat((level, message, detail) => logged.push({ level, message, ...detail }));

    const server = api({ corpus: chat }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const at = `http://127.0.0.1:${server.address().port}`;

    const upload = (name, bytes) =>
      fetch(`${at}/api/documents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, base64: bytes.toString('base64') }),
        signal: AbortSignal.timeout(5_000),
      });

    try {
      const added = await upload('boiler.pdf', pdfOf([text('Descaling the boiler takes an hour'), SCAN]));
      const said = await added.json();

      assert.equal(added.status, 200);
      assert.equal(said.pages, 2);
      assert.deepEqual(said.unread.map((one) => one.page), [2]);
      assert.match(said.notRead, /^Page 2 was not read/);

      const listed = await (await fetch(`${at}/api/documents`)).json();
      assert.match(listed.documents.find((one) => one.name === 'boiler').notRead, /^Page 2 was not read/);

      const refused = await upload('scanned.pdf', pdfOf([SCAN]));
      assert.equal(refused.status, 422);
      assert.deepEqual((await refused.json()).unread.map((one) => one.page), [1]);

      const warned = logged.find((one) => one.level === 'warn' && one.name === 'boiler');
      assert.deepEqual(warned?.unread.map((one) => one.page), [2], 'the log does not say which page was left out');
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
