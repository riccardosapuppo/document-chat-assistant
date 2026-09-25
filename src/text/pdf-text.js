/*
 * Copied from document-ocr-service, src/ocr/pdf-text.js at commit 7c7f968.
 * Everything below this comment is that file, unedited, so the two can be
 * compared with diff and brought back into step by copying it again and
 * changing the commit here. The same goes for pages.js, which it imports.
 *
 * Its comments were written for that service, which sends a page this sets
 * aside to an engine that reads pixels. Nothing here reads pixels, and what
 * the chat does with such a page instead is decided in src/index/corpus.js.
 */

/**
 * Reading the text layer out of a PDF, by hand.
 *
 * This is the engine that runs first, and for most documents it is the only one
 * that needs to run at all. A PDF produced by a word processor, a browser, an
 * accounting package or a label printer already carries its text — recognising
 * it from the pixels instead is slower, costs money per page, and gives a worse
 * answer than the one already in the file. A service that sends everything to a
 * hosted model is paying to guess at something it was told.
 *
 * So: if the file has a text layer, take it. If it does not — a scan, a
 * photograph, a fax — say so plainly and let an engine that can read pixels have
 * it. Saying so is a result, not a failure.
 *
 * And it is said a page at a time. A contract typed in a word processor with
 * its signature page scanned onto the end has a text layer on every page but
 * the last, and a reader that answers for the document as a whole either sends
 * all of it to be recognised or quietly returns it without its last page. It
 * did the second, and said it had read both.
 *
 * Written against PDFs a real producer wrote, not ones this file also made. The
 * samples come out of a browser's print-to-PDF, which means subset fonts, glyph
 * codes that are not character codes, Flate-compressed streams and text placed
 * by matrix rather than by line. Every one of those is a thing a hand-rolled
 * reader gets wrong on the first attempt.
 *
 * What it does not do: decrypt, read a glyph that nothing in the file says the
 * meaning of, or see text drawn as vector outlines. An encrypted file returns
 * "no text layer here" as a whole, and a page with any of the others returns it
 * for that page, which goes to the other engine. That is the honest answer, and
 * for a while it was the answer only in this comment: a CID font with no
 * ToUnicode map was read anyway, and its glyph numbers came back as text.
 *
 * What it does not do and cannot tell: read text inside an embedded form or a
 * form field, or read a simple font with no map past ASCII the way its encoding
 * says. A page whose only content is a form is sent on, because it draws
 * something that is not text; one with text of its own is read from that.
 */

import zlib from 'node:zlib';

import { pageWords } from './pages.js';

/**
 * How far down the cursor must move before it is a new line, as a fraction of
 * the type size. A wrapped line moves a whole line-height; a superscript or a
 * baseline nudge moves a fraction of one.
 */
const A_NEW_LINE = 0.35;

/**
 * How wide a horizontal gap must be before it is a space, as a fraction of the
 * type size. Cells in a table row are separate runs at the same height; so are
 * the two halves of a sentence with a bold word in the middle, and those must
 * NOT gain a space that was never there.
 */
const A_SPACE = 0.18;

/**
 * A backwards kern wide enough to be a space, in thousandths of an em.
 *
 * `TJ` moves the cursor between glyphs to kern them, and some producers write a
 * space as a large negative move rather than as a space glyph. Under about 120
 * it is ordinary kerning, and treating that as a space puts a gap inside every
 * other word.
 */
const A_KERNED_SPACE = 120;

/**
 * How far one stream may inflate, and how far a whole document may, before this
 * stops decompressing.
 *
 * A FlateDecode stream says nothing about how large it becomes: a few kilobytes
 * of zeros inflate to gigabytes, and on a service with one thread one upload
 * built that way is everybody's memory and everybody's time. The only streams
 * this reader inflates are page content — the operators that place text — and
 * the ToUnicode maps; a real one of either is tens of kilobytes, and a page
 * that is one dense vector drawing is a few megabytes. So the per-stream ceiling
 * is set far above anything usable and far below anything ruinous, and the
 * per-document ceiling caps a file of many streams so no single upload can make
 * this process inflate more than a fraction of a gigabyte.
 *
 * They are enforced AS the bytes are produced — `maxOutputLength` stops zlib in
 * the middle rather than after — so a bomb is never fully built, not even once.
 * A stream that reaches its ceiling, or a document that reaches the total, is
 * treated exactly as one this reader cannot decode: the page is set aside with
 * a reason and goes to the engine that reads pixels, or into the refusal when
 * there is no key. Never a crash, a hang, or a 500.
 */
const A_STREAM_MAY_INFLATE_TO = 32 * 1024 * 1024;
const A_DOCUMENT_MAY_INFLATE_TO = 128 * 1024 * 1024;

/** Why a page with nothing to read, and something drawn on it, is set aside. */
const NO_LAYER = 'no text layer — a scan, or text drawn as shapes';

/** Why a page whose content cannot be decompressed is set aside. */
const UNDECODABLE = 'content this reader cannot decode';

/** Why a page that shows text in a way this does not parse is set aside. */
const UNPARSED = 'text shown in a way this reader does not parse';

/**
 * The operators that put something other than text on a page: filling or
 * stroking a shape, a shading, an image or a form, a picture written inline.
 * Clipping (`W n`) paints nothing, and every page Chrome prints begins with it.
 */
