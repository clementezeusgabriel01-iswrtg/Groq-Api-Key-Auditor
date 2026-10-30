const CONCURRENCY = 6;
const $ = id => document.getElementById(id);

const ui = {
  input:     $('keys-input'),
  runBtn:    $('run-btn'),
  progWrap:  $('progress-wrap'),
  progFill:  $('progress-fill'),
  progLbl:   $('progress-label'),
  summary:   $('summary'),
  statAct:   $('stat-active'),
  statTot:   $('stat-total'),
  statTok:   $('stat-tokens'),
  statKeys:  $('stat-keys'),
  resWrap:   $('results-section'),
  tbody:     $('results-body'),
  msg:       $('msg-area'),
  corsNote:  $('cors-note'),
};

function parseKeys(raw) {
  return raw.split('\n')
    .map(s => s.trim())
    .filter(s => s && !s.startsWith('gsk_your_'));
}

function maskKey(key) {
  return key.length > 9 ? `${key.slice(0, 6)}...${key.slice(-4)}` : 'INVALID';
}

// parse an integer header, return null if missing or non-numeric
function parseHeader(headers, name) {
  const val = headers.get(name);
  if (!val) return null;
  const n = parseInt(val, 10);
  return isNaN(n) ? null : n;
}

async function getModels(key) {
  try {
    const r = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return [];
    const data = await r.json();
    return (data.data || [])
      .map(m => m.id)
      .filter(id => !id.includes('embed') && !id.includes('whisper'));
  } catch { return []; }
}

async function testCombo(key, model, masked) {
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(12000),
    });

    // try headers first (exposed in some CORS configs)
    let remReq = parseHeader(r.headers, 'x-ratelimit-remaining-requests');
    let remTok = parseHeader(r.headers, 'x-ratelimit-remaining-tokens');
    let limReq = parseHeader(r.headers, 'x-ratelimit-limit-requests');
    let limTok = parseHeader(r.headers, 'x-ratelimit-limit-tokens');

    let usedReq = null;
    let usedTok = null;

    // parse body regardless — gives us usage tokens and may fill gaps
    let body = null;
    try { body = await r.json(); } catch { /* non-json */ }

    if (body?.usage) {
      usedTok = body.usage.total_tokens ?? null;
      // if header gave us limit+remaining, derive used from that
      if (limTok != null && remTok != null) usedTok = limTok - remTok;
      if (limReq != null && remReq != null) usedReq = limReq - remReq;
    }

    const active = r.status === 200 || r.status === 429;
    const status = r.status === 429 ? 'Limited' : active ? 'Active' : `HTTP ${r.status}`;

    return {
      masked, model, active, status,
      usedReq, usedTok,
      remReq, remTok,
    };
  } catch {
    return { masked, model, active: false, status: 'Error', usedReq: null, usedTok: null, remReq: null, remTok: null };
  }
}

// run tasks with bounded concurrency
async function pool(tasks, onDone) {
  let idx = 0;
  const results = [];

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
      onDone(results[i], results.filter(Boolean).length, tasks.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, worker));
  return results;
}

function fmt(val) {
  // show dash if value is null (unavailable), else format number
  return val == null ? '—' : val.toLocaleString();
}

function addRow(res) {
  const cls = res.status === 'Active' ? 'active' : res.status === 'Limited' ? 'limited' : 'dead';
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td class="key-cell">${res.masked}</td>
    <td class="model-cell">${res.model}</td>
    <td><span class="badge ${cls}"><span class="dot"></span>${res.status}</span></td>
    <td class="num ${res.usedReq != null ? 'has-val' : ''}">${fmt(res.usedReq)}</td>
    <td class="num ${res.usedTok != null ? 'has-val' : ''}">${fmt(res.usedTok)}</td>
    <td class="num ${res.remReq != null ? 'has-val' : ''}">${fmt(res.remReq)}</td>
    <td class="num ${res.remTok != null ? 'has-val' : ''}">${fmt(res.remTok)}</td>
  `;
  ui.tbody.appendChild(tr);
}

function setProgress(done, total) {
  const pct = total ? (done / total) * 100 : 0;
  ui.progFill.style.width = `${pct}%`;
  ui.progLbl.textContent = `${done} / ${total}`;
}

function setMsg(text, isError = false) {
  ui.msg.textContent = text;
  ui.msg.className = isError ? 'error' : '';
}

async function runAudit() {
  const keys = parseKeys(ui.input.value);

  // reset
  ui.tbody.innerHTML = '';
  ui.summary.classList.add('hidden');
  ui.resWrap.classList.add('hidden');
  ui.progWrap.classList.add('hidden');
  ui.corsNote.classList.add('hidden');
  setMsg('');

  if (!keys.length) {
    setMsg('No valid keys found — paste keys starting with gsk_', true);
    return;
  }

  ui.runBtn.disabled = true;
  setMsg('Fetching available models…');

  // discover all key → model combos
  const tasks = [];
  await Promise.all(keys.map(async key => {
    const masked = maskKey(key);
    const models = await getModels(key);
    models.forEach(model => tasks.push(() => testCombo(key, model, masked)));
  }));

  if (!tasks.length) {
    setMsg('No usable models found — check your keys.', true);
    ui.runBtn.disabled = false;
    return;
  }

  setMsg('');
  ui.progWrap.classList.remove('hidden');
  ui.resWrap.classList.remove('hidden');
  setProgress(0, tasks.length);

  let activeCount = 0;
  let totalRemTok = 0;
  let headersWorked = false;

  const results = await pool(tasks, (res, done, total) => {
    addRow(res);
    setProgress(done, total);
    if (res.active) {
      activeCount++;
      if (res.remTok != null) { totalRemTok += res.remTok; headersWorked = true; }
    }
  });

  // summary
  ui.statAct.textContent   = activeCount;
  ui.statTot.textContent   = results.length;
  ui.statTok.textContent   = headersWorked ? totalRemTok.toLocaleString() : '—';
  ui.statKeys.textContent  = keys.length;
  ui.summary.classList.remove('hidden');

  if (!headersWorked) ui.corsNote.classList.remove('hidden');

  ui.progWrap.classList.add('hidden');
  ui.runBtn.disabled = false;
}

ui.runBtn.addEventListener('click', runAudit);
