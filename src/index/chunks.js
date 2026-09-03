/**
 * Cutting a document into pieces small enough to retrieve.
 *
 * This is the least glamorous part of a retrieval system and the one that
 * decides most of its quality. Everything after it can only find what the cut
 * left findable: a piece that ends in the middle of the sentence answering the
 * question is a piece that answers half of it, and the half it kept is the half
 * the reader did not need.
 *
 * The shape here is taken from the tool this was rebuilt from — fixed size,
 * fixed overlap, and then **backing off to the last sentence boundary** in the
 * final stretch so a piece does not end mid-thought. That last part is the idea
 * worth keeping, and it is three lines.
 *
 * What is added is the boundary that matters more in a manual: a heading. A
 * product manual is not prose, it is sections, and a piece that spans the end of
 * "Installing" and the start of "Uninstalling" retrieves for both questions and
 * answers neither. So headings cut first, and the sliding window works inside a
 * section rather than across the whole file.
 */

/** How far back to look for a sentence boundary before giving up on one. */
const LOOK_BACK = 120;

/**
 * A heading, in the plain-text manuals this reads.
 *
 * Markdown-style hashes, or a short line in title case followed by a blank one.
 * Deliberately conservative: mistaking a sentence for a heading cuts a paragraph
 * in half, which is worse than missing a heading and falling back to the window.
 */
const HEADING = /^(#{1,6}\s+\S.*|[A-Z][^.!?\n]{2,70})$/;

/**
 * Splits into sections at headings, keeping each heading with what follows it.
 *
 * The heading travels with the section on purpose: it is often the only place
 * the subject is named. A section that says "Set it to 4 mm" retrieves for
 * nothing at all; the same text under "Margins" retrieves for margins.
 */
export function sections(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const found = [];

  let heading = null;
  let held = [];

  const keep = () => {
    const body = held.join('\n').trim();
    if (body || heading) found.push({ heading, text: [heading, body].filter(Boolean).join('\n').trim() });
    held = [];
  };

  for (const [at, line] of lines.entries()) {
    const looksLikeHeading =
      HEADING.test(line.trim()) &&
      line.trim().length > 0 &&
      (line.trim().startsWith('#') || (lines[at + 1] ?? '').trim() === '');

    if (looksLikeHeading) {
      keep();
      heading = line.trim().replace(/^#+\s*/, '');
      continue;
    }

    held.push(line);
  }

  keep();

  return found.filter((one) => one.text.length > 0);
}

/**
 * One section, cut into overlapping pieces.
 *
 * The overlap is not decoration: without it, a sentence that straddles a cut
 * belongs wholly to neither piece, and the answer to a question about it is in
 * both halves and complete in neither.
 *
 * @returns {string[]}
 */
export function windowed(text, { size = 900, overlap = 180 } = {}) {
  const clean = String(text ?? '').replace(/\r/g, '');
  if (!clean.trim()) return [];

  const wide = Math.max(120, Number(size) || 900);
  let over = Math.max(0, Number(overlap) || 0);

  // An overlap as large as the window would step nowhere and loop for ever.
  if (over >= wide) over = Math.floor(wide / 4);

  const step = wide - over;
  const pieces = [];

  for (let at = 0; at < clean.length; at += step) {
    const end = Math.min(at + wide, clean.length);
    let piece = clean.slice(at, end);

    if (end < clean.length) {
      // Back off to the last sentence boundary in the final stretch, so the
      // piece ends where a thought does. If there is not one — a table, a long
      // list, a code block — the hard cut stands rather than searching further
      // back and returning a piece a third of the size.
      const tail = piece.slice(-LOOK_BACK);
      const stop = Math.max(tail.lastIndexOf('. '), tail.lastIndexOf('\n'));

      if (stop > 20) piece = piece.slice(0, piece.length - (tail.length - stop - 1));
    }

    if (piece.trim()) pieces.push(piece.trim());
    if (end === clean.length) break;
  }

  return pieces;
}

/**
 * A whole document, as the pieces an index holds.
 *
 * Each piece carries where it came from, because an answer that cannot say
 * which page it came from is an answer nobody can check — and checking is the
 * only thing that makes a retrieved answer worth more than a guess.
 *
 * @returns {{ id: string, document: string, heading: string|null, at: number, text: string }[]}
 */
export function cutUp(document, text, options = {}) {
  const pieces = [];

  for (const [where, section] of sections(text).entries()) {
    for (const piece of windowed(section.text, options)) {
      pieces.push({
        id: `${document}#${pieces.length}`,
        document,
        heading: section.heading,
        at: where,
        text: piece,
      });
    }
  }

  return pieces;
}
