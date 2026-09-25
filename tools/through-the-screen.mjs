#!/usr/bin/env node
/**
 * The console, driven with a browser.
 *
 *     npm run check:screen
 *     npm run check:screen -- --show      (watch it happen)
 *
 * The layer the other checks cannot reach. `npm run measure` proves the
 * retrieval picks the right passage; the unit tests prove each branch decides
 * what it should. Neither can say that **the difference is visible**, which is
 * this project's whole claim about itself. A page that quietly showed one
 * answer, or two identical ones, or explained nothing about why, would pass
 * every other check in the repository.
 *
 * So the assertions are about what a person sees: two answers side by side, the
 * branch that fired named in words, and a verdict saying whether they disagreed.
 *
 * It drives the browser already on this machine (`channel: 'msedge'`), so
 * nothing is downloaded and nothing leaves it, and it starts the service itself
 * on its own port and takes it down again.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { matchesTheReadme } from './what-the-readme-claims.mjs';

const PORT = 3737;
const show = process.argv.includes('--show');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)('playwright-core'));
} catch {
  console.error('playwright-core is not installed here, so this check cannot run.');
  console.error('It is a check, not a dependency of the program:  npm install --save-dev playwright-core');
  process.exit(2);
}

let service = null;
let checks = 0;
let bad = 0;

try {
  await run();
} finally {
  if (service) await gone(service);
}

console.log('');
if (!matchesTheReadme('npm run check:screen', checks)) bad += 1;

console.log(`\n${bad === 0 ? `All ${checks} checks passed.` : `${bad} of ${checks} checks failed.`}`);
process.exitCode = bad === 0 ? 0 : 1;

async function run() {
  service = await start();

  const browser = await chromium.launch({ channel: 'msedge', headless: !show });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1100 }, reducedMotion: 'reduce' });

  // Anything the page throws fails this check even if every assertion below
  // passes: a screen that works while quietly throwing is a screen that stops
  // working on the next browser.
  const thrown = [];
  page.on('pageerror', (error) => thrown.push(`threw: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') thrown.push(message.text());
  });

  try {
    console.log(`  driving http://127.0.0.1:${PORT} through the screen\n`);
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });

    // --------------------------------------------------------- 1. what it is
    say('before anything is asked');

    is('it says how many documents it holds', Number(await text(page, '#about-documents')), 3);
    has('and which embeddings answered', await text(page, '#about-embeddings'), 'local');
    is('and shows no answers yet', await page.locator('#two').isHidden(), true);

    // ----------------------------------------------------- 2. a plain question
    say('a question about one machine, where two manuals say the same thing');
    await ask(page, 'how heavy can the label stock be on the TP-40');

    is('both answers are drawn', await page.locator('#two').isVisible(), true);

    const plainFirst = await text(page, '#plain-found li.first .where');
    const knowingFirst = await text(page, '#knowing-found li.first .where');

    has('the one on the right is the right machine', knowingFirst, 'halden-tp40-manual');
    has('and the right section of it', knowingFirst, 'Paper the tray will take');

    // The reason both columns exist: here they disagree, and the left one is
    // the right section of the WRONG machine.
    is('they disagreed, which is the point of showing both', plainFirst !== knowingFirst, true);
    has('and the screen says so', await text(page, '#verdict'), 'different passages');
    has('it says which document it chose, and on which word', await text(page, '#reading-list'), 'tp-40');

    // -------------------------------------------------------- 3. a literal one
    say('a question containing a code');
    await ask(page, 'what does E-4412 mean');

    has('the branch that fired is named in words', await text(page, '#knowing-how'), 'letter for letter');
    has('and it found the section headed by the code', await text(page, '#knowing-found li.first .where'), 'E-4412');
    has('while similarity alone did not', await text(page, '#plain-found li.first .where'), 'W-3011');

    // --------------------------------------- 4. one that leans on the last
    //
    // The example carries its own previous question, so pressing it shows the
    // thing rather than showing what happens when there is no history at all.
    say('a question that does not stand on its own');
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'one that leans on the last' }).click();
    await page.waitForFunction(() => !document.getElementById('two').hidden);

    has('the question before it is shown', await text(page, '#conversation-list'), 'TP-40');
    has('it says the question does not stand on its own', await text(page, '#reading-list'), 'does not stand on its own');
    has('and what it was asked as instead', await text(page, '#reading-list'), 'asked as');
    has('and it answered about the machine just named', await text(page, '#knowing-found li.first .where'), 'tp60');

    // --------------------------------------- 5. and it says when they agree
    say('and when the two agree it says that too, which is the honest half');

    await page.reload({ waitUntil: 'networkidle' });
    await ask(page, 'how often should the print head be cleaned');

    const agreed = await text(page, '#verdict');
    is('the verdict is one of its two sentences, never a blank', /same passage|different passages/.test(agreed), true, agreed);

    // ------------------------------------------------------------ 6. the page
    say('and the page itself');

    is('nothing was thrown while all that happened', thrown.join(' | '), '');

    is(
      'the two columns are the same width, so neither is argued for by the layout',
      await page.evaluate(() => {
        const [left, right] = [...document.querySelectorAll('.answer')].map((one) =>
          Math.round(one.getBoundingClientRect().width)
        );
        return Math.abs(left - right) <= 1;
      }),
      true
    );

    await page.setViewportSize({ width: 760, height: 1000 });
    await page.waitForTimeout(200);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    is('it does not scroll sideways at 760 wide', overflow <= 0, true);

    // ------------------------------------------ 6. bringing your own document
    //
    // The part a visitor with a real document actually wants, and the part
    // nothing else here can check: the index rebuilt from a file that did not
    // exist when the service started.
    await page.setViewportSize({ width: 1400, height: 1100 });
    say('adding a document of your own');

    await page.evaluate(() => {
      document.getElementById('corpus').open = true;
    });
    await page.waitForTimeout(200);

    is('it says how many documents it is reading', Number(await page.textContent('#about-documents')), 3);

    // A manual for something that is not a printer, so nothing in it can be
    // confused with the three invented ones -- and with a word in it that
    // appears nowhere else, which is what a name is made of.
    const mine = [
      '# Coldstream K9 kettle',
      '',
      '## Filling it',
      'The maximum is 1.7 litres, marked inside the body.',
      '',
      '## Descaling',
      'Use citric acid every two months in hard water.',
    ].join('\n');

    await page.setInputFiles('#file', {
      name: 'kettle-manual.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from(mine, 'utf8'),
    });

    await page.waitForFunction(
      () => Number(document.getElementById('about-documents').textContent) === 4,
      { timeout: 10000 }
    );

    is(
      'a document dropped in is indexed, and the count says so',
      Number(await page.textContent('#about-documents')),
      4
    );

    is(
      'and it is listed as yours rather than as one of the invented ones',
      await page.locator('.documents li[data-given=\"false\"] .what').textContent(),
      'kettle-manual'
    );

    await ask(page, 'how much water does the kettle hold');

    has(
      'a question about it is answered out of it',
      await page.locator('#knowing-found li.first .where').textContent(),
      'kettle-manual'
    );

    has(
      'and the branch says which document it chose, and on which word',
      await page.textContent('#knowing-how'),
      'kettle'
    );

    // The three invented manuals still answer, which is the half that would
    // break if adding a document appended to the index rather than rebuilding
    // it -- or rebuilt it wrongly.
    await ask(page, 'what does E-4412 mean');
    has(
      'and the invented manuals still answer as they did',
      await page.locator('#knowing-found li.first .where').textContent(),
      'halden-fault-codes'
    );

    await page.locator('[data-remove]').click();
    await page.waitForFunction(
      () => Number(document.getElementById('about-documents').textContent) === 3,
      { timeout: 10000 }
    );

    is('removing it puts the index back', Number(await page.textContent('#about-documents')), 3);

    // ---------------------------------- 7. a PDF with a page it cannot read
    //
    // A typed page and a scanned one. Nothing here reads pixels, so the typed
    // page is indexed and the other is named: a page left out without a word
    // is a question about it answered from the wrong place without a word.
    say('a PDF with a scanned page in it');

    await page.setInputFiles('#file', {
      name: 'dehumidifier-manual.pdf',
      mimeType: 'application/pdf',
      buffer: aPdf([
        typed([
          'Brightwater B2 dehumidifier',
          'Emptying the tank',
          'The tank holds 2.5 litres, and the fan stops when it is full.',
        ]),
        scanned(),
      ]),
    });

    await page.waitForFunction(
      () => Number(document.getElementById('about-documents').textContent) === 4,
      { timeout: 10000 }
    );

    is(
      'the page that carries its text is indexed, and the count says so',
      Number(await page.textContent('#about-documents')),
      4
    );

    has(
      'the screen names the page it could not read, and why',
      await text(page, '#not-read'),
      'Page 2 was not read: it has no text layer'
    );

    has(
      'and the list of documents goes on saying so',
      await text(page, '.documents li[data-given="false"]'),
      'Page 2 was not read'
    );

    await ask(page, 'how much does the dehumidifier tank hold');
    has(
      'a question about the typed page is answered out of it',
      await page.locator('#knowing-found li.first .where').textContent(),
      'dehumidifier-manual'
    );

    await page.locator('[data-remove]').click();
    await page.waitForFunction(
      () => Number(document.getElementById('about-documents').textContent) === 3,
      { timeout: 10000 }
    );

    // And one that is a scan and nothing else, which was refused before this
    // reader and still is, now saying which page and why.
    await page.setInputFiles('#file', {
      name: 'all-of-it-scanned.pdf',
      mimeType: 'application/pdf',
      buffer: aPdf([scanned()]),
    });

    await page.waitForFunction(() => document.getElementById('added').dataset.trouble === 'yes', { timeout: 10000 });

    has(
      'a PDF with no page it can read is refused, naming the page',
      await text(page, '#added'),
      'page 1 has no text layer'
    );
  } finally {
    await browser.close();
  }
}

// ------------------------------------------------------------- a PDF, made

/**
 * A PDF built here, one content stream to a page.
 *
 * No browser prints a scan, so the page that is one is made the way a scanner
 * makes it: a picture, and nothing else on the page.
 */