const PAINTS = /(?<![^\s\]>)])(?:f\*?|F|S|s|B\*?|b\*?|sh|Do|BI)(?![^\s[(<\/%])/;

/** The operators that show text, counted to be sure each one was read. */
const SHOWS = /(?<![^\s\]>)])(?:Tj|TJ|'|")(?![^\s[(<\/%])/g;

const PAGE = /\/Type\s*\/Page\b/;

export function hasTextLayer(bytes) {
  return readPdfText(bytes).text.trim().length > 0;
}

/**
 * @returns {{
 *   text: string,
 *   pages: string[],
 *   unread: {page: number, why: string}[],
 *   fonts: number,
 *   why: string,
 * }} `pages` has one entry per page, in the order the document gives them.
 *   `unread` lists the pages set aside, numbered from one: their entry in
 *   `pages` is empty, and they are for an engine that reads pixels. A blank
 *   page is not among them. It was read, and there was nothing on it.
 */
export function readPdfText(bytes) {
  if (!looksLikeAPdf(bytes)) return nothing('this is not a PDF');

  const raw = bytes.toString('latin1');

  // Asked, rather than found out. An encrypted file's streams are noise until
  // they are decrypted: compressed ones fail to inflate, and uncompressed ones
  // have no operators in them, which is what a blank page looks like. Both used
  // to come back as "a scan", which it was not.
  if (/\/Encrypt\s*(?:\d+\s+\d+\s+R|<<)/.test(raw)) return nothing('it is encrypted, and this reader does not decrypt');

  const objects = findObjects(raw, bytes);

  if (objects.size === 0) return nothing('no objects could be read out of it');

  // One budget for the whole document, spent as streams are inflated. See
  // A_DOCUMENT_MAY_INFLATE_TO. readPdfText runs start to finish with no `await`,
  // so this object belongs to exactly one document at a time.
  const budget = { perStream: A_STREAM_MAY_INFLATE_TO, remaining: A_DOCUMENT_MAY_INFLATE_TO };

  const readings = fontReadings(objects, budget);
  const fonts = [...readings.values()].filter((one) => one.chars).length;
  const widths = widthTables(objects);
  const { pages, ordered, whole } = pagesOf(objects, raw);

  if (pages.length === 0) return nothing('it has no pages this reader could find', fonts);

  if (!whole) {
    return nothing('its page tree names pages this reader could not find, so it cannot say which it missed', fonts);
  }

  const said = whatWasRead(
    pages.map((page) => readPage(page, objects, facesOf(page, objects, readings, widths, budget), budget))
  );

  // With no page tree, the pages are in the order the file holds them. That is
  // the order every producer this has met writes them in, and it is not a
  // promise: enough to read them in, not enough to send "page 2" to be
  // recognised and be sure that page 2 is the one that comes back.
  if (!ordered && said.text && said.unread.length > 0) {
    return nothing(`${said.why}; with no page tree to say which page is which, it goes on whole`, fonts);
  }

  return { ...said, fonts };
}

function nothing(why, fonts = 0) {
  return { text: '', pages: [], unread: [], fonts, why };
}

/**
 * One page: its text, or why it has none that can be used.
 *
 * A page's text layer is used only when every glyph on it could be read as a
 * character. One glyph that could not is enough to set the page aside, and it
 * has to be: the alternative is the page without that glyph's text, which is
 * the partial page this reader exists not to hand out. So is text shown by an
 * operator this does not parse, found by counting the operators against the
 * ones that were read.
 *
 * `why` is null for a page that was read, and a page can be read and empty. The
 * difference between that and a scan is whether anything is drawn on it, and
 * Word's empty page is the case that settles how to tell: it shows two spaces,
 * in a font, with a map. That is text a reader can read, and a page with
 * nothing on it; counting the operator rather than what it showed would send a
 * blank page to be recognised, or refuse the document for want of a key.
 */
function readPage(page, objects, faces, budget) {
  const content = contentOf(page, objects, budget);
  if (content === null) return { text: '', why: UNDECODABLE };

  const drawn = textIn(content, faces);
  if (drawn.missed > 0) {
    return { text: '', why: `text in a font whose codes cannot be turned into characters (${drawn.because})` };
  }

  const marks = withoutStrings(content);
  if ((marks.match(SHOWS) ?? []).length > drawn.shown) return { text: '', why: UNPARSED };

  const text = tidy(drawn.text);
  if (text) return { text, why: null };

  if (PAINTS.test(marks) || page.annotated) return { text: '', why: NO_LAYER };

  return { text: '', why: null };
}

/**
 * The fonts a page names, each with how to read it and how wide its glyphs are.
 *
 * A name the page gives to an object the file does not have, or not where this
 * reader looks for it (inside a compressed object stream), is a font nothing
 * is known about, and its codes are no more characters than a CID font's.
 */
function facesOf(page, objects, readings, widths, budget) {
  const faces = new Map();

  for (const [name, id] of page.fonts) {
    const entry = objects.get(id);
    const reading = readings.get(id) ?? (entry ? readingOf(entry, objects, budget) : NOT_FOUND);

    faces.set(name, { ...reading, name: `/${name}`, wide: widths.get(id) ?? null });
  }

  return faces;
}

const NOT_FOUND = {
  chars: null,
  bytes: 1,
  composite: false,
  unreadable: 'it is not in the file, or not where this reader looks',
};

/**
 * One page's text, tidied so that the pages joined are what tidying the whole
 * document used to give: the same answer for every file that was already read,
 * now that the pages are also handed out one by one.
 */
function tidy(text) {
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').trimEnd();
}

/**
 * The pages read, and a `why` that is true of every one of them.
 *
 * It used to count the pages the file had and say it had read that many,
 * whatever each of them gave. A document whose second page is a picture came
 * back as its first page, "read from the text layer of 2 pages".
 */
function whatWasRead(read) {
  const pages = read.map((one) => one.text);
  const unread = read.flatMap((one, at) => (one.why ? [{ page: at + 1, why: one.why }] : []));

  const numbers = (test) => read.flatMap((one, at) => (test(one) ? [at + 1] : []));
  const withText = numbers((one) => one.text);
  const blank = numbers((one) => !one.text && !one.why);

  const said = [];

  if (withText.length === read.length) {
    said.push(`read from the text layer of ${read.length} ${read.length === 1 ? 'page' : 'pages'}`);
  } else if (withText.length > 0) {
    said.push(`read from the text layer of ${pageWords(withText)} of ${read.length}`);
  }

  const byReason = new Map();
  for (const { page, why } of unread) byReason.set(why, [...(byReason.get(why) ?? []), page]);
  for (const [why, pages] of byReason) said.push(`${pageWords(pages)} ${pages.length === 1 ? 'has' : 'have'} ${why}`);

  if (blank.length > 0) said.push(`${pageWords(blank)} ${blank.length === 1 ? 'is' : 'are'} blank`);

  return { text: pages.filter(Boolean).join('\n\n').trim(), pages, unread, why: said.join('; ') };
}

function looksLikeAPdf(bytes) {
  // The header is allowed to be preceded by junk; readers are expected to find
  // it within the first kilobyte, and files served through some gateways do
  // arrive with a byte-order mark in front.
  return bytes.subarray(0, 1024).includes('%PDF-');
}

/**
 * Every `N G obj … endobj`, found by scanning.
 *
 * Not by following the cross-reference table, deliberately. A PDF that has been
 * signed or annotated has several xrefs chained together, a linearised one has
 * two, and a file that has been through an email gateway may have a broken one
 * — and a reader that insists on the index fails on documents every other
 * reader opens. Scanning costs one pass and copes with all of it.
 */
function findObjects(raw, bytes) {
  const objects = new Map();
  const heads = /(\d+)\s+(\d+)\s+obj\b/g;

  let head;
  while ((head = heads.exec(raw))) {
    const id = Number(head[1]);
    const from = head.index + head[0].length;
    const end = raw.indexOf('endobj', from);
    if (end === -1) continue;

    objects.set(id, { id, dict: raw.slice(from, end), from, bytes });
  }

  return objects;
}

/**
 * The bytes of an object's stream, decompressed if it is compressed, or null.
 *
 * Null for a filter this does not undo, where it used to hand the bytes back as
 * they were. A content stream in ASCII85 or LZW then read as a page with
 * nothing on it, and a reader that tells a blank page from a scan by what is
 * drawn on it would call that page blank and move on without it.
 */
function streamOf(entry, budget) {
  if (!entry) return null;

  const at = entry.dict.indexOf('stream');
  if (at === -1) return null;

  const filters = filtersOf(entry.dict.slice(0, at));
  if (filters.length > 1 || filters.some((one) => one !== 'FlateDecode')) return null;

  let from = entry.from + at + 'stream'.length;
  // The keyword is followed by CRLF or LF, and the newline is not data.
  if (entry.bytes[from] === 0x0d) from += 1;
  if (entry.bytes[from] === 0x0a) from += 1;

  const ends = entry.bytes.indexOf('endstream', from, 'latin1');
  if (ends === -1) return null;

  let out = entry.bytes.subarray(from, ends);

  if (filters.length === 1) {
    // Bounded by what is left of this document's budget, and never more than one
    // stream's worth. `maxOutputLength` makes zlib throw the moment the output
    // would pass the ceiling, so a stream built to inflate to gigabytes is
    // stopped in the middle and set aside, not decompressed and then measured.
    const ceiling = Math.max(0, Math.min(budget.perStream, budget.remaining));
    try {
      out = zlib.inflateSync(out, { maxOutputLength: ceiling });
    } catch {
      try {
        // Some producers omit the zlib header. Raw deflate is the same data.
        out = zlib.inflateRawSync(out, { maxOutputLength: ceiling });
      } catch {
        // A stream this cannot decode, whether the filter is unknown, the bytes
        // are corrupt, or it ran past the ceiling. All three are the same
        // answer to the page that holds it: content this reader cannot decode.
        return null;
      }
    }

    budget.remaining -= out.length;
  }

  return out;
}

/** The names in a stream's `/Filter`, which may be one name or an array of them. */
function filtersOf(head) {
  const named = head.match(/\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/);
  return named ? [...named[1].matchAll(/\/([A-Za-z0-9]+)/g)].map((one) => one[1]) : [];
}

/**
 * How each font's codes become characters, by font object id, or why they
 * cannot.
 *
 * This is the part that cannot be skipped. In a subset font — which is what
 * every browser and word processor emits — the codes in the content stream are
 * positions in that subset and have nothing to do with letters. `48` is not
 * `0`; it is whichever glyph happened to land there. The `/ToUnicode` map is
 * the producer telling you what each one means, and without it the text comes
 * out as convincing nonsense rather than as an error.
 *
 * It did. A CID font with Identity-H and no map was read anyway, its glyph
 * numbers taken for character codes: `<0024>` came out as `$`, and a page of
 * dollar signs and brackets came back "read from the text layer". So each font
 * now says which of three it is:
 *
 *   - it has a map, and each code is looked up in it. A code the map leaves
 *     out is counted, not quietly dropped.
 *   - it has none, and its codes are characters already: a simple font, read
 *     as the standard Latin encodings read it, or a CID font whose encoding is
 *     one of the Unicode CMaps, whose codes are UTF-16.
 *   - it has none, and its codes are not characters: every other CID font —
 *     Identity-H, Identity-V, the CJK encodings, a CMap of its own — and a
 *     Type3 font, whose codes name drawings. Nothing in the file says what
 *     those glyphs are, so nothing here pretends to.
 *
 * A page that shows a single code in the last way, or one its map leaves out,
 * is not read from its text layer at all. See `readPage`.
 */
function fontReadings(objects, budget) {
  const readings = new Map();

  for (const entry of objects.values()) {
    if (/\/Type\s*\/Font\b/.test(entry.dict)) readings.set(entry.id, readingOf(entry, objects, budget));
  }

  return readings;
}

/**
 * @returns {{chars: Map<number, string> | null, bytes: number, composite: boolean, unreadable: string | null}}
 *   the map, if there is one; how many bytes one code takes; whether it is a
 *   composite (CID) font; and, when its codes cannot be turned into
 *   characters, why not.
 */
function readingOf(entry, objects, budget) {
  const kind = entry.dict.match(/\/Subtype\s*\/([A-Za-z0-9]+)/)?.[1];
  const composite = kind === 'Type0';

  const ref = entry.dict.match(/\/ToUnicode\s+(\d+)\s+\d+\s+R/);
  if (ref) {
    const stream = streamOf(objects.get(Number(ref[1])), budget);
    if (!stream) {
      return { chars: null, bytes: composite ? 2 : 1, composite, unreadable: 'its ToUnicode map cannot be decoded' };
    }

    const map = readCMap(stream.toString('latin1'));
    return { chars: map.chars, bytes: map.bytes, composite, unreadable: null };
  }

  if (composite) {
    const encoding = entry.dict.match(/\/Encoding\s*\/([^\s/<>[\]()]+)/)?.[1];
    if (encoding && /^Uni.+-(?:UCS2|UTF16)-[HV]$/.test(encoding)) {
      return { chars: null, bytes: 2, composite, unreadable: null };
    }

    return {
      chars: null,
      bytes: 2,
      composite,
      unreadable: encoding
        ? `a CID font, ${encoding}, with no ToUnicode map`
        : 'a CID font with no ToUnicode map and an encoding of its own',
    };
  }

  if (kind === 'Type3') return { chars: null, bytes: 1, composite, unreadable: 'a Type3 font with no ToUnicode map' };

  // A simple font with no map. Its codes are read as the standard encodings
  // read them, which agree with each other and with Latin-1 for ASCII, and one
  // byte each: a hex string used to be read two bytes at a time here, and
  // `<48656C6C6F>`, which is Hello in Helvetica, came out as 䡥汬.
  return { chars: null, bytes: 1, composite, unreadable: null };
}

/**
 * How wide each glyph is, by font object id.
 *
 * Two formats, because there are two kinds of font in a PDF and a real document
 * has both. A simple font declares `/FirstChar` and a flat `/Widths` array. A
 * composite one — which is what a subset of Georgia or Arial is — puts a `/W`
 * array on its DESCENDANT font, in a shape that mixes two notations:
 *
 *     /W [ 3 [253.9]  16 [378.9 328.1 0 701.2]  36 45 758.3 ]
 *          ^ one code, a list      ^ a run of codes sharing one width
 *
 * Without these the spacing has to be guessed, and guessing is what put
 * "medium126.2074.40" in an invoice.
 */
function widthTables(objects) {
  const tables = new Map();

  for (const entry of objects.values()) {
    if (!/\/Type\s*\/Font\b/.test(entry.dict)) continue;

    const descendant = entry.dict.match(/\/DescendantFonts\s*\[\s*(\d+)\s+\d+\s+R/);
    const source = descendant ? (objects.get(Number(descendant[1]))?.dict ?? '') : entry.dict;

    const table = new Map();

    const w = balanced(source, '/W', '[', ']');
    if (w) readCidWidths(w, table);

    const simple = balanced(source, '/Widths', '[', ']');
    const first = source.match(/\/FirstChar\s+(\d+)/);
    if (simple && first) {
      const numbers = [...simple.matchAll(/-?[\d.]+/g)].map((one) => Number(one[0]));
      numbers.forEach((width, at) => table.set(Number(first[1]) + at, width));
    }

    if (table.size > 0) tables.set(entry.id, table);
  }

  return tables;
}

function readCidWidths(source, table) {
  const tokens = source.matchAll(/(\[[^\]]*\])|(-?[\d.]+)/g);
  const flat = [];

  for (const token of tokens) {
    if (token[1]) flat.push([...token[1].matchAll(/-?[\d.]+/g)].map((one) => Number(one[0])));
    else flat.push(Number(token[2]));
  }

  for (let at = 0; at < flat.length; ) {
    const start = flat[at];
    const next = flat[at + 1];

    if (Array.isArray(next)) {
      // `code [w w w]` — consecutive codes, one width each.
      next.forEach((width, step) => table.set(start + step, width));
      at += 2;
    } else if (typeof next === 'number' && typeof flat[at + 2] === 'number') {
      // `first last width` — a run of codes sharing one width.
      const width = flat[at + 2];
      for (let code = start; code <= next && code - start < 4096; code += 1) {
        table.set(code, width);
      }
      at += 3;
    } else {
      at += 1;
    }
  }
}

/** The text between a key's opening bracket and its matching close. */
function balanced(source, key, open, close) {
  const at = source.indexOf(key);
  if (at === -1) return null;

  const from = source.indexOf(open, at);
  if (from === -1) return null;

  let depth = 0;
  for (let scan = from; scan < source.length; scan += 1) {
    if (source[scan] === open) depth += 1;
    else if (source[scan] === close) {
      depth -= 1;
      if (depth === 0) return source.slice(from + 1, scan);
    }
  }

  return null;
}

/**
 * Each run between an opening keyword and the next closing one, found by
 * walking forward with two searches rather than by a lazy pattern.
 *
 * `beginbfchar([\s\S]*?)endbfchar` looks for the end from every start, so a map
 * full of `beginbfchar` with no `endbfchar` after them read to the end of the
 * source from each one: quadratic, and a few hundred kilobytes of them is
 * seconds on the one thread this service has. This finds the next opener, then
 * the next closer after it, yields what is between, and carries on past the
 * closer — every byte looked at once. An opener with no closer ends it, which
 * is what the old pattern did too: it simply found no match.
 */
function* blocksBetween(source, open, close) {
  let from = 0;

  for (;;) {
    const start = source.indexOf(open, from);
    if (start === -1) return;

    const end = source.indexOf(close, start + open.length);
    if (end === -1) return;

    yield source.slice(start + open.length, end);
    from = end + close.length;
  }
}

/**
 * @returns {{chars: Map<number, string>, bytes: number}} the mapping, and how
 *   many bytes one code takes in a string that uses it.
 */
function readCMap(source) {
  const map = new Map();

  for (const block of blocksBetween(source, 'beginbfchar', 'endbfchar')) {
    for (const pair of block.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      map.set(parseInt(pair[1], 16), fromUtf16Hex(pair[2]));
    }
  }

  for (const block of blocksBetween(source, 'beginbfrange', 'endbfrange')) {
    // Two forms, and Word writes both. `<lo> <hi> <base>` is a run of codes
    // mapping to a run of characters. `<lo> <hi> [<a> <b> …]` gives each code
    // its own, for glyphs that sit side by side in the font and mean characters
    // that do not: Calibri's e and è, in every export this was tried on. Only
    // the first form was read, so every e was dropped and the page still came
    // back as read, as "Invoic" and "Th customr’s ordr".
    //
    // One entry at a time, which is also what stops three strings inside an
    // array passing for a range of their own. The array is matched as what it
    // can hold, strings and the space between them, and not as anything up to
    // a `]`: that version read to the end of the block from every `[` that was
    // never closed, and 293 KB of them took ten seconds.
    const entries = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[((?:\s*<[0-9a-fA-F]*>)*)\s*\])/g;

    for (const run of block.matchAll(entries)) {
      const lo = parseInt(run[1], 16);
      const hi = parseInt(run[2], 16);

      if (run[4] !== undefined) {
        [...run[4].matchAll(/<([0-9a-fA-F]*)>/g)].forEach((one, step) => {
          if (lo + step <= hi) map.set(lo + step, fromUtf16Hex(one[1]));
        });
        continue;
      }

      // The base can be more than one UTF-16 unit: a ligature, or a character
      // past the first plane written as a surrogate pair. It is the last unit
      // that counts up. Adding to the whole number instead made a code point
      // that does not exist, and String.fromCodePoint threw, which the service
      // answered as a 500.
      const units = unitsOf(run[3]);

      // Bounded. A malformed range saying 0 to 0xFFFF would otherwise build a
      // map of sixty-five thousand entries out of one bad file.
      for (let code = lo; code <= hi && code - lo < 4096; code += 1) {
        map.set(code, String.fromCharCode(...units.slice(0, -1), units.at(-1) + (code - lo)));
      }
    }
  }

  return { chars: map, bytes: codeWidth(source) };
}

