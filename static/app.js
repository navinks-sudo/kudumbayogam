// ============================================================
// Heritage Vault frontend
// ============================================================
const $ = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];
const tpl = id => document.getElementById(id).content.firstElementChild.cloneNode(true);
const tplAll = id => [...document.getElementById(id).content.children].map(c => c.cloneNode(true));

const state = {
  books: [],
  filter: 'all',
  search: '',
  view: 'home',
  current: null,        // current book object on detail view
  currentPage: 1,
  pageData: null,       // page object for current page
  chatHistory: [],      // [{role,content}]
  people: null,         // {people, relationships}
  treeMode: 'force',
};

// ----------------- helpers -----------------
const fmtBytes = n => {
  if (!n) return '—';
  const u = ['B','KB','MB','GB']; let i=0;
  while (n>=1024 && i<u.length-1) { n/=1024; i++; }
  return n.toFixed(n<10?1:0)+' '+u[i];
};
const escapeHtml = s => (s||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const statusLabel = s => ({idle:'Idle',queued:'Queued',downloading:'Downloading',building:'Binding',done:'Bound',error:'Error',stopped:'Stopped',running:'Running',partial:'Partial'})[s]||s;
const stageLabel = (key, status) => {
  if (status === 'idle') return 'Not started';
  if (status === 'running') return 'Running…';
  if (status === 'done') return 'Complete';
  if (status === 'partial') return 'Partial';
  if (status === 'error') return 'Error';
  return status;
};

async function api(path, opts={}) {
  const r = await fetch(path, opts);
  if (!r.ok) {
    const t = await r.text();
    throw new Error(t || r.statusText);
  }
  const ct = r.headers.get('content-type') || '';
  return ct.includes('json') ? r.json() : r.text();
}
async function postJSON(path, body) {
  return api(path, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body||{})});
}

