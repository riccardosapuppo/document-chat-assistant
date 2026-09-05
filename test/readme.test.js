/**
 * The README, checked against the repository it describes.
 *
 * A README is the one file everybody reads and nothing verifies, so it rots in
 * a particular way: the code moves and the prose stays, and the first person to
 * notice is a stranger typing the first command. This repository had three of
 * those at once — a Node version that was wrong, a check count that said 86
 * when 92 ran, and a browser requirement that named the wrong browser.
 *
 * The delivery rule says every README example must be run and **tied to a
 * check, so that it cannot stop being true**. This is that check for everything
 * static. The per-harness totals are checked by the harnesses themselves, at
 * the end of their own runs, where the number is a fact rather than a promise.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { claims } from '../tools/what-the-readme-claims.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

describe('every command the README tells somebody to type', () => {
  /** `npm run x`, `npm test`, `npm start`, wherever they appear. */
  const commands = [...new Set([...readme.matchAll(/`?\bnpm (?:run [a-z:-]+|test|start|ci|install)\b/g)].map((one) => one[0].replace(/^`/, '')))];

  it('is a command that exists', () => {
    const missing = commands.filter((one) => {
      const script = one.match(/^npm run ([a-z:-]+)$/)?.[1] ?? (one === 'npm test' ? 'test' : one === 'npm start' ? 'start' : null);
      return script !== null && !Object.hasOwn(manifest.scripts, script);
    });

    assert.deepEqual(missing, [], `the README names these and package.json has not got them: ${missing.join(', ')}`);
  });

  it('and there is at least one of them, so this test cannot pass by finding nothing', () => {
    // The failure this guards against is a regex that stops matching: it would
    // then check an empty list and report success for ever.
    assert.ok(commands.length >= 6, `only found ${commands.length} commands in the README`);
  });
});