/** The UTF-16 units in a hex string; a short one is taken as a single unit. */
function unitsOf(hex) {
  if (hex.length <= 4) return [parseInt(hex, 16)];

  const units = [];
  for (let at = 0; at + 4 <= hex.length; at += 4) units.push(parseInt(hex.slice(at, at + 4), 16));
  return units;
}

/**
 * How many bytes one code takes, read rather than assumed.
 *
 * A CMap opens by declaring it: `<00> <FF>` is one byte per code, `<0000>
 * <FFFF>` is two. Assuming two, which an Identity-H CID font does use, reads
 * `<010203>` as one and a half codes of the wrong value: nothing matches the
 * map, every glyph comes back empty, and a document with a perfectly good text
 * layer is reported as a scan. Two remains the answer when a CMap does not say,
 * because that is the case this reader was built against.
 */
function codeWidth(source) {
  const range = source.match(/begincodespacerange([\s\S]*?)endcodespacerange/);
  const low = range?.[1].match(/<([0-9a-fA-F\s]+)>/);
  if (!low) return 2;

  const digits = low[1].replace(/\s+/g, '').length;
  return digits >= 2 ? Math.floor(digits / 2) : 2;
}

function fromUtf16Hex(hex) {
  let out = '';
  for (let at = 0; at + 4 <= hex.length; at += 4) {
    out += String.fromCharCode(parseInt(hex.slice(at, at + 4), 16));
  }
  return out;
}

