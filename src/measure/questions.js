/**
 * The questions this is measured on, and where the answer to each really is.
 *
 * This file is the claim. Everything else in the project is an implementation
 * of an argument — that a similarity search is the wrong tool for some of what
 * people ask a manual — and an argument nobody measured is an opinion.
 *
 * Each question names the **document and heading** that answers it rather than
 * a chunk id, because chunk ids move when the cutting changes and the right
 * answer does not. A benchmark that has to be updated whenever the code changes
 * is a benchmark that will be updated to whatever the code now does.
 *
 * They are grouped by the kind of question, and reported that way. A single
 * average across all of them would hide the whole finding: the baseline is not
 * bad everywhere, it is bad in specific places, and which places depends on
 * which provider is in use — the local one is lexical and therefore good at
 * codes, a real embedding is not.
 */

export const QUESTIONS = [
  // ---------------------------------------------------------------- ordinary
  //
  // Phrased in words close to the document's own. This is what a similarity
  // search is for, and it should win or draw on every one of them: a change
  // that improves the others by breaking these is not an improvement.
  {
    kind: 'ordinary',
    ask: 'how heavy can the label stock be on the TP-40',
    answeredBy: { document: 'halden-tp40-manual', heading: 'Paper the tray will take' },
  },
  {
    kind: 'ordinary',
    ask: 'how often should the print head be cleaned',
    answeredBy: { document: 'halden-tp40-manual', heading: 'Cleaning' },
  },
  {
    kind: 'ordinary',
    ask: 'how do I load a ribbon',
    answeredBy: { document: 'halden-tp40-manual', heading: 'Loading a ribbon' },
  },

  // ------------------------------------------------------------------ said
  // differently — the words in the question are not the words in the document.
  {
    kind: 'said differently',
    ask: 'what is the thinnest paper the small printer will pull through',
    answeredBy: { document: 'halden-tp40-manual', heading: 'Paper the tray will take' },
  },
  {
    kind: 'said differently',
    ask: 'my labels come out faded on one side only',
    answeredBy: { document: 'halden-tp40-manual', heading: 'Replacing the print head' },
  },

  // ------------------------------------------------------------------ literal
  //
  // A code has no semantic neighbours. Asked for one, a similarity search
  // returns whatever is most *about* codes in general.
  {
    kind: 'literal',
    ask: 'what does E-4412 mean',
    answeredBy: { document: 'halden-fault-codes', heading: 'E-4412' },
  },
  {
    kind: 'literal',
    ask: 'I keep getting E-2201 on this machine',
    answeredBy: { document: 'halden-fault-codes', heading: 'E-2201' },
  },
  {
    kind: 'literal',
    ask: 'is W-3011 something to worry about',
    answeredBy: { document: 'halden-fault-codes', heading: 'W-3011' },
  },
  {
    kind: 'literal',
    ask: 'what does NETWORK_MODE do',
    answeredBy: { document: 'halden-tp40-manual', heading: 'Network settings' },
  },

  // ------------------------------------------------------------- leaning
  //
  // Not answerable on their own. `history` is what came before, exactly as a
  // conversation would have it.
  {
    kind: 'leaning',
    ask: 'and the TP-60?',
    history: ['what is the smallest margin the TP-40 will print'],
    answeredBy: { document: 'halden-tp60-manual', heading: 'Margins' },
  },
  {
    kind: 'leaning',
    ask: 'and the wide one?',
    history: ['how heavy can the label stock be on the TP-40'],
    answeredBy: { document: 'halden-tp60-manual', heading: 'Paper the tray will take' },
  },
  {
    kind: 'leaning',
    ask: 'is it the same part?',
    history: ['when should I replace the print head on the TP-40'],
    answeredBy: { document: 'halden-tp60-manual', heading: 'Replacing the print head' },
  },
];

/** The kinds, in the order the report shows them. */
export const KINDS = [...new Set(QUESTIONS.map((one) => one.kind))];

/**
 * Did the search find the passage that answers it?
 *
 * Judged on **the first result only**, and that is deliberate. "It was in the
 * top five" is how a retrieval system is usually reported and is not how it is
 * used: whatever is first is what gets read, quoted, and acted on. A system
 * that puts the right passage third is a system that answers wrongly with a
 * citation to something true, which is the worst failure of the lot.
 */
export function foundIt(found, answeredBy) {
  const first = found[0];
  if (!first) return false;

  return first.chunk.document === answeredBy.document && first.chunk.heading === answeredBy.heading;
}

/** And a gentler question, reported beside it: was it anywhere in the top five? */
export function foundItAtAll(found, answeredBy) {
  return found.some(
    (one) => one.chunk.document === answeredBy.document && one.chunk.heading === answeredBy.heading
  );
}
