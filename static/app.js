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
  if (isDone) {
    acts.innerHTML = `
      <a class="btn-sm open" href="#/book/${b.id}">⌬ Open</a>
      <a class="btn-sm dl" href="/pdfs/${b.slug}.pdf" download>↓ PDF</a>`;
  } else {
    acts.innerHTML = `
      <a class="btn-sm open" href="#/book/${b.id}">⌬ Open</a>
      <button class="btn-sm go" data-act="bind" ${b.status==='downloading'||b.status==='building'||b.status==='queued'?'disabled':''}>▶ Bind</button>`;
    acts.querySelector('[data-act="bind"]')?.addEventListener('click', async () => {
      try { await postJSON('/api/start', {ids:[b.id]}); } catch (e) { alert(e); }
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
    if (t.dataset.tab === 'people') loadPeople();
    if (t.dataset.tab === 'tree') loadPeople(true);
  });

  initPagesTab();
  initChatTab();
  initPeopleTab();
  initTreeTab();
}

function renderPipeline() {
  const b = state.current;
  if (!b) return;
  const wrap = $('#pipeline');
  if (!wrap) return;
  const stages = [
    {key:'pdf', label:'PDF', state: b.status, value: `${b.downloaded}/${b.pages} pages`,
     action: b.status==='done' ? null : 'Bind', endpoint:'/api/start', body: {ids:[b.id]},
     pct: b.pages ? b.downloaded/b.pages : 0},
    {key:'ocr', label:'OCR', state: b.ocr_status, value: `${b.ocr_done}/${b.pages} pages`,
     action: b.status==='done' ? (b.ocr_status==='done'?'Re-OCR':'Run OCR') : null,
     endpoint:`/api/book/${b.id}/ocr`, body: {},
     pct: b.pages ? b.ocr_done/b.pages : 0,
     disabled: b.status !== 'done'},
    {key:'ingest', label:'Vector index', state: b.ingest_status, value: `${b.ingest_chunks} chunks`,
     action: b.ocr_done>0 ? (b.ingest_status==='done'?'Re-index':'Index') : null,
     endpoint:`/api/book/${b.id}/ingest`, body: {},
     pct: b.ingest_status==='done' ? 1 : 0,
     disabled: b.ocr_done === 0},
    {key:'extract', label:'People', state: b.extract_status, value: `${b.extract_people} people`,
     action: b.ocr_done>0 ? (b.extract_status==='done'?'Re-extract':'Extract') : null,
     endpoint:`/api/book/${b.id}/extract`, body: {},
     pct: b.extract_status==='done' ? 1 : 0,
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
}

// ----- Pages tab -----
function initPagesTab() {
  const b = state.current;
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
  loadPage(1);
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
      txt.textContent = data.text;
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
function initChatTab() {
  const b = state.current;
  const stateEl = $('#chat-state');
  let label = b.ingest_chunks > 0 ? `${b.ingest_chunks} indexed chunks` : 'Index the book first';
  if (state.health?.llm_available) label += ` · ${state.health.llm_provider}`;
  else label += ' · ⚠ no LLM key';
  stateEl.textContent = label;
  $('#chat-form').onsubmit = e => { e.preventDefault(); sendChat(); };
}
async function sendChat() {
  const b = state.current;
  const input = $('#chat-msg');
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';
  const stream = $('#chat-stream');
  $('.empty-chat', stream)?.remove();

  const userBubble = document.createElement('div');
  userBubble.className = 'bubble user'; userBubble.textContent = msg;
  stream.appendChild(userBubble);

  const thinking = document.createElement('div');
  thinking.className = 'bubble bot thinking'; thinking.textContent = 'Searching the book…';
  stream.appendChild(thinking);
  stream.scrollTop = stream.scrollHeight;

  try {
    const resp = await postJSON(`/api/book/${b.id}/chat`, {message: msg, history: state.chatHistory});
    state.chatHistory.push({role:'user', content: msg});
    state.chatHistory.push({role:'assistant', content: resp.answer});
    thinking.classList.remove('thinking'); thinking.textContent = '';
    const txt = document.createElement('div'); txt.textContent = resp.answer;
    thinking.appendChild(txt);
    if (resp.sources?.length) {
      const src = document.createElement('div'); src.className = 'sources';
      const seen = new Set();
      for (const s of resp.sources) {
        if (seen.has(s.page)) continue;
        seen.add(s.page);
        const e = document.createElement('div');
        e.className = 'src'; e.textContent = `▸ Page ${s.page} — ${s.snippet.slice(0,120)}…`;
        e.onclick = () => {
          $('.tab[data-tab="pages"]').click();
          loadPage(s.page);
        };
        src.appendChild(e);
      }
      thinking.appendChild(src);
    }
  } catch (e) {
    thinking.classList.remove('thinking');
    thinking.classList.add('error');
    thinking.textContent = e.message || String(e);
  }
  stream.scrollTop = stream.scrollHeight;
}

// ----- People tab -----
function initPeopleTab() {
  $('#people-search').oninput = e => renderPeople(e.target.value);
  $('#people-extract').onclick = async () => {
    const b = state.current;
    try { await postJSON(`/api/book/${b.id}/extract`); }
    catch (e) { alert(e.message || e); }
  };
}
async function loadPeople(forTree=false) {
  const b = state.current;
  try {
    const data = await api(`/api/book/${b.id}/people`);
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
      <p class="dim">Run OCR, then click <b>Extract</b> in the pipeline (requires <code>ANTHROPIC_API_KEY</code>).</p>
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
}

let treeSim = null;
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

  // gradient defs (tuned for dark navy panel)
  const defs = svg.append('defs');
  const grad = defs.append('radialGradient').attr('id','nodeGrad');
  grad.append('stop').attr('offset','0%').attr('stop-color','#b9d973');
  grad.append('stop').attr('offset','100%').attr('stop-color','#3d5a0e');
  const gradF = defs.append('radialGradient').attr('id','nodeGradF');
  gradF.append('stop').attr('offset','0%').attr('stop-color','#f0789f');
  gradF.append('stop').attr('offset','100%').attr('stop-color','#5e1a30');
  const gradM = defs.append('radialGradient').attr('id','nodeGradM');
  gradM.append('stop').attr('offset','0%').attr('stop-color','#7ddae8');
  gradM.append('stop').attr('offset','100%').attr('stop-color','#0e3e4a');

  const root = svg.append('g').attr('class','viewport');

  // zoom/pan
  svg.call(d3.zoom().scaleExtent([0.2, 4]).on('zoom', e => root.attr('transform', e.transform)));

  const nodes = data.people.map(p => ({...p}));
  const idx = Object.fromEntries(nodes.map(n => [n.id, n]));
  const links = data.relationships
    .filter(r => idx[r.from] && idx[r.to])
    .map(r => ({source: r.from, target: r.to, type: r.type, notes: r.notes}));

  if (state.treeMode === 'force') {
    treeSim = d3.forceSimulation(nodes)
      .force('charge', d3.forceManyBody().strength(-280))
      .force('center', d3.forceCenter(w/2, h/2))
      .force('link', d3.forceLink(links).id(d=>d.id).distance(d => d.type==='parent'?80:65).strength(0.5))
      .force('collision', d3.forceCollide().radius(28));
  } else {
    // Radial Lineage: assign generation by BFS from roots (nodes with no incoming 'parent')
    const incoming = new Map();
    nodes.forEach(n => incoming.set(n.id, []));
    for (const l of links) if (l.type==='parent' || l.type==='child') {
      const child = l.type==='parent' ? l.target : l.source;
      const parent = l.type==='parent' ? l.source : l.target;
      const cId = typeof child === 'object' ? child.id : child;
      const pId = typeof parent === 'object' ? parent.id : parent;
      incoming.get(cId).push(pId);
    }
    const gen = new Map();
    const queue = nodes.filter(n => (incoming.get(n.id)||[]).length===0).map(n => n.id);
    queue.forEach(id => gen.set(id, 0));
    let head = 0;
    while (head < queue.length) {
      const id = queue[head++];
      const g = gen.get(id);
      for (const l of links) {
        if (l.type !== 'parent' && l.type !== 'child') continue;
        const parent = l.type==='parent' ? l.source : l.target;
        const child = l.type==='parent' ? l.target : l.source;
        const pId = typeof parent==='object' ? parent.id : parent;
        const cId = typeof child==='object' ? child.id : child;
        if (pId === id && !gen.has(cId)) { gen.set(cId, g+1); queue.push(cId); }
      }
    }
    nodes.forEach(n => { if (!gen.has(n.id)) gen.set(n.id, 0); });
    const maxGen = Math.max(...gen.values(), 1);
    const groups = new Map();
    nodes.forEach(n => {
      const g = gen.get(n.id);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(n);
    });
    const cx = w/2, cy = h/2;
    const Rmax = Math.min(w,h)/2 - 40;
    for (const [g, list] of groups) {
      const r = (g/maxGen) * Rmax;
      list.forEach((n, i) => {
        const a = (i / list.length) * Math.PI * 2;
        n.fx = cx + Math.cos(a) * r;
        n.fy = cy + Math.sin(a) * r;
      });
    }
    treeSim = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(links).id(d=>d.id).distance(50).strength(0.2))
      .force('charge', d3.forceManyBody().strength(-100));
  }

  // edges first (under nodes)
  const link = root.append('g').attr('class','links').selectAll('path').data(links).enter()
    .append('path')
    .attr('class', d => 'edge ' + (['parent','spouse','sibling','child'].includes(d.type)?d.type:'other'));

  // nodes
  const node = root.append('g').attr('class','nodes').selectAll('g').data(nodes).enter()
    .append('g').attr('class','node')
    .call(d3.drag()
      .on('start', (e,d) => { if (!e.active) treeSim.alphaTarget(0.25).restart(); d.fx=d.x; d.fy=d.y; })
      .on('drag', (e,d) => { d.fx=e.x; d.fy=e.y; })
      .on('end', (e,d) => { if (!e.active) treeSim.alphaTarget(0); if (state.treeMode==='force') { d.fx=null; d.fy=null; } })
    );

  node.append('circle')
    .attr('r', d => 14 + Math.min(8, (d.pages?.length||0)))
    .attr('class', d => 'node-circle gender-' + (d.gender||'?'))
    .attr('fill', d => d.gender==='F' ? 'url(#nodeGradF)' : d.gender==='M' ? 'url(#nodeGradM)' : 'url(#nodeGrad)');
  node.append('text').attr('class','node-label')
    .attr('y', 28).attr('text-anchor','middle')
    .text(d => (d.name||'').length > 22 ? d.name.slice(0,20)+'…' : d.name);

  // hover info
  const info = $('#tree-info');
  node.on('mouseenter', (e, d) => {
    info.classList.add('show');
    info.innerHTML = `
      <h4>${escapeHtml(d.name)}</h4>
      ${d.name_native ? `<div class="ti-row">${escapeHtml(d.name_native)}</div>` : ''}
      ${d.gender && d.gender !== '?' ? `<div class="ti-row"><b>Gender:</b> ${d.gender}</div>` : ''}
      ${(d.birth||d.death) ? `<div class="ti-row"><b>Lifespan:</b> ${d.birth||'?'} – ${d.death||''}</div>` : ''}
      ${d.notes ? `<div class="ti-row">${escapeHtml(d.notes)}</div>` : ''}
      ${d.pages?.length ? `<div class="ti-row"><b>Pages:</b> ${d.pages.slice(0,8).join(', ')}</div>` : ''}`;
    // highlight neighbors
    const neighborIds = new Set([d.id]);
    links.forEach(l => {
      if ((l.source.id||l.source) === d.id) neighborIds.add(l.target.id||l.target);
      if ((l.target.id||l.target) === d.id) neighborIds.add(l.source.id||l.source);
    });
    node.selectAll('circle').classed('highlight', n => n.id===d.id);
    link.classed('dim', l => !( (l.source.id||l.source)===d.id || (l.target.id||l.target)===d.id ));
  });
  node.on('mouseleave', () => {
    info.classList.remove('show');
    node.selectAll('circle').classed('highlight', false);
    link.classed('dim', false);
  });

  treeSim.on('tick', () => {
    link.attr('d', d => {
      const sx=d.source.x, sy=d.source.y, tx=d.target.x, ty=d.target.y;
      const mx=(sx+tx)/2, my=(sy+ty)/2;
      // curved path
      const dx=tx-sx, dy=ty-sy, dr=Math.sqrt(dx*dx+dy*dy)*1.4;
      return `M${sx},${sy} A${dr},${dr} 0 0,1 ${tx},${ty}`;
    });
    node.attr('transform', d => `translate(${d.x},${d.y})`);
  });
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
        // if OCR is in flight or just finished, refresh current page reader
        const pagesVisible = $('.tab-pane[data-pane="pages"].active');
        if (pagesVisible) {
          const ocrAdvanced = (m.book.ocr_done || 0) > (prev.ocr_done || 0);
          const noTextYet = !state.pageData?.text;
          if (ocrAdvanced || (m.book.ocr_status === 'done' && noTextYet)) {
            loadPage(state.currentPage);
          }
        }
        // if extract just completed, refresh people
        const peopleVisible = $('.tab-pane[data-pane="people"].active');
        const treeVisible = $('.tab-pane[data-pane="tree"].active');
        if ((peopleVisible || treeVisible) && m.book.extract_status === 'done') {
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