/**
 * The pages, each with the font names its content stream will name.
 *
 * `ordered` says the order came from the page tree; `whole` that the tree named
 * no page this reader failed to find.
 */
function pagesOf(objects, raw) {
  const tree = pageTree(objects, raw);
  const leaves = tree ? tree.pages : [...objects.values()].filter((entry) => PAGE.test(entry.dict));

  return {
    pages: leaves.map((entry) => ({
      contents: contentRefs(entry.dict, objects),
      fonts: fontsFor(entry, objects),
      // Text in a form field or a stamp is drawn by an annotation, not by the
      // page, so an annotated page with nothing in its own content is not
      // known to be blank.
      annotated: /\/Annots\s*(?:\[\s*\d|\d+\s+\d+\s+R)/.test(entry.dict),
    })),
    ordered: tree !== null,
    whole: tree?.whole ?? true,
  };
}

/**
 * The pages in the order the document gives them, by walking its page tree.
 *
 * Not in the order the objects sit in the file, which is what this used to
 * take. The two agree for a file written from the top, and nothing makes them:
 * a page moved in an editor, or added by an incremental update, is written
 * wherever it was written, and a page deleted that way is still in the file,
 * unreferenced. While a document was read as one piece that went unnoticed.
 * Now a page with no text layer is sent to be recognised by its number, and a
 * number meaning a different page to each side reads the wrong one.
 *
 * `whole` is false when the tree names something this cannot find — a page it
 * has not seen, whose text would otherwise be missing with nobody told.
 */
function pageTree(objects, raw) {
  const top = catalogOf(objects, raw)?.dict.match(/\/Pages\s+(\d+)\s+\d+\s+R/);
  if (!top) return null;

  const pages = [];
  const seen = new Set();
  const pending = [Number(top[1])];
  let whole = true;

  while (pending.length > 0) {
    const id = pending.pop();
    const node = objects.get(id);

    // Seen twice is a loop, or a page listed twice, and neither is an order.
    if (!node || seen.has(id)) {
      whole = false;
      continue;
    }
    seen.add(id);

    const kids = PAGE.test(node.dict) ? null : balanced(node.dict, '/Kids', '[', ']');
    if (kids === null) {
      pages.push(node);
      continue;
    }

    // One at a time, last first so the first comes off the stack first. As
    // arguments to a single push, 300,000 of them overflowed the call stack,
    // and the service answered a 2.7 MB upload with a 500.
    const refs = refsIn(kids);
    for (let at = refs.length - 1; at >= 0; at -= 1) pending.push(refs[at]);
  }

  return pages.length > 0 ? { pages, whole } : null;
}

/**
 * The catalog, which is where the page tree starts.
 *
 * The trailer names it, and the last trailer in a file is its latest revision.
 * A file whose trailer cannot be read still has the object, and says what it is.
 */
function catalogOf(objects, raw) {
  const named = [...raw.matchAll(/\/Root\s+(\d+)\s+\d+\s+R/g)].at(-1);
  const root = named ? objects.get(Number(named[1])) : undefined;
  if (root && /\/Pages\s+\d+\s+\d+\s+R/.test(root.dict)) return root;

  return [...objects.values()].reverse().find((entry) => /\/Type\s*\/Catalog\b/.test(entry.dict)) ?? null;
}

/**
 * A page's content can be one stream or an array of them.
 *
 * The array form is how a producer appends to a page it has already written,
 * and reading only the first of them loses everything added afterwards. The
 * array can also sit in an object of its own, referred to like a stream.
 */
function contentRefs(dict, objects) {
  const one = dict.match(/\/Contents\s+(\d+)\s+\d+\s+R/);
  if (one) {
    const target = objects.get(Number(one[1]));
    return target && /^\s*\[/.test(target.dict) ? refsIn(target.dict) : [Number(one[1])];
  }

  const many = dict.match(/\/Contents\s*\[([^\]]*)\]/);
  return many ? refsIn(many[1]) : [];
}

function refsIn(source) {
  return [...source.matchAll(/(\d+)\s+\d+\s+R/g)].map((one) => Number(one[1]));
}

/**
 * The `/Font` sub-dictionary only.
 *
 * Reading every `/Name N 0 R` in the resources picks up `/XObject` images and
 * `/Parent` as though they were fonts. It happens to work when the names do not
 * collide and stops working on the first page that has a picture on it.
 */
function fontsFor(entry, objects) {
  const fonts = new Map();

  const resources = resourcesOf(entry, objects);
  if (!resources) return fonts;

  const fontDict = resolveDict(resources, /\/Font/, objects);
  if (!fontDict) return fonts;

  for (const found of fontDict.matchAll(/\/([A-Za-z0-9+.\-_]+)\s+(\d+)\s+\d+\s+R/g)) {
    fonts.set(found[1], Number(found[2]));
  }

  return fonts;
}

/**
 * A page's resources, which it may inherit from the page tree above it.
 *
 * A producer that uses the same fonts on every page can put them on the tree
 * once, and each page then names fonts it does not define itself. That used to
 * read as a page with no fonts, whose codes were taken for characters. A font
 * nobody defines now sets the page aside, so the tree has to be asked first.
 */
function resourcesOf(entry, objects) {
  const seen = new Set();

  for (let node = entry; node && !seen.has(node.id); ) {
    seen.add(node.id);

    const found = resolveDict(node.dict, /\/Resources/, objects);
    if (found) return found;

    const parent = node.dict.match(/\/Parent\s+(\d+)\s+\d+\s+R/);
    node = parent ? objects.get(Number(parent[1])) : null;
  }

  return null;
}

/** A dictionary that may be written inline or referred to by number. */
function resolveDict(dict, key, objects) {
  const source = dict.match(new RegExp(`${key.source}\\s+(\\d+)\\s+\\d+\\s+R`));
  if (source) return objects.get(Number(source[1]))?.dict ?? null;

  const at = dict.search(new RegExp(`${key.source}\\s*<<`));
  if (at === -1) return null;

  // Balanced `<< >>`, because a resources dictionary contains dictionaries.
  const from = dict.indexOf('<<', at);
  let depth = 0;
  for (let scan = from; scan < dict.length - 1; scan += 1) {
    if (dict.startsWith('<<', scan)) depth += 1;
    else if (dict.startsWith('>>', scan)) {
      depth -= 1;
      if (depth === 0) return dict.slice(from, scan + 2);
    }
  }

  return null;
}

/**
 * A page's content, or null when any part of it cannot be read.
 *
 * Null rather than the parts that could be read: a page whose second stream is
 * compressed in a way this does not undo has lost whatever that stream drew,
 * and its first stream on its own is a partial page. A page with no content at
 * all is a different thing. It is blank, and gives an empty string.
 */
function contentOf(page, objects, budget) {
  const parts = page.contents.map((id) => streamOf(objects.get(id), budget));
  if (parts.some((one) => one === null)) return null;

  return parts.map((bytes) => bytes.toString('latin1')).join('\n');
}

/**
 * A content stream with its strings and inline pictures taken out, leaving the
 * operators and their numbers. An `(f)` shown on a page is a letter and not the
 * operator that fills a shape, and a run of bytes in a picture is neither.
 *
 * The close of a literal string is optional here — `\)?`, not `\)`. With it
 * required, a `(` that never closes made the match fail, and the search tried
 * again one character along, and did so from every `(` in the stream: 31 KB of
 * open parentheses took seconds. Optional, an unclosed `(` takes the rest of
 * the stream in one match and the search moves past it. A real string always
 * closes, so on every file this ever read the two forms strip exactly the same
 * bytes; only a file built from unclosed parentheses is treated differently,
 * and it has no operators left in it to find either way.
 */
function withoutStrings(content) {
  return withoutPictures(content).replace(/\((?:\\.|[^\\)])*\)?|<[0-9a-fA-F\s]*>/g, ' ');
}

