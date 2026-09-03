/**
 * The console.
 *
 * It decides nothing. Every verdict on this screen — which kind of question it
 * was, which document it was about, which branch answered — comes from the
 * service, which is the same code the measurement runs against. A screen that
 * worked any of that out for itself would be a second implementation of the
 * only thing this project is about, and the two would disagree eventually.
 */

/**
 * Nothing here installs a service worker, and this makes sure nothing has.
 *
 * A worker outlives the version that installed it and the page that registered
 * it. This is served on 127.0.0.1, an origin shared with every other thing
 * anybody has ever developed on that port, so one left behind by an unrelated
 * project can serve a page this application no longer has — and the symptom is
 * a stale screen that only Ctrl+F5 fixes, which sends people looking at caching
 * headers that were right all along.
 */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .getRegistrations()
    .then((workers) => Promise.all(workers.map((one) => one.unregister())))
    .then((undone) => {
      if (undone.length > 0) console.info(`unregistered ${undone.length} service worker(s) left on this origin`);
      return globalThis.caches?.keys().then((names) => Promise.all(names.map((one) => caches.delete(one))));
    })
    .catch(() => {
      /* a browser that will not say has nothing for us to undo */
    });
}

const $ = (id) => document.getElementById(id);

/**
 * The questions asked so far, in order.
 *
 * Kept here rather than on the server: a conversation belongs to whoever is
 * having it, and a service that remembers one has to be told when somebody has
 * finished — which is a thing to get wrong for no benefit at this size.
 */
const asked = [];

// ------------------------------------------------------------------ what it is

(async function sayWhatThisIs() {
  const said = await (await fetch('/api/health')).json();

  $('about-documents').textContent = said.documents.length;
  $('about-pieces').textContent = said.pieces;
  $('about-embeddings').textContent = said.embeddings;

  $('footer-embeddings').textContent = said.lexical
    ? 'the local index, which matches words rather than meanings'
    : said.embeddings;
})();

// --------------------------------------------------------------------- asking

$('ask-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  await ask($('question').value);
});

for (const button of document.querySelectorAll('[data-try]')) {
  button.addEventListener('click', async () => {
    // A question that leans on the one before it needs one before it. The
    // example carries its own, so pressing it demonstrates the thing rather
    // than demonstrating what happens when there is no history.
    const before = button.dataset.after;

    if (before && asked[asked.length - 1] !== before) {
      await ask(before, { quietly: true });
    }

    $('question').value = button.dataset.try;
    await ask(button.dataset.try);
  });
}

$('forget').addEventListener('click', () => {
  asked.length = 0;
  drawTheConversation();
});

async function ask(question, { quietly = false } = {}) {
  const said = String(question ?? '').trim();
  if (!said) return;

  const answer = await post('/api/ask', { question: said, history: [...asked] });

  asked.push(said);
  drawTheConversation();

  if (quietly) return;

  drawWhatItMadeOfIt(answer);
  draw($('plain-found'), answer.plain);
  draw($('knowing-found'), answer.knowing);

  $('knowing-how').textContent = answer.how;
  $('two').hidden = false;

  const verdict = $('verdict');
  verdict.hidden = false;
  verdict.className = `verdict ${answer.same ? 'same' : 'different'}`;
  verdict.textContent = answer.same
    ? 'Both searches returned the same passage first. On a question like this the ordinary approach is enough — which is most questions, and worth saying.'
    : 'They returned different passages. The one on the right is what this project is for.';
}

// ------------------------------------------------------------------- drawing

function drawWhatItMadeOfIt(answer) {
  const said = [];

  if (!answer.kind.standsAlone) {
    said.push([
      'it does not stand on its own',
      `${answer.kind.leaning.why} — so it was asked as “${answer.kind.asked}”`,
    ]);
  }

  if (answer.kind.literal.yes) {
    said.push(['it contains something literal', `${answer.kind.literal.why}, so it is matched letter for letter`]);
  }

  said.push(
    answer.kind.document
      ? ['it names a document', `${answer.kind.document} — ${answer.kind.documentWhy}`]
      : ['it names no document', answer.kind.documentWhy ?? 'so every document was searched']
  );

  $('reading-list').replaceChildren(
    ...said.map(([what, why]) => {
      const li = document.createElement('li');
      const strong = document.createElement('strong');
      strong.textContent = what;
      li.append(strong, document.createTextNode(` — ${why}`));
      return li;
    })
  );

  $('reading').hidden = false;
}

function draw(into, found) {
  into.replaceChildren();

  if (found.length === 0) {
    const li = document.createElement('li');
    li.className = 'none';
    li.textContent = 'nothing at all';
    into.append(li);
    return;
  }

  for (const [at, one] of found.entries()) {
    const li = document.createElement('li');
    if (at === 0) li.className = 'first';

    const where = document.createElement('p');
    where.className = 'where';
    where.textContent = `${one.document} · ${one.heading ?? '(no heading)'}`;

    const why = document.createElement('p');
    why.className = 'why';
    why.textContent = `${one.why} · ${one.score}`;

    const text = document.createElement('blockquote');
    text.textContent = one.text;

    li.append(where, why, text);
    into.append(li);
  }
}

function drawTheConversation() {
  $('conversation').hidden = asked.length === 0;
  $('conversation-list').replaceChildren(
    ...asked.map((one) => Object.assign(document.createElement('li'), { textContent: one }))
  );
}

async function post(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  return response.json();
}