function aPdf(pages) {
  const stream = (content, dict = '') =>
    `<< ${dict}/Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`;

  const objects = new Map([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'],
    [4, stream('\x80', '/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 ')],
  ]);

  const ids = pages.map((_, at) => 5 + at * 2);
  objects.set(2, `<< /Type /Pages /Kids [${ids.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`);

  pages.forEach((content, at) => {
    objects.set(
      ids[at],
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
        `/Resources << /Font << /F1 3 0 R >> /XObject << /Im1 4 0 R >> >> /Contents ${ids[at] + 1} 0 R >>`
    );
    objects.set(ids[at] + 1, stream(content));
  });

  let out = '%PDF-1.4\n';
  for (const id of [...objects.keys()].sort((a, b) => a - b)) out += `${id} 0 obj\n${objects.get(id)}\nendobj\n`;

  return Buffer.from(`${out}trailer\n<< /Root 1 0 R >>\n%%EOF`, 'latin1');
}

/** A page of typed lines, in a font with no surprises in it. */
function typed(lines) {
  return `BT /F1 12 Tf 72 720 Td ${lines.map((line) => `(${line}) Tj`).join(' 0 -18 Td ')} ET`;
}

/** A page that is a picture and nothing else, which is what a scan is. */
function scanned() {
  return 'q 612 0 0 792 0 0 cm /Im1 Do Q';
}

