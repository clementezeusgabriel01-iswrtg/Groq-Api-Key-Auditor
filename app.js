// Added the loader boot sequence and view routing below (boot, routing).
// Everything from parseKeys onward is the original audit logic, untouched.

const CONCURRENCY = 6;
const $ = id => document.getElementById(id);

/* ═══════════════════ loader ═══════════════════ */
(function boot() {
  const loader = $('loader');
  const label  = $('loader-label');
  const app    = $('app');
  const steps  = ['connecting to api.groq.com', 'loading interface', 'ready'];
  let i = 0;
  const tick = setInterval(() => {
    i++;
    if (i < steps.length) { label.textContent = steps[i]; return; }
    clearInterval(tick);
    loader.classList.add('loader-done');
    app.classList.remove('app-hidden');
    setTimeout(() => loader.remove(), 450);
  }, 360);
})();

/* ═══════════════════ view routing (docs / checker) ═══════════════════ */
(function routing() {
  const views = {
    docs:    $('view-docs'),
    checker: $('view-checker'),
    gemini:  $('view-gemini'),
  };
  const desktopTabs = [...document.querySelectorAll('#desktop-tabs .tab-btn')];
  const mobileItems = [...document.querySelectorAll('.mobile-menu-item')];
  const hamburger   = $('hamburger-btn');
  const mobileMenu  = $('mobile-menu');
  const scrim       = $('mobile-menu-scrim');

  function showView(name) {
    Object.entries(views).forEach(([key, el]) => el.classList.toggle('hidden', key !== name));
    desktopTabs.forEach(b => b.classList.toggle('active', b.dataset.view === name));
    mobileItems.forEach(b => b.classList.toggle('active', b.dataset.view === name));
    closeMenu();
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  }

  function openMenu() {
    mobileMenu.classList.remove('hidden');
    scrim.classList.remove('hidden');
    hamburger.classList.add('open');
    hamburger.setAttribute('aria-expanded', 'true');
  }
  function closeMenu() {
    mobileMenu.classList.add('hidden');
    scrim.classList.add('hidden');
    hamburger.classList.remove('open');
    hamburger.setAttribute('aria-expanded', 'false');
  }

  hamburger.addEventListener('click', () => {
    mobileMenu.classList.contains('hidden') ? openMenu() : closeMenu();
  });
  scrim.addEventListener('click', closeMenu);

  [...desktopTabs, ...mobileItems].forEach(btn => {
    btn.addEventListener('click', () => showView(btn.dataset.view));
  });

  $('hero-cta').addEventListener('click', () => showView('checker'));
  $('hero-cta-bottom').addEventListener('click', () => showView('checker'));
  $('gemini-hero-cta').addEventListener('click', () => showView('gemini'));
  $('gemini-hero-cta-bottom').addEventListener('click', () => showView('gemini'));

  showView('docs'); // landing/doc page is always first
})();

// all Groq calls go through our proxy so rate-limit headers survive
const PROXY = '/api/proxy';
function groqFetch(path, key, opts = {}) {
  return fetch(`${PROXY}?path=${encodeURIComponent(path)}`, {
    ...opts,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...opts.headers },
  });
}

