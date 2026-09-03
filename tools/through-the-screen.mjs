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
  } finally {
    await browser.close();
  }
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