// --------------------------------------------------------------------- small

async function ask(page, question) {
  await page.fill('#question', question);
  await page.getByRole('button', { name: 'Ask', exact: true }).click();

  await page.waitForFunction(() => !document.getElementById('two').hidden);
  await page.waitForFunction(
    (asked) => document.getElementById('conversation-list').textContent.includes(asked.slice(0, 20)),
    question
  );
}

function text(page, selector) {
  return page.locator(selector).first().innerText();
}

function say(what) {
  console.log(`\n  ${what}`);
}

function is(what, got, wanted, detail) {
  checks += 1;

  if (got === wanted) {
    console.log(`    ok    ${what}`);
    return;
  }

  bad += 1;
  console.log(`    NO    ${what}\n            wanted ${JSON.stringify(wanted)}, got ${JSON.stringify(detail ?? got)}`);
}

function has(what, got, wanted) {
  checks += 1;

  if (String(got ?? '').toLowerCase().includes(String(wanted).toLowerCase())) {
    console.log(`    ok    ${what}`);
    return;
  }

  bad += 1;
  console.log(`    NO    ${what}\n            wanted something containing ${JSON.stringify(wanted)}, got ${JSON.stringify(got)}`);
}

async function start() {
  const one = spawn(process.execPath, ['src/index.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  one.stderr.on('data', (chunk) => process.stderr.write(chunk));

  for (let attempt = 0; attempt < 300; attempt += 1) {
    const up = await new Promise((done) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: PORT });
      socket.once('connect', () => {
        socket.destroy();
        done(true);
      });
      socket.once('error', () => done(false));
    });

    if (up) return one;
    if (one.exitCode !== null) throw new Error(`the service exited with ${one.exitCode} before answering`);
    await new Promise((done) => setTimeout(done, 100));
  }

  throw new Error(`the service never came up on ${PORT}`);
}

function gone(one) {
  if (one.exitCode !== null) return null;

  return new Promise((done) => {
    const impatient = setTimeout(() => {
      one.kill('SIGKILL');
      done();
    }, 3000);

    one.once('exit', () => {
      clearTimeout(impatient);
      done();
    });

    one.kill();
  });
}