// ============================================================
// Router
// ============================================================
function route() {
  const h = location.hash || '#/';
  const m = h.match(/^#\/book\/(\d+)/);
  if (m) {
    const bid = parseInt(m[1]);
    state.current = state.books.find(b => b.id === bid);
    if (state.current) renderBook(); else renderHome();
  } else {
    state.view = 'home';
    renderHome();
  }
}
window.addEventListener('hashchange', route);

// ============================================================
// Catalogue view (home)
// ============================================================
function renderHome() {
  state.view = 'home';
  const root = $('#app');
  root.innerHTML = '';
  root.appendChild(tpl('tpl-home'));
  refreshHomeStats();
  renderGrid();

  $('#b-start').onclick = async () => {
    $('#b-start').disabled = true; $('#b-stop').disabled = false;
    try { await postJSON('/api/start'); } catch (e) { alert(e); }
  };
  $('#b-stop').onclick = async () => {
    $('#b-stop').disabled = true;
    try { await postJSON('/api/stop'); } catch (e) {}
  };
  $$('.pill').forEach(p => p.onclick = () => {
    $$('.pill').forEach(x => x.classList.remove('active'));
    p.classList.add('active');
    state.filter = p.dataset.f; renderGrid();
  });
  $('#search').oninput = e => { state.search = e.target.value; renderGrid(); };
  $('#search').value = state.search;
  $$('.pill').forEach(p => p.classList.toggle('active', p.dataset.f === state.filter));
}

function refreshHomeStats() {
  if (state.view !== 'home') return;
  const totalPages = state.books.reduce((a,b)=>a+(b.pages||0),0);
  const done = state.books.filter(b => b.status==='done').length;
  const ocrd = state.books.filter(b => b.ocr_status==='done').length;
  const downloaded = state.books.reduce((a,b)=>a+(b.status==='done'?b.pages:(b.downloaded||0)),0);
  const set = (id, v) => { const e = $('#'+id); if (e) e.textContent = v; };
  set('s-books', state.books.length);
  set('s-pages', totalPages.toLocaleString());
  set('s-done', done);
  set('s-ocr', ocrd);
  set('p-cur', downloaded.toLocaleString());
  set('p-tot', totalPages.toLocaleString());
  const fill = $('#megafill');
  if (fill) fill.style.width = (totalPages ? downloaded*100/totalPages : 0) + '%';
}

function bookCardEl(b) {
  const card = tpl('tpl-card');
  card.classList.add(b.status);
  card.dataset.id = b.id;
  $('.card-title', card).textContent = b.title;
  $('.meta', card).textContent = `${b.pages} pages · #${b.id}`;
  const statusEl = $('.status', card);
  statusEl.classList.add(b.status);
  statusEl.textContent = statusLabel(b.status);

  const isDone = b.status === 'done';
  const pct = b.pages ? Math.round(b.downloaded*100/b.pages) : 0;
  $('.progress .num', card).innerHTML =
    `<span>${isDone?'Bound':'Pages downloaded'}</span>
     <span><b>${b.downloaded}</b> / ${b.pages}${isDone&&b.pdf_size?' · '+fmtBytes(b.pdf_size):''}</span>`;
  $('.bar > div', card).style.width = (isDone?100:pct)+'%';

  // pipeline-mini chips
  const pipe = $('.pipeline-mini', card);
  pipe.innerHTML = '';
  const chips = [
    ['PDF', b.status],
    ['OCR', b.ocr_status],
    ['Vector', b.ingest_status],
    ['People', b.extract_status],
  ];
  for (const [label, st] of chips) {
    const c = document.createElement('span');
    c.className = 'pchip ' + (st || 'idle');
    c.textContent = label;
    c.title = `${label}: ${stageLabel(label, st)}`;
    pipe.appendChild(c);
  }

  const acts = $('.card-actions', card);
  // pipeline fully complete when extract is done (or LLM unavailable and ingest is done)
  const pipelineDone = b.status === 'done' && b.ocr_status === 'done' &&
                        b.ingest_status === 'done' &&
                        (b.extract_status === 'done' || !state.health?.llm_available);
  const inFlight = ['downloading','building','queued','running'].includes(b.status) ||
                    b.ocr_status === 'running' || b.ingest_status === 'running' || b.extract_status === 'running';
  if (pipelineDone) {
    acts.innerHTML = `
      <a class="btn-sm open" href="#/book/${b.id}">⌬ Open</a>
      <a class="btn-sm dl" href="/pdfs/${b.slug}.pdf" download>↓ PDF</a>`;
  } else {
    acts.innerHTML = `
      <a class="btn-sm open" href="#/book/${b.id}">⌬ Open</a>
      <button class="btn-sm go" data-act="process" ${inFlight?'disabled':''}>▶ Process</button>`;
    acts.querySelector('[data-act="process"]')?.addEventListener('click', async () => {
      try { await postJSON(`/api/book/${b.id}/process`); } catch (e) { alert(e); }
    });
  }
  if (b.error) {
    const err = document.createElement('div');
    err.className = 'err'; err.textContent = b.error;
    card.appendChild(err);
  }
  return card;
}

function renderGrid() {
  if (state.view !== 'home') return;
  const grid = $('#grid');
  if (!grid) return;
  const term = state.search.trim().toLowerCase();
  const list = state.books.filter(b => {
    if (state.filter === 'ocrd' && b.ocr_status !== 'done') return false;
    if (['idle','done','error'].includes(state.filter) && b.status !== state.filter) return false;
    if (state.filter === 'downloading' && !['downloading','building','queued'].includes(b.status)) return false;
    if (term && !b.title.toLowerCase().includes(term)) return false;
    return true;
  });
  grid.innerHTML = '';
  if (!list.length) {
    grid.innerHTML = '<div class="empty-state">No books match this filter.</div>';
    return;
  }
  for (const b of list) grid.appendChild(bookCardEl(b));
  refreshHomeStats();
}

function patchBookInGrid(b) {
  if (state.view !== 'home') return;
  const card = $(`.card[data-id="${b.id}"]`);
  if (!card) { renderGrid(); return; }
  const fresh = bookCardEl(b);
  card.replaceWith(fresh);
  refreshHomeStats();
}

// ============================================================
// Book detail view
// ============================================================
function renderBook() {
  state.view = 'book';
  const root = $('#app');
  root.innerHTML = '';
  root.appendChild(tpl('tpl-book'));

  const b = state.current;
  $('#bk-title').textContent = b.title;
  $('#bk-meta').textContent = `${b.pages.toLocaleString()} pages · #${b.id}`;

  // cover from page 1
  $('#bk-cover').style.backgroundImage = `url('/cache/${b.slug}/1.jpg')`;

  // pipeline
  renderPipeline();

  // tabs
  $$('.tab').forEach(t => t.onclick = () => {
    $$('.tab').forEach(x => x.classList.remove('active'));
    $$('.tab-pane').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    $(`.tab-pane[data-pane="${t.dataset.tab}"]`).classList.add('active');
    if (t.dataset.tab === 'insights') loadInsights();
    if (t.dataset.tab === 'people') loadPeople();
    if (t.dataset.tab === 'tree') loadPeople(true);
  });

  initPagesTab();
  initChatTab();
  initPeopleTab();
  initTreeTab();
  loadInsights(); // default tab
}

function renderPipeline() {
  const b = state.current;
  if (!b) return;
  const wrap = $('#pipeline');
  if (!wrap) return;
  const cachedMark = '✓ cached · ';
  const pdfFmt = b.status === 'done'
    ? `${cachedMark}${b.pages} pages`
    : `${b.downloaded}/${b.pages} pages`;
  const ocrFmt = b.ocr_status === 'done'
    ? `${cachedMark}${b.ocr_done} pages`
    : `${b.ocr_done}/${b.pages} pages`;
  const ingestFmt = b.ingest_status === 'running'
    ? `${b.ingest_pages_done||0}/${b.pages} pages · ${b.ingest_chunks||0} chunks`
    : b.ingest_status === 'done'
      ? `${cachedMark}${b.ingest_chunks} chunks`
      : `${b.ingest_chunks||0} chunks`;
  const extractFmt = b.extract_status === 'running'
    ? `${b.extract_pages_done||0}/${b.pages} pages · ${b.extract_people||0} people`
    : b.extract_status === 'done'
      ? `${cachedMark}${b.extract_people} people`
      : `${b.extract_people||0} people`;

  const stages = [
    {key:'pdf', label:'PDF', state: b.status, value: pdfFmt,
     action: b.status==='done' ? null : 'Bind',
     endpoint:'/api/start', body: {ids:[b.id]},
     pct: b.pages ? b.downloaded/b.pages : 0},
    {key:'ocr', label:'OCR', state: b.ocr_status, value: ocrFmt,
     action: b.status==='done' ? (b.ocr_status==='done'?'Re-OCR':'Run OCR') : null,
     endpoint:`/api/book/${b.id}/ocr`, body: {},
     pct: b.pages ? b.ocr_done/b.pages : 0,
     disabled: b.status !== 'done'},
    {key:'ingest', label:'Vector index', state: b.ingest_status, value: ingestFmt,
     action: b.ocr_done>0 ? (b.ingest_status==='done'?'Re-index':'Index') : null,
     endpoint:`/api/book/${b.id}/ingest`, body: {},
     pct: b.ingest_status==='done' ? 1 : (b.pages ? (b.ingest_pages_done||0)/b.pages : 0),
     disabled: b.ocr_done === 0},
    {key:'extract', label:'People', state: b.extract_status, value: extractFmt,
     action: b.ocr_done>0 ? (b.extract_status==='done'?'Re-extract':'Extract') : null,
     endpoint:`/api/book/${b.id}/extract`, body: {},
     pct: b.extract_status==='done' ? 1 : (b.pages ? (b.extract_pages_done||0)/b.pages : 0),
     disabled: b.ocr_done === 0},
  ];
  wrap.innerHTML = '';
  for (const s of stages) {
    const el = document.createElement('div');
    el.className = 'stage ' + (s.state || 'idle');
    el.style.setProperty('--p', Math.min(1, s.pct||0));
    el.innerHTML = `
      <span class="stage-label">${s.label}</span>
      <div class="stage-row">
        <span class="stage-state">${s.value}</span>
        ${s.action ? `<button class="stage-action" ${s.disabled?'disabled':''} data-ep="${s.endpoint}">${s.action}</button>` : ''}
      </div>`;
    wrap.appendChild(el);
  }
  $$('.stage-action', wrap).forEach((btn, i) => {
    const s = stages.filter(x => x.action)[i];
    if (!s) return;
    btn.onclick = async () => {
      btn.disabled = true;
      try { await postJSON(s.endpoint, s.body || {}); }
      catch (e) { alert(e.message || e); btn.disabled = false; }
    };
  });

  // Export row — appears once people.json exists
  let exportRow = $('#export-row');
  if (b.extract_status === 'done' && b.extract_people > 0) {
    if (!exportRow) {
      exportRow = document.createElement('div');
      exportRow.id = 'export-row';
      exportRow.className = 'export-row';
      wrap.parentElement.appendChild(exportRow);
    }
    exportRow.innerHTML = `
      <span class="crest" style="font-size:10px;letter-spacing:.22em">Open Genealogy Export</span>
      <div class="export-actions">
        <a class="btn-sm dl" href="/api/book/${b.id}/gedcomx?download=1" download>↓ GedcomX (.json)</a>
        <a class="btn-sm" href="/api/book/${b.id}/gedcomx" target="_blank">↗ View raw</a>
        <span class="dim">${b.extract_people} persons · interoperable with FamilySearch, Gramps, RootsMagic</span>
      </div>`;
  } else if (exportRow) {
    exportRow.remove();
  }
}

// ----- Pages tab -----
function refreshOcrActionBar() {
  const b = state.current;
  if (!b) return;
  const btn = $('#ocr-all-btn'); if (!btn) return;
  const prog = $('#ocr-progress');
  const lbl = $('.ocr-label', btn);
  const icon = $('.ocr-icon', btn);
  const isRunning = b.ocr_status === 'running';
  const isDone = b.ocr_status === 'done';
  if (isRunning) {
    btn.disabled = true;
    icon.textContent = '⟳';
    icon.classList.add('spin');
    lbl.textContent = `Extracting… ${b.ocr_done}/${b.pages} pages`;
    if (prog) prog.style.setProperty('--p', (b.ocr_done / Math.max(b.pages, 1) * 100) + '%');
  } else if (isDone) {
    btn.disabled = b.status !== 'done';
    icon.textContent = '↻';
    icon.classList.remove('spin');
    lbl.textContent = `Re-extract OCR for all ${b.pages} pages`;
    if (prog) prog.style.setProperty('--p', '100%');
  } else if (b.status !== 'done') {
    btn.disabled = true;
    icon.textContent = '⚠';
    icon.classList.remove('spin');
    lbl.textContent = 'Bind PDF first, then OCR';
    if (prog) prog.style.setProperty('--p', '0%');
  } else {
    btn.disabled = false;
    icon.textContent = '⚡';
    icon.classList.remove('spin');
    lbl.textContent = `Extract OCR for all ${b.pages} pages`;
    if (prog) prog.style.setProperty('--p', '0%');
  }
}

function initPagesTab() {
  const b = state.current;
  // wire one-click OCR button
  $('#ocr-all-btn').onclick = async () => {
    try { await postJSON(`/api/book/${b.id}/ocr`); }
    catch (e) { alert(e.message || e); }
  };
  refreshOcrActionBar();
  initOcrSearch();
  // build thumbnails (just numbers, fast)
  const rail = $('#page-rail');
  rail.innerHTML = '';
  for (let n=1; n<=b.pages; n++) {
    const t = document.createElement('div');
    t.className = 'thumb';
    t.innerHTML = `<span class="dot"></span><span>Page ${n}</span>`;
    t.onclick = () => loadPage(n);
    rail.appendChild(t);
  }
  $('#prev-page').onclick = () => loadPage(Math.max(1, state.currentPage - 1));
  $('#next-page').onclick = () => loadPage(Math.min(b.pages, state.currentPage + 1));
  $('#translate-target').onchange = e => translateCurrentPage(e.target.value);
  $('#reocr-btn').onclick = async () => {
    const n = state.currentPage;
    const btn = $('#reocr-btn');
    btn.disabled = true; const orig = btn.textContent; btn.textContent = '⟳ running…';
    try {
      const r = await postJSON(`/api/book/${b.id}/page/${n}/reocr`);
      $('#reader-text').textContent = '(reloading…)';
      await loadPage(n);
      btn.textContent = `✓ ${r.engine || 'done'}`;
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2200);
    } catch (e) {
      alert('Re-OCR failed: ' + (e.message || e));
      btn.textContent = orig; btn.disabled = false;
    }
  };
  loadPage(1);
}

// ===========================
// OCR Search (Pages tab)
// ===========================
function initOcrSearch() {
  state.ocrSearch = { term: '', mode: 'hybrid', results: [], pages: new Set() };
  const input = $('#ocr-search-input');
  const stats = $('#ocr-search-stats');
  const clear = $('#ocr-search-clear');
  let debounce;
  input.oninput = e => {
    clearTimeout(debounce);
    debounce = setTimeout(() => runOcrSearch(e.target.value), 250);
  };
  input.onkeydown = e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.shiftKey ? jumpToOcrMatch(-1) : jumpToOcrMatch(+1);
    } else if (e.key === 'Escape') {
      e.preventDefault(); clearOcrSearch();
    }
  };
  clear.onclick = clearOcrSearch;
  $$('.ocr-mode').forEach(btn => btn.onclick = () => {
    $$('.ocr-mode').forEach(x => x.classList.remove('active'));
    btn.classList.add('active');
    state.ocrSearch.mode = btn.dataset.mode;
    if (state.ocrSearch.term) runOcrSearch(state.ocrSearch.term);
  });
  $('#ocr-prev-match').onclick = () => jumpToOcrMatch(-1);
  $('#ocr-next-match').onclick = () => jumpToOcrMatch(+1);
}

function clearOcrSearch() {
  state.ocrSearch = { term: '', mode: state.ocrSearch?.mode || 'hybrid', results: [], pages: new Set() };
  $('#ocr-search-input').value = '';
  $('#ocr-search-stats').textContent = '';
  $('#ocr-search-results').innerHTML = '';
  $('#ocr-search-results').classList.remove('show');
  $('#ocr-search-nav').classList.remove('show');
  document.body.classList.remove('ocr-searching');
  // un-filter rail
  $$('#page-rail .thumb').forEach(t => t.classList.remove('hidden','match'));
  // re-render current page to drop highlights
  if (state.currentPage) renderReaderText(state.pageData?.text || '');
}