// Gemini keys go in the URL, not a header, and Google's API doesn't allow a
// JSON-body POST straight from the browser — route through our own proxy.
const GEMINI_PROXY = '/api/gemini-proxy';
function geminiFetch(path, key, opts = {}) {
  return fetch(`${GEMINI_PROXY}?path=${encodeURIComponent(path)}&apiKey=${encodeURIComponent(key)}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...opts.headers },
  });
}

const ui = {
  input:    $('keys-input'),
  runBtn:   $('run-btn'),
  progWrap: $('progress-wrap'),
  progFill: $('progress-fill'),
  progLbl:  $('progress-label'),
  summary:  $('summary'),
  statAct:  $('stat-active'),
  statTot:  $('stat-total'),
  statTok:  $('stat-tokens'),
  statKeys: $('stat-keys'),
  resWrap:   $('results-section'),
  tbody:     $('results-body'),
  msg:       $('msg-area'),
  corsNote:  $('cors-note'),
  copyBtn:   $('copy-btn'),
  dlBtn:     $('download-btn'),
};

function parseKeys(raw) {
  return raw.split('\n')
    .map(s => s.trim())
    .filter(s => s && !s.startsWith('gsk_your_'));
}

function maskKey(key) {
  return key.length > 9 ? `${key.slice(0, 6)}...${key.slice(-4)}` : 'INVALID';
}

// null if header is missing or not a number
function parseHeader(headers, name) {
  const val = headers.get(name);
  if (!val) return null;
  const n = parseInt(val, 10);
  return isNaN(n) ? null : n;
}

async function getModels(key) {
  try {
    const r = await groqFetch('/models', key, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return [];
    const data = await r.json();
    return (data.data || [])
      .map(m => m.id)
      .filter(id => !id.includes('embed') && !id.includes('whisper'));
  } catch { return []; }
}

// Orpheus (canopylabs/*) are TTS models — they live on /audio/speech with a
// {model, voice, input} body, not /chat/completions with {messages}. Sending
// them through the chat path always 400s, even with a valid key.
const TTS_VOICE = {
  'canopylabs/orpheus-v1-english':   'hannah',
  'canopylabs/orpheus-arabic-saudi': 'fahad',
};

async function testCombo(key, model, masked) {
  try {
    const isTTS = model in TTS_VOICE;
    const r = await groqFetch(isTTS ? '/audio/speech' : '/chat/completions', key, {
      method: 'POST',
      body: JSON.stringify(
        isTTS
          ? { model, voice: TTS_VOICE[model], input: 'Hi', response_format: 'wav' }
          : { model, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1 }
      ),
      signal: AbortSignal.timeout(12000),
    });

    const remReq = parseHeader(r.headers, 'x-ratelimit-remaining-requests');
    const remTok = parseHeader(r.headers, 'x-ratelimit-remaining-tokens');
    const limReq = parseHeader(r.headers, 'x-ratelimit-limit-requests');
    const limTok = parseHeader(r.headers, 'x-ratelimit-limit-tokens');

    let usedReq = limReq != null && remReq != null ? limReq - remReq : null;
    let usedTok = null;

    let body = null;
    try { body = await r.json(); } catch {}

    // prefer derived from headers; fall back to usage.total_tokens
    if (limTok != null && remTok != null) usedTok = limTok - remTok;
    else if (body?.usage) usedTok = body.usage.total_tokens ?? null;

    const active = r.status === 200 || r.status === 429;
    const status = r.status === 429 ? 'Limited' : active ? 'Active' : `HTTP ${r.status}`;

    return { masked, model, active, status, usedReq, usedTok, remReq, remTok };
  } catch {
    return { masked, model, active: false, status: 'Error', usedReq: null, usedTok: null, remReq: null, remTok: null };
  }
}

// bounded concurrency pool
async function pool(tasks, onDone, concurrency = CONCURRENCY) {
  let idx = 0;
  const results = [];

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
      onDone(results[i], results.filter(Boolean).length, tasks.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

const fmt = val => val == null ? '—' : val.toLocaleString();

function addRow(res) {
  const cls = res.status === 'Active' ? 'active' : res.status === 'Limited' ? 'limited' : 'dead';
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td class="key-cell">${res.masked}</td>
    <td class="model-cell">${res.model}</td>
    <td><span class="badge ${cls}"><span class="dot"></span>${res.status}</span></td>
    <td class="num ${res.usedReq != null ? 'has-val' : ''}">${fmt(res.usedReq)}</td>
    <td class="num ${res.usedTok != null ? 'has-val' : ''}">${fmt(res.usedTok)}</td>
    <td class="num ${res.remReq  != null ? 'has-val' : ''}">${fmt(res.remReq)}</td>
    <td class="num ${res.remTok  != null ? 'has-val' : ''}">${fmt(res.remTok)}</td>
  `;
  ui.tbody.appendChild(tr);
}

function setProgress(done, total) {
  ui.progFill.style.width = total ? `${(done / total) * 100}%` : '0%';
  ui.progLbl.textContent  = `${done} / ${total}`;
}

function setMsg(text, isError = false) {
  ui.msg.textContent = text;
  ui.msg.className   = isError ? 'error' : '';
}

async function runAudit() {
  const keys = parseKeys(ui.input.value);

  ui.tbody.innerHTML = '';
  ui.summary.classList.add('hidden');
  ui.resWrap.classList.add('hidden');
  ui.progWrap.classList.add('hidden');
  ui.corsNote.classList.add('hidden');
  setMsg('');

  if (!keys.length) {
    setMsg('No valid keys — paste keys starting with gsk_', true);
    return;
  }

  ui.runBtn.disabled = true;
  setMsg('Fetching models…');

  const tasks = [];
  await Promise.all(keys.map(async key => {
    const masked = maskKey(key);
    const models = await getModels(key);
    models.forEach(model => tasks.push(() => testCombo(key, model, masked)));
  }));

  if (!tasks.length) {
    setMsg('No usable models — check your keys.', true);
    ui.runBtn.disabled = false;
    return;
  }

  setMsg('');
  ui.progWrap.classList.remove('hidden');
  ui.resWrap.classList.remove('hidden');
  setProgress(0, tasks.length);

  let activeCount = 0;
  let totalRemTok  = 0;
  let headersWorked = false;

  const results = await pool(tasks, (res, done, total) => {
    addRow(res);
    setProgress(done, total);
    if (res.active) {
      activeCount++;
      if (res.remTok != null) { totalRemTok += res.remTok; headersWorked = true; }
    }
  });

  ui.statAct.textContent  = activeCount;
  ui.statTot.textContent  = results.length;
  ui.statTok.textContent  = headersWorked ? totalRemTok.toLocaleString() : '—';
  ui.statKeys.textContent = keys.length;
  ui.summary.classList.remove('hidden');

  if (!headersWorked) ui.corsNote.classList.remove('hidden');

  ui.progWrap.classList.add('hidden');
  ui.runBtn.disabled = false;
}

// build CSV from current table rows
function buildCSV() {
  const headers = ['Key', 'Model', 'Status', 'Req Used', 'Tokens Used', 'Req Remaining', 'Tokens Remaining'];
  const rows = [...ui.tbody.querySelectorAll('tr')].map(tr => {
    return [...tr.querySelectorAll('td')].map(td => {
      const text = td.textContent.trim();
      return `"${text.replace(/"/g, '""')}"`;
    }).join(',');
  });
  return [headers.join(','), ...rows].join('\n');
}

ui.copyBtn.addEventListener('click', async () => {
  const csv = buildCSV();
  await navigator.clipboard.writeText(csv);
  const orig = ui.copyBtn.textContent;
  ui.copyBtn.textContent = 'Copied!';
  setTimeout(() => { ui.copyBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><rect x="4" y="4" width="8" height="8" rx="1.2" stroke="currentColor" stroke-width="1.3"/><path d="M3 9H2a1 1 0 01-1-1V2a1 1 0 011-1h6a1 1 0 011 1v1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg> Copy CSV`; }, 2000);
});

ui.dlBtn.addEventListener('click', () => {
  const csv = buildCSV();
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `groq-audit-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

ui.runBtn.addEventListener('click', runAudit);

/* ═══════════════════ gemini checker ═══════════════════ */
// Mirrors the Groq audit above: same parseKeys/maskKey/pool helpers, same
// table-driven flow. Only the request shapes differ, since Gemini's API
// is structured differently from Groq's OpenAI-compatible one.

// Gemini's free-tier quota is per-project, shared across every model, so
// blasting 6-wide against a 30+ model catalog just rate-limits the key
// against itself. 2-wide gives a much more honest read of real status.
const GEMINI_CONCURRENCY = 2;

const gUi = {
  input:    $('g-keys-input'),
  runBtn:   $('g-run-btn'),
  progWrap: $('g-progress-wrap'),
  progFill: $('g-progress-fill'),
  progLbl:  $('g-progress-label'),
  summary:  $('g-summary'),
  statAct:  $('g-stat-active'),
  statTot:  $('g-stat-total'),
  statTok:  $('g-stat-tokens'),
  statKeys: $('g-stat-keys'),
  resWrap:  $('g-results-section'),
  tbody:    $('g-results-body'),
  msg:      $('g-msg-area'),
  corsNote: $('g-cors-note'),
  copyBtn:  $('g-copy-btn'),
  dlBtn:    $('g-download-btn'),
};

function parseGeminiKeys(raw) {
  return raw.split('\n')
    .map(s => s.trim())
    .filter(s => s && !s.startsWith('AIzaSyxxxx') && !/^AIzaSyx+$/.test(s));
}

// TTS models need {responseModalities:['AUDIO'], speechConfig} instead of a
// plain text request — always 400s otherwise. Gemma models are a different
// family served off the same endpoint and 500 on maxOutputTokens:1. Lyria is
// music generation, not chat. None of these are testable with a one-line
// text prompt, so they're excluded the same way Groq's embed/whisper are.
const GEMINI_SKIP = /-tts$|-tts-preview$|^gemma|^lyria|lyria-/i;

async function getGeminiModels(key) {
  try {
    const r = await geminiFetch('/v1beta/models', key, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return [];
    const data = await r.json();
    return (data.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => m.name.replace(/^models\//, ''))
      .filter(id => !GEMINI_SKIP.test(id));
  } catch { return []; }
}

async function testGeminiCombo(key, model, masked) {
  try {
    const r = await geminiFetch(`/v1beta/models/${model}:generateContent`, key, {
      method: 'POST',
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
        generationConfig: { maxOutputTokens: 1 },
      }),
      signal: AbortSignal.timeout(20000),
    });

    let body = null;
    try { body = await r.json(); } catch {}

    const usedTok = body?.usageMetadata?.totalTokenCount ?? null;
    const active  = r.status === 200 || r.status === 429;
    const status  = r.status === 429 ? 'Limited' : active ? 'Active' : `HTTP ${r.status}`;

    return { masked, model, active, status, usedTok };
  } catch {
    return { masked, model, active: false, status: 'Error', usedTok: null };
  }
}

function gAddRow(res) {
  const cls = res.status === 'Active' ? 'active' : res.status === 'Limited' ? 'limited' : 'dead';
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td class="key-cell">${res.masked}</td>
    <td class="model-cell">${res.model}</td>
    <td><span class="badge ${cls}"><span class="dot"></span>${res.status}</span></td>
    <td class="num ${res.usedTok != null ? 'has-val' : ''}">${fmt(res.usedTok)}</td>
  `;
  gUi.tbody.appendChild(tr);
}

function gSetProgress(done, total) {
  gUi.progFill.style.width = total ? `${(done / total) * 100}%` : '0%';
  gUi.progLbl.textContent  = `${done} / ${total}`;
}

function gSetMsg(text, isError = false) {
  gUi.msg.textContent = text;
  gUi.msg.className   = isError ? 'error' : '';
}

async function runGeminiAudit() {
  const keys = parseGeminiKeys(gUi.input.value);

  gUi.tbody.innerHTML = '';
  gUi.summary.classList.add('hidden');
  gUi.resWrap.classList.add('hidden');
  gUi.progWrap.classList.add('hidden');
  gUi.corsNote.classList.add('hidden');
  gSetMsg('');

  if (!keys.length) {
    gSetMsg('No valid keys — paste keys starting with AIzaSy', true);
    return;
  }

  gUi.runBtn.disabled = true;
  gSetMsg('Fetching models…');

  const tasks = [];
  await Promise.all(keys.map(async key => {
    const masked = maskKey(key);
    const models = await getGeminiModels(key);
    models.forEach(model => tasks.push(() => testGeminiCombo(key, model, masked)));
  }));

  if (!tasks.length) {
    gSetMsg('No usable models — check your keys.', true);
    gUi.runBtn.disabled = false;
    return;
  }

  gSetMsg('');
  gUi.progWrap.classList.remove('hidden');
  gUi.resWrap.classList.remove('hidden');
  gUi.corsNote.classList.remove('hidden'); // Gemini never exposes quota headers
  gSetProgress(0, tasks.length);

  let activeCount = 0;
  let totalTok = 0;

  const results = await pool(tasks, (res, done, total) => {
    gAddRow(res);
    gSetProgress(done, total);
    if (res.active) {
      activeCount++;
      if (res.usedTok != null) totalTok += res.usedTok;
    }
  }, GEMINI_CONCURRENCY);

  gUi.statAct.textContent  = activeCount;
  gUi.statTot.textContent  = results.length;
  gUi.statTok.textContent  = totalTok.toLocaleString();
  gUi.statKeys.textContent = keys.length;
  gUi.summary.classList.remove('hidden');

  gUi.progWrap.classList.add('hidden');
  gUi.runBtn.disabled = false;
}

function buildGeminiCSV() {
  const headers = ['Key', 'Model', 'Status', 'Tokens Used'];
  const rows = [...gUi.tbody.querySelectorAll('tr')].map(tr => {
    return [...tr.querySelectorAll('td')].map(td => {
      const text = td.textContent.trim();
      return `"${text.replace(/"/g, '""')}"`;
    }).join(',');
  });
  return [headers.join(','), ...rows].join('\n');
}

gUi.copyBtn.addEventListener('click', async () => {
  const csv = buildGeminiCSV();
  await navigator.clipboard.writeText(csv);
  const orig = gUi.copyBtn.textContent;
  gUi.copyBtn.textContent = 'Copied!';
  setTimeout(() => { gUi.copyBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><rect x="4" y="4" width="8" height="8" rx="1.2" stroke="currentColor" stroke-width="1.3"/><path d="M3 9H2a1 1 0 01-1-1V2a1 1 0 011-1h6a1 1 0 011 1v1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg> Copy CSV`; }, 2000);
});

gUi.dlBtn.addEventListener('click', () => {
  const csv = buildGeminiCSV();
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `gemini-audit-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

gUi.runBtn.addEventListener('click', runGeminiAudit);
   const text = td.textContent.trim();
      return `"${text.replace(/"/g, '""')}"`;
    }).join(',');
  });
  return [headers.join(','), ...rows].join('\n');
}

ui.copyBtn.addEventListener('click', async () => {
  const csv = buildCSV();
  await navigator.clipboard.writeText(csv);
  const orig = ui.copyBtn.textContent;
  ui.copyBtn.textContent = 'Copied!';
  setTimeout(() => { ui.copyBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><rect x="4" y="4" width="8" height="8" rx="1.2" stroke="currentColor" stroke-width="1.3"/><path d="M3 9H2a1 1 0 01-1-1V2a1 1 0 011-1h6a1 1 0 011 1v1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg> Copy CSV`; }, 2000);
});

ui.dlBtn.addEventListener('click', () => {
  const csv = buildCSV();
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `groq-audit-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

ui.runBtn.addEventListener('click', runAudit);

/* ═══════════════════ gemini checker ═══════════════════ */
// Mirrors the Groq audit above: same parseKeys/maskKey/pool helpers, same
// table-driven flow. Only the request shapes differ, since Gemini's API
// is structured differently from Groq's OpenAI-compatible one.

const gUi = {
  input:    $('g-keys-input'),
  runBtn:   $('g-run-btn'),
  progWrap: $('g-progress-wrap'),
  progFill: $('g-progress-fill'),
  progLbl:  $('g-progress-label'),
  summary:  $('g-summary'),
  statAct:  $('g-stat-active'),
  statTot:  $('g-stat-total'),
  statTok:  $('g-stat-tokens'),
  statKeys: $('g-stat-keys'),
  resWrap:  $('g-results-section'),
  tbody:    $('g-results-body'),
  msg:      $('g-msg-area'),
  corsNote: $('g-cors-note'),
  copyBtn:  $('g-copy-btn'),
  dlBtn:    $('g-download-btn'),
};

function parseGeminiKeys(raw) {
  return raw.split('\n')
    .map(s => s.trim())
    .filter(s => s && !s.startsWith('AIzaSyxxxx') && !/^AIzaSyx+$/.test(s));
}

async function getGeminiModels(key) {
  try {
    const r = await geminiFetch('/v1beta/models', key, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return [];
    const data = await r.json();
    return (data.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => m.name.replace(/^models\//, ''));
  } catch { return []; }
}

async function testGeminiCombo(key, model, masked) {
  try {
    const r = await geminiFetch(`/v1beta/models/${model}:generateContent`, key, {
      method: 'POST',
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
        generationConfig: { maxOutputTokens: 1 },
      }),
      signal: AbortSignal.timeout(12000),
    });

    let body = null;
    try { body = await r.json(); } catch {}

    const usedTok = body?.usageMetadata?.totalTokenCount ?? null;
    const active  = r.status === 200 || r.status === 429;
    const status  = r.status === 429 ? 'Limited' : active ? 'Active' : `HTTP ${r.status}`;

    return { masked, model, active, status, usedTok };
  } catch {
    return { masked, model, active: false, status: 'Error', usedTok: null };
  }
}

function gAddRow(res) {
  const cls = res.status === 'Active' ? 'active' : res.status === 'Limited' ? 'limited' : 'dead';
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td class="key-cell">${res.masked}</td>
    <td class="model-cell">${res.model}</td>
    <td><span class="badge ${cls}"><span class="dot"></span>${res.status}</span></td>
    <td class="num ${res.usedTok != null ? 'has-val' : ''}">${fmt(res.usedTok)}</td>
  `;
  gUi.tbody.appendChild(tr);
}

function gSetProgress(done, total) {
  gUi.progFill.style.width = total ? `${(done / total) * 100}%` : '0%';
  gUi.progLbl.textContent  = `${done} / ${total}`;
}

function gSetMsg(text, isError = false) {
  gUi.msg.textContent = text;
  gUi.msg.className   = isError ? 'error' : '';
}

async function runGeminiAudit() {
  const keys = parseGeminiKeys(gUi.input.value);

  gUi.tbody.innerHTML = '';
  gUi.summary.classList.add('hidden');
  gUi.resWrap.classList.add('hidden');
  gUi.progWrap.classList.add('hidden');
  gUi.corsNote.classList.add('hidden');
  gSetMsg('');

  if (!keys.length) {
    gSetMsg('No valid keys — paste keys starting with AIzaSy', true);
    return;
  }

  gUi.runBtn.disabled = true;
  gSetMsg('Fetching models…');

  const tasks = [];
  await Promise.all(keys.map(async key => {
    const masked = maskKey(key);
    const models = await getGeminiModels(key);
    models.forEach(model => tasks.push(() => testGeminiCombo(key, model, masked)));
  }));

  if (!tasks.length) {
    gSetMsg('No usable models — check your keys.', true);
    gUi.runBtn.disabled = false;
    return;
  }

  gSetMsg('');
  gUi.progWrap.classList.remove('hidden');
  gUi.resWrap.classList.remove('hidden');
  gUi.corsNote.classList.remove('hidden'); // Gemini never exposes quota headers
  gSetProgress(0, tasks.length);

  let activeCount = 0;
  let totalTok = 0;

  const results = await pool(tasks, (res, done, total) => {
    gAddRow(res);
    gSetProgress(done, total);
    if (res.active) {
      activeCount++;
      if (res.usedTok != null) totalTok += res.usedTok;
    }
  });

  gUi.statAct.textContent  = activeCount;
  gUi.statTot.textContent  = results.length;
  gUi.statTok.textContent  = totalTok.toLocaleString();
  gUi.statKeys.textContent = keys.length;
  gUi.summary.classList.remove('hidden');

  gUi.progWrap.classList.add('hidden');
  gUi.runBtn.disabled = false;
}

function buildGeminiCSV() {
  const headers = ['Key', 'Model', 'Status', 'Tokens Used'];
  const rows = [...gUi.tbody.querySelectorAll('tr')].map(tr => {
    return [...tr.querySelectorAll('td')].map(td => {
      const text = td.textContent.trim();
      return `"${text.replace(/"/g, '""')}"`;
    }).join(',');
  });
  return [headers.join(','), ...rows].join('\n');
}

gUi.copyBtn.addEventListener('click', async () => {
  const csv = buildGeminiCSV();
  await navigator.clipboard.writeText(csv);
  const orig = gUi.copyBtn.textContent;
  gUi.copyBtn.textContent = 'Copied!';
  setTimeout(() => { gUi.copyBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><rect x="4" y="4" width="8" height="8" rx="1.2" stroke="currentColor" stroke-width="1.3"/><path d="M3 9H2a1 1 0 01-1-1V2a1 1 0 011-1h6a1 1 0 011 1v1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg> Copy CSV`; }, 2000);
});

gUi.dlBtn.addEventListener('click', () => {
  const csv = buildGeminiCSV();
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `gemini-audit-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

gUi.runBtn.addEventListener('click', runGeminiAudit);
          