/**
 * The inline pictures taken out, each leaving a `BI` to say one was drawn.
 *
 * Found by two searches that only move forward, and not by one pattern that
 * looks for the end from every start. That pattern read to the end of the
 * stream once for each `BI` with no `EI` after it: 47 KB of them took 634 ms,
 * and four times as long for each doubling, which is a request that holds the
 * one thread this service has for as long as whoever built the file likes.
 */
function withoutPictures(content) {
  const begins = /(?<![^\s\]>)])BI(?![^\s/])/g;
  const ends = /(?<!\S)EI(?!\S)/g;
  let out = '';
  let from = 0;

  for (let begin = begins.exec(content); begin; begin = begins.exec(content)) {
    out += `${content.slice(from, begin.index)} BI `;

    ends.lastIndex = begin.index + 2;
    const end = ends.exec(content);
    // A picture with no end takes the rest of the stream with it.
    if (!end) return out;

    from = end.index + 2;
    begins.lastIndex = from;
  }

  return out + content.slice(from);
}

/**
 * The text in one content stream.
 *
 * A content stream is operators in postfix order. Six matter here: `Tf` chooses
 * a font and a size, `Tj`/`TJ`/`'` show text, and `Tm`, `Td`, `TD` and `T*`
 * move the cursor.
 *
 * **`Tm` is absolute and `Td` is relative**, and treating them alike is the
 * defect this function was written around twice. A browser draws a heading one
 * glyph at a time — `Tm` once, then a `Tx 0 Td` before each letter — so reading
 * every move as absolute made the y jump from 65 to 0 after the first
 * character, and every heading in every document came out as "I" on one line
 * and "nvoice" on the next.
 *
 * The cursor is tracked properly instead, which then gives the other thing for
 * free: knowing where a run **ended** as well as where the next one begins. A
 * table row is four runs at the same height and different x, and without the
 * width of what was drawn there is no way to tell that from a sentence with a
 * bold word in it. One needs spaces between the parts and the other must not
 * have them — "Nitrile gloves, medium126.2074.40" was the first, and
 * "Total  due  EUR 128.10" would be the second.
 *
 * So the glyph widths are read out of the font. It is more work than guessing
 * and it is the difference between a table somebody can read and a row of
 * digits run together.
 *
 * **It reads the stream once.** Each token is found where the last one ended,
 * and a string or an array is a token in its own right, kept until the operator
 * that shows it. The reader this replaced coupled the two — it matched
 * `(…)Tj` and `[…]TJ` as single patterns — and so it looked for the close of a
 * string, and then the operator, from every `(` and every `[` in the stream. A
 * `(` that never closed sent that search to the end of the stream, once for
 * each of them: 31 KB of open parentheses took nearly twenty seconds on the
 * one thread this service has. Now a `(` with no `)` is one token that takes
 * the rest of the stream and the scan moves past it, and every byte is looked
 * at once. A real stream, whose strings and arrays all close, reads exactly as
 * it did before.
 *
 * @returns {{text: string, shown: number, missed: number, because: string | null}}
 *   the text; how many of the operators that show text were read to get it,
 *   which the page compares with how many there are; and how many codes could
 *   not be turned into characters, with the reason for the first of them.
 */