describe('every check the README counts', () => {
  const counted = claims();

  it('is a command that exists', () => {
    for (const command of Object.keys(counted)) {
      const script = command.replace(/^npm (run )?/, '').trim();
      const name = script === 'test' || script === 'start' ? script : script;
      assert.ok(Object.hasOwn(manifest.scripts, name), `the README counts \`${command}\`, which is not a script`);
    }
  });

  it('and the unit total is the number of tests there actually are', () => {
    // The other totals are checked by the harness that produces them, when it
    // runs. This one can be checked here, because the tests are right there to
    // be counted: `node --test` reports exactly the number of `it(` cases.
    const cases = fs
      .readdirSync(path.join(root, 'test'))
      .filter((one) => one.endsWith('.test.js'))
      .reduce((all, one) => all + (fs.readFileSync(path.join(root, 'test', one), 'utf8').match(/^\s+it\(/gm) ?? []).length, 0);

    assert.equal(
      counted['npm test'],
      cases,
      `the README says npm test runs ${counted['npm test']} checks; there are ${cases}`
    );
  });

  it('and every harness the README counts says so out loud when it runs', () => {
    // Without this, a harness could be added to the table and never check its
    // own line — which is how the 86 survived in the first place.
    const harnesses = { 'npm run walkthrough': 'walkthrough.mjs', 'npm run check:screen': 'through-the-screen.mjs', 'npm run check:smtp': 'against-a-real-server.mjs', 'npm run check:mark': 'check-mark.mjs' };

    for (const [command, file] of Object.entries(harnesses)) {
      if (counted[command] === undefined) continue;

      const source = fs.readFileSync(path.join(root, 'tools', file), 'utf8');
      assert.match(
        source,
        new RegExp(`matchesTheReadme\\('${command.replace(/[:]/g, '[:]')}'`),
        `${file} does not check the README's claim about ${command}`
      );
    }
  });
});

describe('every file the README points at', () => {
  const links = [...readme.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)].map((one) => one[1]);

  it('exists on disk', () => {
    const broken = links
      .filter((one) => !/^(https?:|mailto:|#)/.test(one))
      .filter((one) => !fs.existsSync(path.join(root, one.split('#')[0])));

    assert.deepEqual(broken, [], `the README links to files that are not there: ${broken.join(', ')}`);
  });

  it('including every screenshot, so the page is not full of broken images on GitHub', () => {
    const images = [...readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((one) => one[1]);

    assert.ok(images.length >= 4, `only ${images.length} images — the regex has probably stopped matching`);
    for (const image of images) assert.ok(fs.existsSync(path.join(root, image)), `${image} is missing`);
  });

  it('and every anchor is a heading that is really in the file', () => {
    const headings = [...readme.matchAll(/^#{1,6}\s+(.+)$/gm)].map((one) =>
      one[1]
        .toLowerCase()
        .replace(/[^\w\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-')
    );

    const anchors = links.filter((one) => one.startsWith('#')).map((one) => one.slice(1));

    for (const anchor of anchors) {
      assert.ok(headings.includes(anchor), `the README links to #${anchor} and has no such heading`);
    }
  });
});

describe('what the README promises about the runtime', () => {
  it('is the same version package.json enforces', () => {
    // These drifted apart once already, and the CI was what noticed.
    const declared = manifest.engines.node.match(/(\d+)/)[1];

    assert.match(readme, new RegExp(`Node ${declared} or newer`), `package.json says >=${declared}; the README does not say so`);
  });

  it('and the README does not still name an older one as sufficient', () => {
    const stale = readme.match(/\*\*Node (\d+(?:\.\d+)?) or newer\*\*/g) ?? [];
    const declared = manifest.engines.node.match(/(\d+)/)[1];

    for (const one of stale) {
      assert.match(one, new RegExp(`Node ${declared} or newer`), `the README still promises ${one}`);
    }
  });
});

describe('what the README says the install costs', () => {
  // Three figures, and all three are derivable from this repository rather than
  // remembered. The count is the lockfile's entries minus the root, which is
  // what `npm install` prints as "added N packages" and can be read without
  // installing anything. The bytes are those resolved packages walked on disk —
  // the packages only, not the whole of `node_modules`, because `.bin` is one
  // symlink per command on one platform and three shim files on another, and a
  // figure that moved with the operating system would be nobody's.
  //
  // This sentence rotted the ordinary way: it said 68 packages and 5.6 MB, both
  // true the day they were typed, and then a browser driver and a font arrived
  // as dev dependencies and nothing ever looked at the sentence again. 68 is
  // still the right answer to a question the README had stopped asking.
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const resolved = Object.entries(lock.packages).filter(([where]) => where !== '');

  // Weighable only when everything the lockfile resolves is really there: a
  // half-installed tree weighs less and would call the README wrong for it.
  const installed = resolved.every(([where]) => fs.existsSync(path.join(root, where)));
  const nothingToWeigh = 'the packages the lockfile resolves are not all on disk here';

  const megabytes = (only) =>
    Number(
      (
        resolved
          .filter(([, what]) => only(what))
          .reduce((all, [where]) => all + bytesUnder(path.join(root, where)), 0) / 1e6
      ).toFixed(1)
    );

  it('is the number of packages the lockfile resolves', () => {
    const said = readme.match(/`npm install` fetches \*\*(\d+) packages\*\*/);

    assert.ok(said, 'the README no longer says how many packages `npm install` fetches');
    assert.equal(Number(said[1]), resolved.length, `the README says ${said[1]}; the lockfile resolves ${resolved.length}`);
  });

  it('and the megabytes they weigh once they are written', (t) => {
    if (!installed) return t.skip(nothingToWeigh);

    const said = readme.match(/writes\s+\*\*([\d.]+) MB\*\* into `node_modules`/);
    const weighed = megabytes(() => true);

    assert.ok(said, 'the README no longer says how much `npm install` writes');
    assert.equal(Number(said[1]), weighed, `the README says ${said[1]} MB; they weigh ${weighed.toFixed(1)} MB`);
  });

  it('and the share of that the service alone needs', (t) => {
    if (!installed) return t.skip(nothingToWeigh);

    // The half of the sentence worth reading: what somebody who only runs the
    // service pays, against what the browser checks add on top. Split on the
    // lockfile's own `dev` flag, which is the flag `--omit=dev` goes by, so the
    // README and the command it names cannot disagree about where the line is.
    const said = readme.match(/Only \*\*([\d.]+) MB\*\* of that is the service/);
    const weighed = megabytes((what) => !what.dev);

    assert.ok(said, 'the README no longer says what the service alone costs');
    assert.equal(Number(said[1]), weighed, `the README says ${said[1]} MB; they weigh ${weighed.toFixed(1)} MB`);
  });
});

/**
 * Every byte under a directory, counted as file contents rather than as blocks
 * on disk — so the answer is the same on a filesystem that allocates otherwise.
 */
function bytesUnder(dir) {
  let bytes = 0;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const at = path.join(dir, entry.name);

    if (entry.isDirectory()) bytes += bytesUnder(at);
    else if (entry.isFile()) bytes += fs.statSync(at).size;
  }

  return bytes;
}
