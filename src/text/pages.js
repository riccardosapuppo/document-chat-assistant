/*
 * Copied from document-ocr-service, src/ocr/pages.js at commit 7c7f968, for
 * pdf-text.js beside it, and unedited for the same reason. The chat names
 * pages with it too, so a page is said the way the reader says it.
 */

/**
 * Page numbers, said the way a person says them.
 *
 *     [2]              page 2
 *     [2, 5]           pages 2 and 5
 *     [1, 2, … 39, 41] pages 1 to 39 and 41
 *
 * Three places name pages now that a document is read a page at a time: what
 * the text layer found, what the engine that reads pixels was sent, and what
 * nothing could read. They say it the same way because they are read side by
 * side, in one answer. A run of three or more is a range: a forty-page contract
 * with one scanned signature page is the case this is written for, and "pages
 * 1, 2, 3" and so on to 39 is not a sentence anybody finishes reading.
 *
 * @param {number[]} numbers one-based and ascending
 */
export function pageWords(numbers) {
  const parts = [];

  for (let at = 0; at < numbers.length; ) {
    let to = at;
    while (numbers[to + 1] === numbers[to] + 1) to += 1;

    if (to - at >= 2) {
      parts.push(`${numbers[at]} to ${numbers[to]}`);
      at = to + 1;
    } else {
      parts.push(String(numbers[at]));
      at += 1;
    }
  }

  const said = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
  return `${numbers.length === 1 ? 'page' : 'pages'} ${said}`;
}