async function runOcrSearch(term) {
  term = (term || '').trim();
  state.ocrSearch.term = term;
  const stats = $('#ocr-search-stats');
  const results = $('#ocr-search-results');
  if (!term) { clearOcrSearch(); return; }
  document.body.classList.add('ocr-searching');
  stats.textContent = 'searching…';
  const b = state.current;
  try {
    const r = await api(`/api/book/${b.id}/search?q=${encodeURIComponent(term)}&mode=${state.ocrSearch.mode}`);
    state.ocrSearch.results = r.results || [];
    state.ocrSearch.pages = new Set(state.ocrSearch.results.map(x => x.page));
    renderOcrSearch(r);
  } catch (e) {
    stats.textContent = 'error';
    results.innerHTML = `<div class="empty-state">${escapeHtml(e.message || e)}</div>`;
  }
}

function renderOcrSearch(r) {
  const stats = $('#ocr-search-stats');
  const results = $('#ocr-search-results');
  const nav = $('#ocr-search-nav');
  if (!r.results.length) {
    stats.textContent = '0 pages';
    results.classList.add('show');
    results.innerHTML = `<div class="empty-state">No pages match "<b>${escapeHtml(r.query)}</b>"</div>`;
    nav.classList.remove('show');
    return;
  }
  const lex = r.lexical_count, sem = r.semantic_count;
  stats.innerHTML = `<b>${r.total}</b> page${r.total===1?'':'s'} · ` +
                    (lex ? `<span class="src-lexical">${lex} exact</span>` : '') +
                    (lex && sem ? ' · ' : '') +
                    (sem ? `<span class="src-semantic">${sem} related</span>` : '');
  // filter rail
  $$('#page-rail .thumb').forEach((t, i) => {
    const p = i + 1;
    if (state.ocrSearch.pages.has(p)) t.classList.remove('hidden');
    else t.classList.add('hidden');
  });
  // result cards
  results.classList.add('show');
  results.innerHTML = r.results.map(res => {
    const snippetsHtml = res.snippets.map(s => {
      const before = escapeHtml(s.before).slice(-80);
      const match = escapeHtml(s.match);
      const after = escapeHtml(s.after).slice(0, 100);
      return `<div class="osr-snip">${before}<mark>${match}</mark>${after}</div>`;
    }).join('');
    return `<div class="osr" data-page="${res.page}" data-src="${res.src}">
      <div class="osr-head">
        <span class="osr-pg">p.${res.page}</span>
        <span class="osr-meta ${res.src}">
          ${res.src === 'lexical' ? `${res.match_count} match${res.match_count===1?'':'es'}` : 'semantic match'}
        </span>
      </div>
      ${snippetsHtml || '<div class="osr-snip dim">(semantic relevance — no exact hit)</div>'}
    </div>`;
  }).join('');
  $$('.osr', results).forEach(el => el.onclick = () => {
    const p = parseInt(el.dataset.page);
    loadPage(p);
  });
  nav.classList.add('show');
  $('#ocr-match-pos').textContent = `1 / ${r.total}`;
  // auto-jump to the top result
  if (r.results[0]) loadPage(r.results[0].page);
}

function jumpToOcrMatch(delta) {
  const list = state.ocrSearch.results;
  if (!list.length) return;
  const cur = list.findIndex(r => r.page === state.currentPage);
  let next = cur < 0 ? 0 : (cur + delta);
  if (next < 0) next = list.length - 1;
  if (next >= list.length) next = 0;
  const target = list[next];
  loadPage(target.page);
  $('#ocr-match-pos').textContent = `${next+1} / ${list.length}`;
}

function highlightInText(text, term) {
  if (!term) return escapeHtml(text);
  const safe = escapeHtml(text);
  // case-insensitive replace, preserve original casing in match
  try {
    const re = new RegExp('(' + term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + ')', 'gi');
    return safe.replace(re, '<mark>$1</mark>');
  } catch { return safe; }
}

function renderReaderText(text) {
  const target = $('#reader-text');
  if (!target) return;
  const term = state.ocrSearch?.term;
  if (term && text) {
    target.innerHTML = highlightInText(text, term);
    target.classList.add('has-marks');
  } else {
    target.textContent = text || '';
    target.classList.remove('has-marks');
  }
}

async function loadPage(n) {
  const b = state.current;
  if (!b || n < 1 || n > b.pages) return;
  state.currentPage = n;
  $$('#page-rail .thumb').forEach((t, i) => t.classList.toggle('active', (i+1)===n));
  $('#page-num').textContent = `Page ${n} / ${b.pages}`;
  $('#reader-img').src = `/cache/${b.slug}/${n}.jpg`;
  $('#reader-text').textContent = '(loading…)';
  $('#translation-block').classList.add('hidden');
  $('#translate-target').value = '';
  // scroll active thumb into view
  const active = $$('#page-rail .thumb')[n-1];
  if (active) active.scrollIntoView({block:'nearest'});

  try {
    const data = await api(`/api/book/${b.id}/page/${n}`);
    state.pageData = data;
    const txt = $('#reader-text');
    if (data.text) {
      renderReaderText(data.text);
      $('#translate-target').disabled = false;
    } else {
      txt.innerHTML = '';
      const empty = document.createElement('div');
      empty.className = 'reader-empty';
      const ocrSt = b.ocr_status;
      if (ocrSt === 'running') {
        empty.innerHTML = `
          <div class="empty-mark spin">◐</div>
          <h4>Running OCR for this book…</h4>
          <p class="dim"><b>${b.ocr_done}</b> / ${b.pages} pages processed. This page will appear once it's reached.</p>
          <div class="bar" style="margin-top:14px"><div style="width:${b.pages?Math.round(b.ocr_done*100/b.pages):0}%"></div></div>`;
      } else if (b.status !== 'done') {
        empty.innerHTML = `
          <div class="empty-mark">⊙</div>
          <h4>The book hasn't been bound yet</h4>
          <p class="dim">Bind the PDF first (download all pages from knanayology.org), then run OCR.</p>
          <button class="btn primary" id="empty-bind">▶ Bind this book</button>`;
      } else {
        empty.innerHTML = `
          <div class="empty-mark">✦</div>
          <h4>OCR not run yet</h4>
          <p class="dim">Press the button to extract text from all <b>${b.pages}</b> pages
          (Malayalam · Hindi · Tamil · English supported). Estimated ~${Math.ceil(b.pages*1.5/60)} min.</p>
          <button class="btn primary" id="empty-ocr">⚡ Run OCR for this book</button>`;
      }
      txt.appendChild(empty);
      $('#empty-ocr')?.addEventListener('click', async () => {
        const btn = $('#empty-ocr'); btn.disabled = true; btn.textContent = 'Starting…';
        try { await postJSON(`/api/book/${b.id}/ocr`); } catch(e) { alert(e.message||e); btn.disabled = false; }
      });
      $('#empty-bind')?.addEventListener('click', async () => {
        const btn = $('#empty-bind'); btn.disabled = true; btn.textContent = 'Starting…';
        try { await postJSON('/api/start', {ids:[b.id]}); } catch(e) { alert(e.message||e); btn.disabled = false; }
      });
      $('#translate-target').disabled = true;
    }
    const lp = $('#page-lang');
    lp.textContent = (data.lang || 'unk').toUpperCase();
    // tag thumb with language for color hint
    const t = $$('#page-rail .thumb')[n-1];
    if (t) {
      t.classList.toggle('has-text', !!data.text);
      ['mal','hin','tam','eng','unk'].forEach(l => t.classList.remove('lang-'+l));
      t.classList.add('lang-' + (data.lang || 'unk'));
    }
  } catch (e) {
    $('#reader-text').textContent = '(failed to load: '+e.message+')';
  }
}

async function translateCurrentPage(target) {
  if (!target || !state.pageData?.text) return;
  $('#translation-block').classList.remove('hidden');
  $('#translation-h').textContent = `Translation → ${target}`;
  $('#translation-text').textContent = 'Translating…';
  try {
    const r = await postJSON('/api/translate', {text: state.pageData.text, target});
    $('#translation-text').textContent = r.translation;
  } catch (e) {
    $('#translation-text').textContent = 'Failed: ' + (e.message || e);
  }
}

// ----- Chat tab -----
const CHAT_LS_KEY = b => `chat_history_v2_${b.slug}`;

function loadChatHistory(b) {
  try { return JSON.parse(localStorage.getItem(CHAT_LS_KEY(b)) || '[]'); }
  catch { return []; }
}
function saveChatHistory(b, h) {
  try { localStorage.setItem(CHAT_LS_KEY(b), JSON.stringify(h.slice(-40))); }
  catch {}
}

