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

// ─────────────────────────────────────────────── the documents in play

/**
 * Adding a document, and asking about it.
 *
 * The file is read here and sent as JSON — text as text, a PDF as base64 —
 * rather than as a multipart upload. Multipart would mean a parser on the
 * other end, which is a dependency or three hundred lines of boundary
 * handling, to move bytes this page has already read.
 */

const READS = [".md", ".txt", ".pdf"];

function saySoFar(documents) {
  const mine = documents.filter((one) => !one.given).length;

  $("corpus-say").textContent = mine
    ? `${documents.length} documents, ${mine} of them yours`
    : `${documents.length} invented manuals`;

  $("documents").innerHTML = documents
    .map((one) => {
      const names = (one.called ?? []).slice(0, 4).join(", ");

      return `<li data-given="${one.given}">
        <span class="what">${escaped(one.name)}</span>
        <span class="how-many">${one.pieces} pieces</span>
        <span class="called">${names ? `found by: ${escaped(names)}` : "no name of its own"}</span>
        ${one.given ? "<span class=\"given\">invented</span>" : `<button type="button" class="quiet" data-remove="${escaped(one.name)}">remove</button>`}
      </li>`;
    })
    .join("");

  for (const button of document.querySelectorAll("[data-remove]")) {
    button.addEventListener("click", () => void remove(button.dataset.remove));
  }
}

/**
 * Escaped, because a document name comes from a file name and a file name is
 * whatever somebody called their file. This page is served from a machine
 * whose owner may not be the person dropping the file on it.
 */
function escaped(text) {
  const box = document.createElement("span");
  box.textContent = String(text ?? "");
  return box.innerHTML;
}

function tell(words, trouble = false) {
  const el = $("added");
  el.hidden = false;
  el.textContent = words;
  el.dataset.trouble = trouble ? "yes" : "no";
}

async function showDocuments() {
  try {
    const said = await (await fetch("/api/documents")).json();
    saySoFar(said.documents ?? []);
  } catch {
    $("corpus-say").textContent = "the service is not answering";
  }
}

async function add(file) {
  const suffix = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();

  if (!READS.includes(suffix)) {
    tell(`${file.name}: this reads ${READS.join(", ")}, and nothing else`, true);
    return;
  }

  tell(`reading ${file.name}…`);

  const body = { name: file.name };

  if (suffix === ".pdf") {
    // In chunks: String.fromCharCode(...bytes) on a whole file overflows the
    // argument list somewhere around a hundred thousand bytes, and the error
    // is "Maximum call stack size exceeded", which says nothing about PDFs.
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let at = 0; at < bytes.length; at += 8192) {
      binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
    }
    body.base64 = btoa(binary);
  } else {
    body.text = await file.text();
  }

  const response = await fetch("/api/documents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const said = await response.json();

  if (!response.ok) return tell(said.why ?? "that document could not be added", true);

  tell(
    `${said.name}: ${said.characters.toLocaleString("en-GB")} characters, ` +
      `${said.pieces} pieces in the index. Ask it something.`
  );

  await showDocuments();
  await sayWhatIsIndexed();
}

async function remove(name) {
  const response = await fetch(`/api/documents/${encodeURIComponent(name)}`, { method: "DELETE" });
  const said = await response.json();

  if (!response.ok) return tell(said.why ?? "that could not be removed", true);

  tell(`${name} is gone, and the index has been rebuilt without it.`);
  await showDocuments();
  await sayWhatIsIndexed();
}

/** The counts in the header, after the corpus has changed. */
async function sayWhatIsIndexed() {
  try {
    const health = await (await fetch("/api/health")).json();
    $("about-documents").textContent = health.documents.length;
    $("about-pieces").textContent = health.pieces;
  } catch {
    /* the header keeping an old number is not worth an error on screen */
  }
}

$("file").addEventListener("change", async (event) => {
  for (const file of event.target.files) await add(file);
  event.target.value = "";
});

// `dragover` has to be cancelled, or the browser navigates away from the page
// and opens the file — losing everything on screen, in a way that looks like a
// crash.
for (const kind of ["dragenter", "dragover"]) {
  $("drop").addEventListener(kind, (event) => {
    event.preventDefault();
    $("drop").dataset.over = "yes";
  });
}

for (const kind of ["dragleave", "drop"]) {
  $("drop").addEventListener(kind, () => {
    $("drop").dataset.over = "no";
  });
}

$("drop").addEventListener("drop", async (event) => {
  event.preventDefault();
  for (const file of event.dataTransfer?.files ?? []) await add(file);
});

$("reset").addEventListener("click", async () => {
  await fetch("/api/documents/reset", { method: "POST" });
  tell("Back to the three invented manuals.");
  await showDocuments();
  await sayWhatIsIndexed();
});

void showDocuments();
