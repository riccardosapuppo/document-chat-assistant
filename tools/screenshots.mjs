#!/usr/bin/env node
/**
 * The pictures in the README, made rather than taken.
 *
 *     npm run screenshots
 *
 * Nothing here photographs the screen. It starts its own service on its own
 * port, opens the console in a browser, and captures **the page** — so whatever
 * else happens to be on this machine at the time cannot end up in a file that
 * is about to be pushed to a repository. That is not hypothetical: a screenshot
 * of the screen is a screenshot of everything that was on it.
 *
 * They are generated rather than kept by hand so they cannot quietly stop
 * matching the thing they are pictures of. This is re-run whenever the console
 * changes, and the README then shows what the console does today.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 3747;
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const docs = path.join(root, 'docs');

let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)('playwright-core'));
} catch {
  console.error('playwright-core is not installed here:  npm install --save-dev playwright-core');
  process.exit(2);
}

fs.mkdirSync(docs, { recursive: true });

let service = null;

try {
  service = await start();

  const browser = await chromium.launch({ channel: 'msedge', headless: true });

  try {
    const page = await browser.newPage({
      viewport: { width: 1400, height: 1100 },
      deviceScaleFactor: 2,
      reducedMotion: 'reduce',
    });

    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });

    // ------------------------------------------- 1. the two answers, disagreeing
    //
    // This question is chosen because the two searches disagree on it, and the
    // disagreement is the whole page. A picture of a question they agree on
    // would be a picture of the argument not happening.
    await ask(page, 'how heavy can the label stock be on the TP-40');
    await shoot(page, 'the-console.png');

    // ------------------------------------- 2. what it made of the question
    await ask(page, 'what does E-4412 mean');
    await shoot(page, 'what-it-made-of-it.png', '#reading');

    // ------------------------------------------------- 3. one that leans back
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'one that leans on the last' }).click();
    await page.waitForFunction(() => !document.getElementById('two').hidden);
    await shoot(page, 'one-that-leans.png', '#two');

    // ------------------------------------------------------------ 4. the mark
    const mark = await browser.newPage({ viewport: { width: 320, height: 96 }, deviceScaleFactor: 4 });
    const svg = fs.readFileSync(path.join(root, 'public', 'mark.svg'), 'utf8');

    await mark.setContent(
      `<style>html,body{margin:0;background:#f6f3ec;display:flex;gap:18px;align-items:center;
         justify-content:center;height:96px}img{display:block;border-radius:5px}</style>` +
        [16, 32, 64]
          .map(
            (size) =>
              `<img src="data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}" width="${size}" height="${size}">`
          )
          .join('')
    );

    await mark.waitForFunction(() => [...document.images].every((one) => one.complete));
    await shoot(mark, 'the-mark.png');
    await mark.close();
  } finally {
    await browser.close();
  }
} finally {
  if (service) await gone(service);
}

console.log(`\n  in ${path.relative(process.cwd(), docs)}`);

// ---------------------------------------------------------------------------

async function ask(page, question) {
  await page.fill('#question', question);
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await page.waitForFunction(() => !document.getElementById('two').hidden);
  await page.waitForFunction(
    (asked) => document.getElementById('conversation-list').textContent.includes(asked.slice(0, 20)),
    question
  );
}

async function shoot(page, name, selector) {
  const to = path.join(docs, name);

  if (selector) await page.locator(selector).screenshot({ path: to });
  else await page.screenshot({ path: to, fullPage: true });

  console.log(`  ${name}`);
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