function initChatTab() {
  const b = state.current;
  state.chatHistory = loadChatHistory(b);
  const stateEl = $('#chat-state');
  let label = b.ingest_chunks > 0 ? `${b.ingest_chunks} chunks · ${state.health?.embed_engine || '?'} embed` : 'Index the book first';
  if (state.health?.llm_available) label += ` · ${state.health.llm_provider}`;
  else label += ' · ⚠ no LLM key';
  stateEl.textContent = label;
  $('#chat-form').onsubmit = e => { e.preventDefault(); sendChat(); };

  // restore previous conversation
  const stream = $('#chat-stream');
  if (state.chatHistory.length) {
    $('.empty-chat', stream)?.remove();
    for (const m of state.chatHistory) {
      const bub = document.createElement('div');
      bub.className = `bubble ${m.role === 'user' ? 'user' : 'bot'}`;
      if (m.role === 'user') bub.textContent = m.content;
      else {
        const pages = new Set((m.sources || []).map(s => s.page));
        bub.innerHTML = renderRichAnswer(m.content, pages.size ? pages : null);
        // re-bind click handlers
        $$('.cite', bub).forEach(el => {
          const pg = parseInt(el.dataset.page);
          el.onclick = () => { $('.tab[data-tab="pages"]').click(); loadPage(pg); };
        });
      }
      stream.appendChild(bub);
    }
    stream.scrollTop = stream.scrollHeight;
  }

  // clear-history button
  const clr = $('#chat-clear');
  if (clr) clr.onclick = () => {
    state.chatHistory = []; saveChatHistory(b, []);
    stream.innerHTML = `<div class="empty-chat">
      <div class="empty-mark">✦</div>
      <h4>Start a fresh conversation</h4>
      <p>This book is indexed with <b>${state.health?.embed_engine || '?'}</b> embeddings.
         Try one of the auto-suggested questions from the <b>Insights</b> tab.</p>
    </div>`;
  };
}

let _citePop = null;
function showCitePreview(anchor, page, snippet) {
  hideCitePreview();
  const pop = document.createElement('div');
  pop.className = 'cite-popover';
  pop.innerHTML = `<div class="cp-head">Page ${page}</div>
    <div class="cp-snip">${escapeHtml(snippet.slice(0, 360))}…</div>
    <div class="cp-foot">Click to open the page reader</div>`;
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(window.innerWidth - 360, r.left - 12)) + 'px';
  pop.style.top  = (r.bottom + 8 + window.scrollY) + 'px';
  _citePop = pop;
}
function hideCitePreview() {
  if (_citePop) { _citePop.remove(); _citePop = null; }
}