function textIn(content, faces) {
  let out = '';
  let shown = 0;
  let missed = 0;
  let because = null;

  /** The font in use, and its size, from the last `Tf`. */
  let face = NO_FACE;
  let size = 12;

  /** Where the current line starts, and how far along it the pen has got. */
  let originX = 0;
  let originY = 0;
  let penX = 0;
  let leading = 0;
  let started = false;

  /**
   * The last string and the last array seen, each held until the operator that
   * draws it. A string's or array's close is optional in the patterns below —
   * `\)?`, `\]?` — so one that never closes is still a single token that
   * consumes to the end of the stream, rather than a match that fails and is
   * retried one character along from every opener. `closed` records whether the
   * close was really there, because only a closed string is drawn, exactly as
   * the coupled `(…)Tj` pattern required one.
   */
  let string = null; // { kind: 'literal' | 'hex', value, closed, end }
  let array = null; //  { value, closed, end }

  /** True when nothing but whitespace sits between an operand and its operator. */
  const adjacent = (operand, opIndex) => operand && operand.closed && !/\S/.test(content.slice(operand.end, opIndex));

  const tokens = content.matchAll(
    new RegExp(
      [
        String.raw`\/(?<font>[A-Za-z0-9+.\-_]+)\s+(?<fsize>-?[\d.]+)\s+Tf`,
        String.raw`(?<tl>-?[\d.]+)\s+TL`,
        String.raw`(?<tdx>-?[\d.]+)\s+(?<tdy>-?[\d.]+)\s+(?<tdkind>Td|TD)`,
        String.raw`(?<tma>-?[\d.]+)\s+(?<tmb>-?[\d.]+)\s+(?<tmc>-?[\d.]+)\s+(?<tmd>-?[\d.]+)\s+(?<tmx>-?[\d.]+)\s+(?<tmy>-?[\d.]+)\s+Tm`,
        String.raw`(?<star>T\*)`,
        String.raw`\[(?<arr>(?:[^\]\\]|\\.)*)(?<arrc>\])?`,
        String.raw`\((?<lit>(?:\\.|[^\\)])*)(?<litc>\))?`,
        String.raw`<(?<hex>[0-9a-fA-F\s]*)>`,
        String.raw`(?<op>TJ|Tj|')`,
      ].join('|'),
      'g'
    )
  );

  /** Puts the pen somewhere, and says what that means for the text so far. */
  function moveTo(x, y) {
    if (!started) {
      started = true;
    } else if (Math.abs(y - originY) > A_NEW_LINE * size) {
      out += '\n';
    } else if (x - penX > A_SPACE * size && !/\s$/.test(out) && out !== '') {
      // Same line, and a gap wider than a word space: the next cell of a table
      // row, or a tab stop. Not inserted after existing whitespace, and not
      // when the run simply continues where the last one stopped.
      out += ' ';
    }

    originX = x;
    originY = y;
    penX = x;
  }

  /** Draws some codes in the current font, and counts any it cannot read. */
  function show(codes) {
    const drawn = decode(codes, face);
    out += drawn.text;
    penX += drawn.width * size;

    if (drawn.missed > 0) {
      missed += drawn.missed;
      because ??= face.name
        ? `${face.name}: ${face.unreadable ?? 'its ToUnicode map leaves out codes the page shows'}`
        : face.unreadable;
    }
  }

  for (const token of tokens) {
    const g = token.groups;

    if (g.font !== undefined) {
      face = faces.get(g.font) ?? { ...NO_FACE, name: `/${g.font}`, unreadable: 'the page does not define it' };
      size = Math.abs(Number(g.fsize)) || 12;
      continue;
    }

    if (g.tl !== undefined) {
      leading = Number(g.tl);
      continue;
    }

    if (g.tdx !== undefined) {
      if (g.tdkind === 'TD') leading = -Number(g.tdy);
      moveTo(originX + Number(g.tdx), originY + Number(g.tdy));
      continue;
    }

    if (g.tmx !== undefined) {
      moveTo(Number(g.tmx), Number(g.tmy));
      continue;
    }

    if (g.star !== undefined) {
      moveTo(originX, originY + leading);
      continue;
    }

    if (g.arr !== undefined) {
      array = { value: g.arr, closed: g.arrc !== undefined, end: token.index + token[0].length };
      continue;
    }

    if (g.lit !== undefined) {
      string = { kind: 'literal', value: token[0], closed: g.litc !== undefined, end: token.index + token[0].length };
      continue;
    }

    if (g.hex !== undefined) {
      // A hex string is written with its close required, so it is drawn only
      // when it is whole, the way it always was.
      string = { kind: 'hex', value: g.hex, closed: true, end: token.index + token[0].length };
      continue;
    }

    // A show operator draws the operand right before it, and nothing else. A
    // `Tj`, `'` or `TJ` with no operand of its own (a `"`, which sets spacing
    // and is not read here, leaves its string behind like this) draws nothing
    // and is not counted, so the page's tally of show operators comes out
    // higher than what was read and the page is set aside — see readPage.
    if (g.op === 'TJ') {
      if (adjacent(array, token.index)) {
        shown += 1;
        for (const part of array.value.matchAll(/<([0-9a-fA-F\s]*)>|(\((?:\\.|[^\\)])*\))|(-?[\d.]+)/g)) {
          if (part[1] !== undefined) {
            show(codesInHex(part[1], face.bytes));
          } else if (part[2] !== undefined) {
            show(codesInLiteral(part[2], face.composite ? face.bytes : 1));
          } else {
            const kern = Number(part[3]);
            penX -= (kern / 1000) * size;
            if (kern < -A_KERNED_SPACE && !/\s$/.test(out)) out += ' ';
          }
        }
      }
      array = null;
      continue;
    }

    // `Tj` or `'`.
    if (adjacent(string, token.index)) {
      // `'` shows text on the next line, which is `T*` and then `Tj`.
      if (g.op === "'") moveTo(originX, originY + leading);
      shown += 1;
      if (string.kind === 'literal') show(codesInLiteral(string.value, face.composite ? face.bytes : 1));
      else show(codesInHex(string.value, face.bytes));
    }
    string = null;
  }

  return { text: out, shown, missed, because };
}