// Inline markdown + citation rendering.
// Supports **bold**, *italic*, `code`, • bullets, and every realistic citation format:
//   [p.42]           [p. 42]
//   [p.4, 12, 19]    [pp.4-7]    [p.4-7]
//   [p.5][p.12]      Page 7      page 12
// Optionally validates page numbers against the answer's known source pages.
function renderRichAnswer(text, validPages /* Set<number> | null */) {
  if (!text) return '';
  let out = escapeHtml(text);

  // 1) Multi-page brackets like [p.4, 12, 19] / [pp.4-7] / [p.4-7]
  out = out.replace(/\[(?:p+\.?|pages?)\s*([\d,\s\-–to]+)\]/gi, (_, body) => {
    return expandPageList(body, validPages);
  });
  // 2) Bare 'Page 7' / 'on page 12' (not already inside a span)
  out = out.replace(/\b[Pp]age[s]?\.?\s+(\d+(?:\s*[-–]\s*\d+)?)\b/g, (m, body) => {
    return expandPageList(body, validPages);
  });

  // markdown bits
  out = out.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  out = out.replace(/(^|\s)\*([^*\n]+)\*(?=\s|[.,;:!?]|$)/g, '$1<i>$2</i>');
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');

  // bullet lines starting with - or * or •
  const lines = out.split('\n');
  let inList = false, html = '';
  for (const ln of lines) {
    const bullet = ln.match(/^\s*[-*•]\s+(.*)$/);
    if (bullet) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${bullet[1]}</li>`;
    } else {
      if (inList) { html += '</ul>'; inList = false; }
      html += ln ? `<p>${ln}</p>` : '';
    }
  }
  if (inList) html += '</ul>';
  return html;
}

// Expand a page-list string into a series of <span class="cite"> badges.
// Accepts "4", "4, 12, 19", "4-7", "4 - 7" / en-dash, "4 to 7".
function expandPageList(body, validPages) {
  const pages = new Set();
  const parts = body.split(/[,;]/);
  for (const part of parts) {
    const range = part.trim().match(/^(\d+)\s*(?:[-–]|to)\s*(\d+)$/);
    if (range) {
      let a = +range[1], b = +range[2];
      if (a > b) [a, b] = [b, a];
      // cap range size to avoid runaway badges if model writes something silly
      const cap = Math.min(b, a + 25);
      for (let i = a; i <= cap; i++) pages.add(i);
    } else {
      const num = part.trim().match(/^(\d+)$/);
      if (num) pages.add(+num[1]);
    }
  }
  return [...pages].map(n => {
    const ok = !validPages || validPages.has(n);
    const cls = ok ? 'cite' : 'cite cite-unverified';
    const title = ok ? `Open page ${n}` : `Page ${n} (not in retrieved sources)`;
    return `<span class="${cls}" data-page="${n}" title="${title}">p.${n}</span>`;
  }).join('');
}

async function sendChat(forced) {
  const b = state.current;
  const input = $('#chat-msg');
  const msg = (forced != null ? forced : input.value).trim();
  if (!msg) return;
  input.value = '';
  const stream = $('#chat-stream');
  $('.empty-chat', stream)?.remove();
  // remove any previous follow-up panel
  $('#followups-panel', stream)?.remove();

  const userBubble = document.createElement('div');
  userBubble.className = 'bubble user'; userBubble.textContent = msg;
  stream.appendChild(userBubble);

  const thinking = document.createElement('div');
  thinking.className = 'bubble bot thinking';
  thinking.innerHTML = `<div class="thinking-row">
      <span class="td"></span><span class="td"></span><span class="td"></span>
      <span class="thinking-text">retrieving passages from <b>${escapeHtml(b.title)}</b>…</span>
    </div>`;
  stream.appendChild(thinking);
  stream.scrollTop = stream.scrollHeight;

  try {
    const resp = await postJSON(`/api/book/${b.id}/chat`, {message: msg, history: state.chatHistory});
    state.chatHistory.push({role:'user', content: msg});
    state.chatHistory.push({role:'assistant', content: resp.answer,
                            sources: resp.sources || []});
    saveChatHistory(b, state.chatHistory);

    // Source-page validation: which pages did retrieval actually surface?
    const sourcePages = new Set((resp.sources || []).map(s => s.page));
    const snippetByPage = {};
    for (const s of (resp.sources || [])) {
      if (!snippetByPage[s.page]) snippetByPage[s.page] = s.snippet;
    }

    thinking.classList.remove('thinking');
    thinking.innerHTML = renderRichAnswer(resp.answer, sourcePages);

    // citation badges → click to jump, hover for snippet preview
    $$('.cite', thinking).forEach(el => {
      const pg = parseInt(el.dataset.page);
      el.onclick = () => {
        $('.tab[data-tab="pages"]').click();
        loadPage(pg);
      };
      // hover preview (only when we have a snippet for the page)
      const snip = snippetByPage[pg];
      if (snip) {
        el.classList.add('cite-has-preview');
        el.addEventListener('mouseenter', () => showCitePreview(el, pg, snip));
        el.addEventListener('mouseleave', hideCitePreview);
      }
    });

    // pages-strip: every distinct page cited in the answer, clickable
    const cited = [...new Set([...thinking.querySelectorAll('.cite')].map(e => +e.dataset.page))].sort((a,b)=>a-b);
    if (cited.length) {
      const strip = document.createElement('div');
      strip.className = 'cited-strip';
      strip.innerHTML = `<span class="cs-label">Cited pages</span>` +
        cited.map(p => {
          const cls = sourcePages.has(p) ? 'cs-pg' : 'cs-pg cs-pg-unverified';
          return `<span class="${cls}" data-page="${p}" title="${sourcePages.has(p)?'jump to page':'not in retrieved sources'}">${p}</span>`;
        }).join('');
      thinking.appendChild(strip);
      $$('.cs-pg', strip).forEach(el => el.onclick = () => {
        $('.tab[data-tab="pages"]').click();
        loadPage(parseInt(el.dataset.page));
      });
    }

    // ---- Rich sources block ----
    if (resp.sources?.length) {
      const citedPages = new Set(
        [...thinking.querySelectorAll('.cite')].map(e => +e.dataset.page)
      );
      const exactCount = resp.sources.filter(s => s.match === 'exact').length;

      const wrap = document.createElement('details');
      wrap.className = 'sources-block';
      wrap.open = true;       // sources visible by default now
      wrap.innerHTML = `<summary>
        <span class="sb-icon">📚</span>
        <span class="sb-text"><b>${resp.sources.length}</b> source page${resp.sources.length===1?'':'s'}</span>
        ${exactCount ? `<span class="sb-tag sb-tag-exact">${exactCount} exact</span>` : ''}
        ${resp.sources.length - exactCount ? `<span class="sb-tag sb-tag-sem">${resp.sources.length - exactCount} related</span>` : ''}
      </summary>`;
      const list = document.createElement('div'); list.className = 'sources-grid';
      for (const s of resp.sources) {
        const card = document.createElement('div');
        card.className = `src-card src-card-${s.match}${citedPages.has(s.page) ? ' src-card-cited' : ''}`;
        const langTag = s.lang && s.lang !== 'unk' ? `<span class="src-lang">${s.lang.toUpperCase()}</span>` : '';
        const scorePct = Math.round((s.score || 0) * 100);
        card.innerHTML = `
          <div class="src-card-head">
            <span class="src-pg-lg">p.${s.page}</span>
            <div class="src-card-tags">
              <span class="src-type src-type-${s.match}">${s.match === 'exact' ? '◉ Exact match' : '◌ Related'}</span>
              ${langTag}
              ${citedPages.has(s.page) ? '<span class="src-cited">★ Cited in answer</span>' : ''}
            </div>
          </div>
          <div class="src-snippet">${escapeHtml(s.snippet)}…</div>
          <div class="src-card-foot">
            <div class="src-score-bar" title="relevance ${scorePct}%">
              <div style="width:${scorePct}%"></div>
            </div>
            ${s.snippet_count > 1 ? `<span class="src-chunks">${s.snippet_count} chunks consulted</span>` : ''}
            <span class="src-open">Open page →</span>
          </div>`;
        card.onclick = () => { $('.tab[data-tab="pages"]').click(); loadPage(s.page); };
        list.appendChild(card);
      }
      wrap.appendChild(list);
      thinking.appendChild(wrap);
    }

    // follow-ups
    if (resp.followups?.length) {
      const fp = document.createElement('div');
      fp.id = 'followups-panel'; fp.className = 'followups-panel';
      fp.innerHTML = `<span class="fp-label">Ask next</span>`;
      for (const q of resp.followups) {
        const b = document.createElement('button');
        b.className = 'fp-chip'; b.textContent = q;
        b.onclick = () => sendChat(q);
        fp.appendChild(b);
      }
      stream.appendChild(fp);
    }
  } catch (e) {
    thinking.classList.remove('thinking');
    thinking.classList.add('error');
    thinking.textContent = e.message || String(e);
  }
  stream.scrollTop = stream.scrollHeight;
}

// ----- Insights tab -----
async function loadInsights() {
  const b = state.current;
  const root = $('#insights-body');
  if (!root) return;
  root.innerHTML = '<div class="dim" style="padding:24px">Computing insights…</div>';
  let d;
  try { d = await api(`/api/book/${b.id}/insights`); }
  catch (e) { root.innerHTML = `<div class="empty-state">Failed: ${escapeHtml(e.message || e)}</div>`; return; }
  state.insights = d;
  if (d.empty) {
    root.innerHTML = `
      <div class="empty-state">
        <h4 style="color:var(--ink);margin:0 0 10px">No insights yet</h4>
        <p>This book hasn't been processed for people / relationships.</p>
        <p class="dim">Run OCR → Index → Extract from the pipeline strip above.</p>
      </div>`;
    return;
  }
  const m = d.metrics;
  const fmt = n => n.toLocaleString();

  // ---- HTML ----
  root.innerHTML = `
    <div class="insight-summary">
      <span class="crest" style="margin-bottom:14px">Heritage Vault · Derived from OCR + LLM extraction</span>
      <p class="insight-headline">${formatMd(d.summary)}</p>
    </div>

    <div class="insight-metric-row">
      ${metricCard('People',         fmt(m.people),         `${m.gender.M} men · ${m.gender.F} women${m.gender['?']?' · '+m.gender['?']+' unknown':''}`)}
      ${metricCard('Relationships',  fmt(m.relationships),  `density ${m.density} · ${m.couples} couples`)}
      ${metricCard('Generations',    fmt(m.generations),    `deepest known chain`)}
      ${metricCard('Branches',       fmt(m.branches),       `${m.orphans} unattached`)}
    </div>

    <div class="insight-grid">
      ${cardFounders(d.founders)}
      ${cardHubs(d.hubs)}
      ${cardBranches(d.components)}
      ${cardGenerations(d.gen_counts)}
      ${cardRelTypes(d.rel_types)}
      ${cardMostMentioned(d.most_mentioned)}
    </div>

    <div class="insight-card insight-suggest">
      <div class="ic-header">
        <h3>Ask the book</h3>
        <span class="dim">Auto-suggested from this book's actual content</span>
      </div>
      <div class="suggest-chips" id="suggest-chips">
        ${d.suggestions.map((s, i) => `<button class="sg" data-q="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join('')}
      </div>
    </div>`;

  // wire suggestion chips to chat
  $$('#suggest-chips .sg').forEach(b => b.onclick = () => {
    $('.tab[data-tab="chat"]').click();
    const msg = $('#chat-msg');
    msg.value = b.dataset.q;
    msg.focus();
  });
}

function metricCard(lbl, val, sub) {
  return `<div class="metric">
    <div class="metric-lbl">${escapeHtml(lbl)}</div>
    <div class="metric-val">${val}</div>
    <div class="metric-sub">${escapeHtml(sub || '')}</div>
  </div>`;
}
function cardFounders(arr) {
  if (!arr || !arr.length) return '';
  return `<div class="insight-card">
    <div class="ic-header"><h3>Founders</h3><span class="dim">No recorded parents — top of every chain</span></div>
    <ol class="ic-list">${arr.map(f => `
      <li><span class="ic-name">${escapeHtml(f.name)}</span>
          <span class="ic-tag">${f.children} children · ${f.descendants} descendants</span></li>
    `).join('')}</ol>
  </div>`;
}
function cardHubs(arr) {
  if (!arr || !arr.length) return '';
  return `<div class="insight-card">
    <div class="ic-header"><h3>Central figures</h3><span class="dim">Most connections in the graph</span></div>
    <ol class="ic-list">${arr.map(h => `
      <li><span class="ic-name">${escapeHtml(h.name)}</span>
          <span class="ic-tag">${h.degree} ties · gen ${h.generation}</span>
          <span class="ic-bar"><span style="width:${Math.min(100, h.degree*8)}%"></span></span></li>
    `).join('')}</ol>
  </div>`;
}
function cardBranches(arr) {
  if (!arr || arr.length <= 1) return '';
  const total = arr.reduce((a, c) => a + c.size, 0);
  return `<div class="insight-card">
    <div class="ic-header"><h3>Family branches</h3><span class="dim">Distinct connected family groups</span></div>
    <ol class="ic-list">${arr.map((c, i) => `
      <li class="branch-row" data-branch="${i}">
        <span class="ic-name">${escapeHtml(c.head || '(unknown)')}</span>
        <span class="ic-tag">${c.size} ${c.size === 1 ? 'person' : 'people'}${c.generations > 1 ? ' · '+c.generations+' gen' : ''}</span>
        <span class="ic-bar"><span style="width:${Math.round(c.size * 100 / total)}%"></span></span>
      </li>
    `).join('')}</ol>
  </div>`;
}
function cardGenerations(arr) {
  if (!arr || arr.length < 2) return '';
  const max = Math.max(...arr.map(g => g.count));
  return `<div class="insight-card">
    <div class="ic-header"><h3>Generations</h3><span class="dim">People per generational layer</span></div>
    <div class="gen-bars">${arr.map(g => `
      <div class="gen-bar">
        <div class="gb-label">Gen ${g.gen}</div>
        <div class="gb-fill"><div style="width:${Math.round(g.count*100/max)}%"></div></div>
        <div class="gb-count">${g.count}</div>
      </div>
    `).join('')}</div>
  </div>`;
}
function cardRelTypes(o) {
  if (!o || !Object.keys(o).length) return '';
  const entries = Object.entries(o).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((a, [, v]) => a + v, 0);
  return `<div class="insight-card">
    <div class="ic-header"><h3>Relationship mix</h3><span class="dim">How people connect</span></div>
    <ul class="ic-list">${entries.map(([k, v]) => `
      <li><span class="ic-name" style="text-transform:capitalize">${escapeHtml(k)}</span>
          <span class="ic-tag">${v} (${Math.round(v*100/total)}%)</span>
          <span class="ic-bar lg-${k}-bar"><span style="width:${Math.round(v*100/total)}%"></span></span></li>
    `).join('')}</ul>
  </div>`;
}
function cardMostMentioned(arr) {
  if (!arr || !arr.length) return '';
  return `<div class="insight-card">
    <div class="ic-header"><h3>Most mentioned</h3><span class="dim">People appearing on the most pages</span></div>
    <ol class="ic-list">${arr.map(p => `
      <li><span class="ic-name">${escapeHtml(p.name)}</span>
          <span class="ic-tag">${p.pages} ${p.pages === 1 ? 'page' : 'pages'}</span></li>
    `).join('')}</ol>
  </div>`;
}
function formatMd(s) {
  // bold **text**
  return escapeHtml(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
}

// ----- People tab -----
function refreshPeopleExtractBtn() {
  const btn = $('#people-extract');
  if (!btn) return;
  const b = state.current;
  if (!b) return;
  if (b.extract_status === 'running') {
    btn.disabled = true;
    btn.textContent = `⟳ Extracting… ${b.extract_people || 0} found`;
  } else {
    btn.disabled = false;
    btn.textContent = b.extract_status === 'done' ? '⚡ Re-extract' : '⚡ Extract';
  }
}

function initPeopleTab() {
  $('#people-search').oninput = e => renderPeople(e.target.value);
  $('#people-extract').onclick = async () => {
    const b = state.current;
    try {
      await postJSON(`/api/book/${b.id}/extract`);
      refreshPeopleExtractBtn();
    } catch (e) { alert(e.message || e); }
  };
  refreshPeopleExtractBtn();
}
async function loadPeople(forTree=false) {
  const b = state.current;
  try {
    const [data, _ignore] = await Promise.all([
      api(`/api/book/${b.id}/people`),
      // ensure insights (for branch colors) is loaded
      state.insights ? Promise.resolve() : api(`/api/book/${b.id}/insights`).then(d => state.insights = d).catch(() => null),
    ]);
    state.people = data;
    if (!forTree) renderPeople();
    else renderTree();
  } catch (e) {
    state.people = {people:[], relationships:[]};
    if (!forTree) renderPeople();
    else renderTree();
  }
}
function renderPeople(filter='') {
  const grid = $('#people-grid');
  if (!grid) return;
  const data = state.people;
  if (!data || !data.people.length) {
    $('#people-count').textContent = '0 people';
    grid.innerHTML = `<div class="empty-state">
      <p>No people extracted yet.</p>
      <p class="dim">Run <b>Extract</b> from the pipeline strip above. OCR must finish first.</p>
    </div>`;
    return;
  }
  const term = (filter||'').toLowerCase();
  const list = data.people.filter(p =>
    !term ||
    (p.name||'').toLowerCase().includes(term) ||
    (p.name_native||'').toLowerCase().includes(term)
  );
  $('#people-count').textContent = `${list.length} of ${data.people.length} people`;
  grid.innerHTML = '';
  for (const p of list) {
    const el = document.createElement('div');
    el.className = 'person gender-' + (p.gender || '?');
    let dates = '';
    if (p.birth || p.death) dates = `${p.birth||'?'} – ${p.death||''}`;
    el.innerHTML = `
      <h4>${escapeHtml(p.name)}</h4>
      ${p.name_native ? `<div class="native">${escapeHtml(p.name_native)}</div>` : ''}
      ${dates ? `<div class="pdates">${escapeHtml(dates)}</div>` : ''}
      ${p.notes ? `<div class="pnotes">${escapeHtml(p.notes)}</div>` : ''}
      ${p.pages?.length ? `<div class="ppages">${p.pages.slice(0,8).map(n=>`<span>p.${n}</span>`).join('')}</div>` : ''}
    `;
    grid.appendChild(el);
  }
}

// ----- Tree tab -----
function initTreeTab() {
  $$('.seg-btn').forEach(b => b.onclick = () => {
    $$('.seg-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    state.treeMode = b.dataset.mode;
    renderTree();
  });
  const ts = $('#tree-search');
  if (ts) ts.oninput = e => applyTreeSearch(e.target.value);
}

function applyTreeSearch(term) {
  term = (term || '').trim().toLowerCase();
  const svg = d3.select('#tree-svg');
  const nodes = svg.selectAll('g.node');
  const edges = svg.selectAll('path.edge');
  const labels = svg.selectAll('text.edge-label');
  if (!term) {
    nodes.classed('match', false).classed('faded', false);
    edges.classed('faded', false);
    labels.classed('faded', false);
    $('#tree-match-count').textContent = '';
    return;
  }
  let hits = [];
  nodes.each(function(d) {
    const hit = (d.name||'').toLowerCase().includes(term) ||
                (d.name_native||'').toLowerCase().includes(term) ||
                (d.notes||'').toLowerCase().includes(term);
    d3.select(this).classed('match', hit).classed('faded', !hit);
    if (hit) hits.push(d);
  });
  // also fade edges that don't touch any hit
  const hitIds = new Set(hits.map(d => d.id));
  edges.classed('faded', e => !hitIds.has(e.source.id || e.source) && !hitIds.has(e.target.id || e.target));
  labels.classed('faded', e => !hitIds.has(e.source.id || e.source) && !hitIds.has(e.target.id || e.target));
  $('#tree-match-count').textContent = hits.length ? `${hits.length} match${hits.length===1?'':'es'}` : 'no matches';

  // zoom-to-fit on matches
  if (hits.length) {
    const xs = hits.map(d => d.x).filter(Number.isFinite);
    const ys = hits.map(d => d.y).filter(Number.isFinite);
    if (xs.length) {
      const w = svg.node().clientWidth, h = svg.node().clientHeight;
      const minX = Math.min(...xs), maxX = Math.max(...xs);
      const minY = Math.min(...ys), maxY = Math.max(...ys);
      const pad = 80;
      const dx = Math.max(maxX-minX, 1), dy = Math.max(maxY-minY, 1);
      const k = Math.min(3, 0.85 / Math.max(dx/w, dy/h));
      const cx = (minX + maxX)/2, cy = (minY + maxY)/2;
      const tx = w/2 - k*cx, ty = h/2 - k*cy;
      svg.transition().duration(700).call(
        d3.zoom().scaleExtent([0.2, 4]).on('zoom', e => svg.select('g.viewport').attr('transform', e.transform)).transform,
        d3.zoomIdentity.translate(tx, ty).scale(k)
      );
    }
  }
}

let treeSim = null;
function _initials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length-1][0]).toUpperCase();
}

function _generationsMap(nodes, links) {
  // BFS from roots (anyone with no incoming parent edge)
  const incoming = new Map();
  nodes.forEach(n => incoming.set(n.id, []));
  for (const l of links) if (l.type === 'parent') {
    const child = typeof l.target === 'object' ? l.target.id : l.target;
    const parent = typeof l.source === 'object' ? l.source.id : l.source;
    incoming.get(child).push(parent);
  }
  const gen = new Map();
  const queue = nodes.filter(n => (incoming.get(n.id)||[]).length === 0).map(n => n.id);
  queue.forEach(id => gen.set(id, 0));
  let head = 0;
  while (head < queue.length) {
    const id = queue[head++];
    const g = gen.get(id);
    for (const l of links) {
      if (l.type !== 'parent') continue;
      const pid = typeof l.source === 'object' ? l.source.id : l.source;
      const cid = typeof l.target === 'object' ? l.target.id : l.target;
      if (pid === id && !gen.has(cid)) { gen.set(cid, g + 1); queue.push(cid); }
    }
  }
  nodes.forEach(n => { if (!gen.has(n.id)) gen.set(n.id, 0); });
  return gen;
}

function _adjacency(nodes, links) {
  const parents = new Map(nodes.map(n => [n.id, new Set()]));
  const children = new Map(nodes.map(n => [n.id, new Set()]));
  const spouses = new Map(nodes.map(n => [n.id, new Set()]));
  const siblings = new Map(nodes.map(n => [n.id, new Set()]));
  for (const l of links) {
    const s = typeof l.source === 'object' ? l.source.id : l.source;
    const t = typeof l.target === 'object' ? l.target.id : l.target;
    if (l.type === 'parent') { parents.get(t)?.add(s); children.get(s)?.add(t); }
    else if (l.type === 'spouse') { spouses.get(s)?.add(t); spouses.get(t)?.add(s); }
    else if (l.type === 'sibling') { siblings.get(s)?.add(t); siblings.get(t)?.add(s); }
  }
  return { parents, children, spouses, siblings };
}

function _kinSet(pid, adj) {
  // Direct kin: parents, siblings, spouse, children + grandparents + grandchildren
  const set = new Set([pid]);
  const ps = adj.parents.get(pid) || new Set();
  ps.forEach(p => { set.add(p); (adj.parents.get(p)||new Set()).forEach(gp => set.add(gp)); });
  const cs = adj.children.get(pid) || new Set();
  cs.forEach(c => { set.add(c); (adj.children.get(c)||new Set()).forEach(gc => set.add(gc)); });
  (adj.spouses.get(pid) || new Set()).forEach(s => set.add(s));
  (adj.siblings.get(pid) || new Set()).forEach(s => set.add(s));
  // Also: siblings derived from shared parents
  ps.forEach(p => (adj.children.get(p)||new Set()).forEach(sib => set.add(sib)));
  return set;
}

// Default cap to keep big books snappy; toggleable from the toolbar.
const TREE_NODE_CAP = 350;

function renderTree() {
  const data = state.people;
  const svg = d3.select('#tree-svg');
  svg.selectAll('*').remove();
  if (treeSim) { treeSim.stop(); treeSim = null; }

  if (!data || !data.people.length) {
    svg.append('text').attr('x','50%').attr('y','50%').attr('text-anchor','middle')
       .attr('fill','#a09cc4').style('font-family','Poppins').style('font-size','14px')
       .text('No relationships extracted yet. Use the People tab → Extract.');
    return;
  }

  const w = svg.node().clientWidth;
  const h = svg.node().clientHeight;
  const mode = state.treeMode || 'force';

  // Build full node + link arrays (used for the "show all" toggle)
  const allNodes = data.people.map(p => ({...p}));
  const idxAll = Object.fromEntries(allNodes.map(n => [n.id, n]));
  const allLinks = data.relationships
    .filter(r => idxAll[r.from] && idxAll[r.to])
    .map(r => ({source: r.from, target: r.to, type: r.type, notes: r.notes}));

  // ---- cap nodes by connectivity for performance ----
  const showAll = !!state.treeShowAll;
  let nodes, links;
  if (showAll || allNodes.length <= TREE_NODE_CAP) {
    nodes = allNodes; links = allLinks;
  } else {
    // keep the most-connected N nodes
    const deg = new Map(allNodes.map(n => [n.id, 0]));
    for (const l of allLinks) { deg.set(l.source, (deg.get(l.source)||0)+1); deg.set(l.target, (deg.get(l.target)||0)+1); }
    const keep = new Set(
      [...allNodes].sort((a, b) => (deg.get(b.id)||0) - (deg.get(a.id)||0)).slice(0, TREE_NODE_CAP).map(n => n.id)
    );
    nodes = allNodes.filter(n => keep.has(n.id));
    links = allLinks.filter(l => keep.has(l.source) && keep.has(l.target));
  }
  const idx = Object.fromEntries(nodes.map(n => [n.id, n]));

  // toolbar: show-all toggle status
  const cap = $('#tree-cap-info');
  if (cap) {
    cap.innerHTML = (allNodes.length > TREE_NODE_CAP && !showAll)
      ? `showing top ${nodes.length} of ${allNodes.length} · <a href="#" id="tree-show-all">show all</a>`
      : (allNodes.length > TREE_NODE_CAP
          ? `showing all ${allNodes.length} · <a href="#" id="tree-show-top">show top ${TREE_NODE_CAP}</a>`
          : `${nodes.length} people`);
    $('#tree-show-all')?.addEventListener('click', e => { e.preventDefault(); state.treeShowAll = true; renderTree(); });
    $('#tree-show-top')?.addEventListener('click', e => { e.preventDefault(); state.treeShowAll = false; renderTree(); });
  }

  const gen = _generationsMap(nodes, links);
  nodes.forEach(n => n._gen = gen.get(n.id) || 0);
  const maxGen = Math.max(...nodes.map(n => n._gen), 1);
  const adj = _adjacency(nodes, links);

  const branchPalette = ['#95c11f','#5dcfe5','#f0789f','#c9a13a','#a78bfa','#5fb878','#e07b4a','#7faedb'];
  const branchOf = state.insights?.branch_of || {};
  const nodeFill = d => {
    if (d.gender === 'F') return '#f0789f';
    if (d.gender === 'M') return '#7ddae8';
    return '#b9d973';
  };
  const branchStroke = d => {
    const i = branchOf[d.id]; return i == null ? 'rgba(255,255,255,.45)' : branchPalette[i % branchPalette.length];
  };

  const root = svg.append('g').attr('class','viewport');
  const zoom = d3.zoom().scaleExtent([0.15, 4]).on('zoom', e => root.attr('transform', e.transform));
  svg.call(zoom);

  // ---- LAYOUT: compute positions ONCE, then render statically ----
  function computeStaticLayout() {
    if (mode === 'force') {
      const sim = d3.forceSimulation(nodes)
        .force('charge',    d3.forceManyBody().strength(-260))
        .force('center',    d3.forceCenter(w/2, h/2))
        .force('link',      d3.forceLink(links).id(d=>d.id).distance(d => d.type==='parent'?80:60).strength(0.6))
        .force('collision', d3.forceCollide().radius(22))
        .stop();
      // run synchronously for a fixed number of ticks, then freeze
      const ticks = Math.min(250, Math.ceil(Math.log(sim.alphaMin()) / Math.log(1 - sim.alphaDecay())));
      for (let i = 0; i < ticks; i++) sim.tick();
    } else if (mode === 'radial') {
      const cx = w/2, cy = h/2, Rmax = Math.min(w,h)/2 - 60;
      const groups = new Map();
      nodes.forEach(n => {
        if (!groups.has(n._gen)) groups.set(n._gen, []);
        groups.get(n._gen).push(n);
      });
      for (const [g, list] of groups) {
        const r = g === 0 ? 0 : (g/maxGen) * Rmax;
        list.forEach((n, i) => {
          const a = (i / Math.max(list.length, 1)) * Math.PI * 2;
          n.x = cx + Math.cos(a) * r; n.y = cy + Math.sin(a) * r;
        });
      }
    } else { // river
      const colW = Math.max(180, Math.floor((w - 80) / (maxGen + 1)));
      const groups = new Map();
      nodes.forEach(n => {
        if (!groups.has(n._gen)) groups.set(n._gen, []);
        groups.get(n._gen).push(n);
      });
      // band decoration (light, no continuous reflow)
      const bandG = root.append('g').attr('class','river-bands');
      for (let g = 0; g <= maxGen; g++) {
        bandG.append('rect')
          .attr('x', 40 + g * colW - colW/2 + 18)
          .attr('y', 0).attr('width', colW - 36).attr('height', h)
          .attr('class', 'river-band-bg')
          .attr('fill', g % 2 === 0 ? 'rgba(149,193,31,.03)' : 'rgba(125,218,232,.03)');
        bandG.append('text')
          .attr('x', 40 + g * colW).attr('y', 22).attr('text-anchor','middle')
          .attr('class','river-band-label')
          .text('Gen ' + g);
      }
      for (const [g, list] of groups) {
        list.sort((a,b) => (branchOf[a.id]||0) - (branchOf[b.id]||0) || (a.name||'').localeCompare(b.name||''));
        const spacing = (h - 80) / Math.max(list.length, 1);
        list.forEach((n, i) => {
          n.x = 40 + g * colW;
          n.y = 60 + i * spacing;
        });
      }
    }
    // Resolve link source/target into node objects (for static render)
    for (const l of links) {
      if (typeof l.source === 'string') l.source = idx[l.source] || l.source;
      if (typeof l.target === 'string') l.target = idx[l.target] || l.target;
    }
  }
  computeStaticLayout();

  // ---- edges (drawn once with final positions) ----
  const linkGroup = root.append('g').attr('class','links');
  const link = linkGroup.selectAll('path').data(links).enter()
    .append('path')
    .attr('class', d => 'edge ' + (['parent','spouse','sibling','child','other'].includes(d.type)?d.type:'other'))
    .attr('d', d => {
      const sx=d.source.x, sy=d.source.y, tx=d.target.x, ty=d.target.y;
      if (mode === 'river') {
        const mx = (sx + tx) / 2;
        return `M${sx},${sy} C${mx},${sy} ${mx},${ty} ${tx},${ty}`;
      }
      const dx=tx-sx, dy=ty-sy, dr=Math.sqrt(dx*dx+dy*dy)*1.4;
      return `M${sx},${sy} A${dr},${dr} 0 0,1 ${tx},${ty}`;
    });

  // Edge labels — only render for the smaller view, they hurt perf at 1000+ edges
  let edgeLabel = d3.select(null);
  if (links.length <= 300) {
    const labelGroup = root.append('g').attr('class','edge-labels');
    edgeLabel = labelGroup.selectAll('text').data(links).enter()
      .append('text')
      .attr('class', d => 'edge-label edge-' + (['parent','spouse','sibling','other'].includes(d.type)?d.type:'other'))
      .attr('text-anchor','middle').attr('dy', -3)
      .attr('x', d => (d.source.x + d.target.x) / 2)
      .attr('y', d => (d.source.y + d.target.y) / 2)
      .text(d => d.type);
  }

  // ---- simple nodes: one circle + one label ----
  const node = root.append('g').attr('class','nodes').selectAll('g').data(nodes).enter()
    .append('g').attr('class', d => 'node gender-' + (d.gender||'?'))
    .attr('transform', d => `translate(${d.x},${d.y})`);

  node.append('circle')
    .attr('r', d => 9 + Math.min(4, (d.pages?.length||0)/4))
    .attr('class','node-dot')
    .attr('fill', nodeFill)
    .attr('stroke', branchStroke)
    .attr('stroke-width', 2);

  node.append('text').attr('class','node-label')
    .attr('y', 22).attr('text-anchor','middle')
    .text(d => (d.name||'').length > 22 ? d.name.slice(0,20)+'…' : d.name);

  // ---- hover preview (lightweight, transient) ----
  const info = $('#tree-info');
  node.on('mouseenter', (e, d) => {
    if (state.treeFocus) return;          // don't override the click-locked panel
    info.classList.add('show');
    info.innerHTML = `
      <h4>${escapeHtml(d.name)}</h4>
      ${d.name_native ? `<div class="ti-row">${escapeHtml(d.name_native)}</div>` : ''}
      <div class="ti-row"><b>Generation:</b> ${d._gen}${d.gender && d.gender !== '?' ? ` · <b>${d.gender}</b>` : ''}</div>
      ${(d.birth||d.death) ? `<div class="ti-row"><b>Lifespan:</b> ${d.birth||'?'} – ${d.death||''}</div>` : ''}
      ${d.notes ? `<div class="ti-row">${escapeHtml(d.notes)}</div>` : ''}
      ${d.pages?.length ? `<div class="ti-row"><b>Pages:</b> ${d.pages.slice(0,8).join(', ')}</div>` : ''}
      <div class="ti-row dim">Click for full details + focus</div>`;
    const focusSet = _kinSet(d.id, adj);
    node.classed('peek-dim', n => !focusSet.has(n.id));
    link.classed('peek-dim', l => !(focusSet.has(l.source.id||l.source) && focusSet.has(l.target.id||l.target)));
    edgeLabel.classed('peek-dim', l => !(focusSet.has(l.source.id||l.source) && focusSet.has(l.target.id||l.target)));
  });
  node.on('mouseleave', () => {
    if (state.treeFocus) return;
    info.classList.remove('show');
    node.classed('peek-dim', false);
    link.classed('peek-dim', false);
    edgeLabel.classed('peek-dim', false);
  });

  // ---- click: open sticky detail card + focus mode ----
  function applyFocus(focusId) {
    state.treeFocus = focusId;
    if (!focusId) {
      node.classed('focused', false).classed('focus-dim', false);
      link.classed('focus-dim', false);
      edgeLabel.classed('focus-dim', false);
      $('#tree-detail-card')?.remove();
      $('#tree-focus-bar')?.remove();
      info.classList.remove('show');
      node.classed('peek-dim', false);
      link.classed('peek-dim', false);
      edgeLabel.classed('peek-dim', false);
      return;
    }
    const person = idx[focusId];
    const kin = _kinSet(focusId, adj);
    node.classed('focused', n => n.id === focusId);
    node.classed('focus-dim', n => !kin.has(n.id));
    link.classed('focus-dim', l => !(kin.has(l.source.id||l.source) && kin.has(l.target.id||l.target)));
    edgeLabel.classed('focus-dim', l => !(kin.has(l.source.id||l.source) && kin.has(l.target.id||l.target)));

    // hide hover info, show detail card
    info.classList.remove('show');
    renderTreeDetailCard(person);

    // top pill — quick summary
    document.getElementById('tree-focus-bar')?.remove();
    const bar = document.createElement('div');
    bar.id = 'tree-focus-bar'; bar.className = 'tree-focus-bar';
    bar.innerHTML = `<span class="tfb-label">Focused</span>
      <span class="tfb-name">${escapeHtml(person.name)}</span>
      <span class="tfb-meta">${kin.size} kin · gen ${person._gen}</span>
      <button class="tfb-clear">✕ Clear focus</button>`;
    $('.tree-frame').appendChild(bar);
    bar.querySelector('.tfb-clear').onclick = () => applyFocus(null);
  }

  function renderTreeDetailCard(p) {
    document.getElementById('tree-detail-card')?.remove();
    const card = document.createElement('div');
    card.id = 'tree-detail-card';
    card.className = 'tree-detail-card';

    const parents  = [...(adj.parents.get(p.id)  || [])].map(id => idx[id]).filter(Boolean);
    const children = [...(adj.children.get(p.id) || [])].map(id => idx[id]).filter(Boolean);
    const spouses  = [...(adj.spouses.get(p.id)  || [])].map(id => idx[id]).filter(Boolean);
    const siblings = [...(adj.siblings.get(p.id) || [])].map(id => idx[id]).filter(Boolean);

    const branchIdx = branchOf[p.id];
    const branchColor = branchIdx != null ? branchPalette[branchIdx % branchPalette.length] : '#95c11f';

    function relRow(label, list) {
      if (!list.length) return '';
      return `<div class="tdc-rel-group">
        <div class="tdc-rel-label">${label}</div>
        <div class="tdc-rel-chips">${list.map(x => `
          <button class="tdc-rel" data-id="${x.id}" title="Focus on ${escapeHtml(x.name||'')}">
            <span class="tdc-rel-init">${_initials(x.name)}</span>
            <span class="tdc-rel-name">${escapeHtml(x.name||'?')}</span>
          </button>`).join('')}</div>
      </div>`;
    }

    const pageChips = (p.pages || []).slice(0, 16).map(n =>
      `<button class="tdc-pg" data-page="${n}">p.${n}</button>`).join('');

    card.innerHTML = `
      <button class="tdc-close" title="Close (Esc)">✕</button>
      <div class="tdc-head">
        <div class="tdc-avatar gender-${p.gender||'?'}" style="--ring:${branchColor}">
          <span>${_initials(p.name)}</span>
        </div>
        <div class="tdc-name-block">
          <div class="tdc-name">${escapeHtml(p.name||'?')}</div>
          ${p.name_native ? `<div class="tdc-native">${escapeHtml(p.name_native)}</div>` : ''}
          <div class="tdc-meta">
            <span class="tdc-tag">Gen ${p._gen}</span>
            ${p.gender && p.gender!=='?' ? `<span class="tdc-tag tdc-tag-${p.gender}">${p.gender==='M'?'Male':'Female'}</span>` : ''}
            ${branchIdx != null ? `<span class="tdc-tag tdc-branch" style="background:${branchColor}22;color:${branchColor};border-color:${branchColor}66">Branch ${branchIdx+1}</span>` : ''}
            ${(p.birth||p.death) ? `<span class="tdc-tag">${p.birth||'?'} – ${p.death||''}</span>` : ''}
          </div>
        </div>
      </div>
      ${p.notes ? `<div class="tdc-notes">${escapeHtml(p.notes)}</div>` : ''}
      ${relRow('Parents',  parents)}
      ${relRow('Spouse'+(spouses.length>1?'s':''),   spouses)}
      ${relRow('Siblings', siblings)}
      ${relRow('Children', children)}
      ${pageChips ? `<div class="tdc-pages">
        <div class="tdc-rel-label">Mentioned on pages</div>
        <div class="tdc-pg-list">${pageChips}</div>
      </div>` : ''}
    `;
    $('.tree-frame').appendChild(card);

    // wire interactions
    card.querySelector('.tdc-close').onclick = () => applyFocus(null);
    $$('.tdc-rel', card).forEach(b => b.onclick = (e) => {
      e.stopPropagation();
      applyFocus(b.dataset.id);
    });
    $$('.tdc-pg', card).forEach(b => b.onclick = (e) => {
      e.stopPropagation();
      $('.tab[data-tab="pages"]').click();
      loadPage(parseInt(b.dataset.page));
    });
  }

  // Click handlers — use SVG's pointer events with stopPropagation
  node.on('click', function(e, d) {
    e.stopPropagation();
    applyFocus(d.id);
  });
  // Click on empty SVG canvas clears focus
  svg.on('click', function(e) {
    if (e.target === svg.node()) applyFocus(null);
  });
  // Escape clears focus too
  if (!state._treeEscBound) {
    document.addEventListener('keydown', ev => {
      if (ev.key === 'Escape' && state.treeFocus) applyFocus(null);
    });
    state._treeEscBound = true;
  }

  // No continuous tick — layout was pre-cooked above. Static SVG = fast.
}

// ============================================================
// SSE — live updates
// ============================================================
function connectSSE() {
  const conn = $('#api-state');
  const es = new EventSource('/api/events');
  es.onopen = () => { conn.classList.add('live'); $('#api-state-text').textContent = 'live'; };
  es.onerror = () => { conn.classList.remove('live'); $('#api-state-text').textContent = 'reconnecting…'; };
  es.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.type === 'snapshot') {
      state.books = m.books;
      // re-bind current
      if (state.current) state.current = state.books.find(b => b.id === state.current.id) || state.current;
      route();
    } else if (m.type === 'book') {
      const i = state.books.findIndex(x => x.id === m.book.id);
      if (i >= 0) state.books[i] = m.book; else state.books.push(m.book);
      if (state.view === 'home') patchBookInGrid(m.book);
      else if (state.view === 'book' && state.current && state.current.id === m.book.id) {
        const prev = state.current;
        state.current = m.book; renderPipeline();
        // if OCR is in flight or just finished, refresh current page reader + action bar
        const pagesVisible = $('.tab-pane[data-pane="pages"].active');
        if (pagesVisible) {
          refreshOcrActionBar();
          const ocrAdvanced = (m.book.ocr_done || 0) > (prev.ocr_done || 0);
          const noTextYet = !state.pageData?.text;
          if (ocrAdvanced || (m.book.ocr_status === 'done' && noTextYet)) {
            loadPage(state.currentPage);
          }
        }
        // people tab — keep button + live count fresh during extraction
        const peopleVisible = $('.tab-pane[data-pane="people"].active');
        const treeVisible = $('.tab-pane[data-pane="tree"].active');
        if (peopleVisible) refreshPeopleExtractBtn();
        // refresh grid when extract advances (running) or completes (done)
        const extractAdvanced = (m.book.extract_people || 0) !== (prev.extract_people || 0);
        if ((peopleVisible || treeVisible) &&
            (m.book.extract_status === 'done' || extractAdvanced)) {
          loadPeople(!!treeVisible);
        }
        // refresh chat state too
        const chatVisible = $('.tab-pane[data-pane="chat"].active');
        if (chatVisible) {
          const stEl = $('#chat-state');
          if (stEl) stEl.textContent = m.book.ingest_chunks > 0 ? `${m.book.ingest_chunks} indexed chunks` : 'Index the book first';
        }
      }
    } else if (m.type === 'run_start') {
      const s = $('#b-start'); if (s) s.disabled = true;
      const x = $('#b-stop'); if (x) x.disabled = false;
    } else if (m.type === 'run_end') {
      const s = $('#b-start'); if (s) s.disabled = false;
      const x = $('#b-stop'); if (x) x.disabled = true;
    }
  };
}

async function loadHealth() {
  try { state.health = await api('/api/health'); } catch (e) { state.health = null; }
}
loadHealth();
connectSSE();
// initial route after a moment (snapshot will trigger route())