/** Text shown before any `Tf` is in no font at all, and nothing says what it is. */
const NO_FACE = {
  name: null,
  chars: null,
  bytes: 1,
  composite: false,
  unreadable: 'text shown before any font was chosen',
  wide: null,
};

/** How wide one glyph is, in ems. 0.5 for a font that did not say. */
function widthOf(code, wide) {
  const said = wide?.get(code);
  return (said === undefined ? 500 : said) / 1000;
}

/**
 * What some codes say in a font, how wide they are, and how many of them could
 * not be turned into characters. Those give no text, and are counted instead,
 * because a code left out of the text silently is a page read in part.
 */
function decode(codes, face) {
  let text = '';
  let width = 0;
  let missed = 0;

  for (const code of codes) {
    width += widthOf(code, face.wide);

    if (face.unreadable) {
      missed += 1;
    } else if (face.chars) {
      const chars = face.chars.get(code);
      if (chars === undefined) missed += 1;
      else text += chars;
    } else {
      text += String.fromCharCode(code);
    }
  }

  return { text, width, missed };
}

function codesInHex(hex, bytes) {
  const clean = hex.replace(/\s+/g, '');
  const step = bytes * 2;
  const codes = [];

  // How wide a code is comes from the font's own CMap, not from the length of
  // the string: guessing reads a three-glyph run as one, and guessing the other
  // way reads three glyphs as none.
  for (let at = 0; at + step <= clean.length; at += step) codes.push(parseInt(clean.slice(at, at + step), 16));

  return codes;
}

const ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };

/**
 * The codes in a `(literal)` string, `bytes` to a code.
 *
 * A literal is only another way to write the same bytes a hex string holds, and
 * a CID font's codes are two bytes whichever way they are written. They were
 * read one byte at a time, which worked by accident for glyphs below 256, the
 * high byte finding nothing in the map and vanishing, and for no glyph above.
 */
function codesInLiteral(literal, bytes) {
  const body = literal.slice(1, -1);
  const raw = [];

  for (let at = 0; at < body.length; at += 1) {
    let code;

    if (body[at] === '\\') {
      const next = body[at + 1];

      if (next === '\r' || next === '\n') {
        // A backslash at the end of a line continues the string on the next
        // one, and stands for nothing itself.
        at += next === '\r' && body[at + 2] === '\n' ? 2 : 1;
        continue;
      } else if (next in ESCAPES) {
        // A named escape is a character in its own right, and in a subset font
        // it still goes through the map: `\n` here is glyph 10.
        code = ESCAPES[next].charCodeAt(0);
        at += 1;
      } else if (/[0-7]/.test(next)) {
        const octal = body.slice(at + 1).match(/^[0-7]{1,3}/)[0];
        code = parseInt(octal, 8);
        at += octal.length;
      } else {
        at += 1;
        code = body.charCodeAt(at);
      }
    } else {
      code = body.charCodeAt(at);
    }

    raw.push(code & 0xff);
  }

  if (bytes === 1) return raw;

  const codes = [];
  for (let at = 0; at + bytes <= raw.length; at += bytes) {
    codes.push(raw.slice(at, at + bytes).reduce((code, byte) => code * 256 + byte, 0));
  }

  return codes;
}
