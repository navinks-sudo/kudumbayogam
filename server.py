"""Knanayology Family Books — control portal on http://127.0.0.1:5434"""
import json, os, sys, io, re, threading, queue, time, urllib.request, traceback, base64
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from PIL import Image
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, StreamingResponse, FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import uvicorn

# our pipeline
import pipeline as PL

ROOT = Path(__file__).parent.resolve()
PDF_DIR = ROOT / 'pdfs'
CACHE_DIR = ROOT / 'cache'
INDEX_PATH = ROOT / 'books_index.json'
STATIC_DIR = ROOT / 'static'
PDF_DIR.mkdir(exist_ok=True)
CACHE_DIR.mkdir(exist_ok=True)
STATIC_DIR.mkdir(exist_ok=True)

UA = {'User-Agent': 'Mozilla/5.0 (compatible; FamilyBookArchiver/1.0)'}

# ----------------------------------------------------------------------------
# Book state
# ----------------------------------------------------------------------------
def slugify(s: str) -> str:
    s = re.sub(r'[^\w\s-]', '', s, flags=re.UNICODE).strip()
    s = re.sub(r'\s+', '_', s)
    return s[:80] or 'book'

def load_books():
    raw = json.loads(INDEX_PATH.read_text(encoding='utf-8'))
    seen = {}
    out = []
    for b in raw:
        s = slugify(b['title'])
        seen[s] = seen.get(s, 0) + 1
        if seen[s] > 1:
            s = f"{s}_{b['id']}"
        b['slug'] = s
        b['status'] = 'idle'
        b['downloaded'] = 0
        b['error'] = None
        b['pdf_size'] = 0
        # OCR / ingest / extract progress
        b['ocr_done'] = 0
        b['ingest_chunks'] = 0
        b['extract_people'] = 0
        b['extract_status'] = 'idle'
        b['ocr_status'] = 'idle'
        b['ingest_status'] = 'idle'
        # detect pre-existing
        cdir = CACHE_DIR / s
        if cdir.is_dir():
            b['downloaded'] = sum(1 for p in cdir.iterdir() if p.suffix == '.jpg' and p.stat().st_size > 1024)
        pdf = PDF_DIR / f"{s}.pdf"
        if pdf.exists() and pdf.stat().st_size > 10 * 1024:
            b['status'] = 'done'
            b['pdf_size'] = pdf.stat().st_size
        # OCR pre-existing count
        ocrdir = ROOT / 'data' / s / 'ocr'
        if ocrdir.is_dir():
            b['ocr_done'] = sum(1 for p in ocrdir.iterdir() if p.suffix == '.json')
            if b['ocr_done'] >= b['pages']:
                b['ocr_status'] = 'done'
        # ingest count (chroma)
        try:
            cnt = PL.collection_for(s).count()
            b['ingest_chunks'] = cnt
            if cnt > 0: b['ingest_status'] = 'done'
        except Exception:
            pass
        # extract pre-existing
        ppl = PL.load_people(s)
        if ppl:
            b['extract_people'] = len(ppl.get('people', []))
            b['extract_status'] = 'done'
        out.append(b)
    return out

BOOKS = load_books()
BOOKS_BY_ID = {b['id']: b for b in BOOKS}

# ----------------------------------------------------------------------------
# Event bus (SSE)
# ----------------------------------------------------------------------------
SUBSCRIBERS: list[queue.Queue] = []
SUBS_LOCK = threading.Lock()

def broadcast(event: dict):
    msg = json.dumps(event, ensure_ascii=False)
    with SUBS_LOCK:
        dead = []
        for q in SUBSCRIBERS:
            try: q.put_nowait(msg)
            except Exception: dead.append(q)
        for q in dead: SUBSCRIBERS.remove(q)

def update_book(b, **changes):
    b.update(changes)
    broadcast({'type': 'book', 'book': public_book(b)})

PUBLIC_FIELDS = ('id','title','slug','pages','base','post','status','downloaded','error',
                 'pdf_size','ocr_status','ocr_done','ingest_status','ingest_chunks',
                 'extract_status','extract_people')
def public_book(b):
    return {k: b.get(k) for k in PUBLIC_FIELDS}

# ----------------------------------------------------------------------------
# Worker engine — multiple stages can run in parallel across books, but
# only one stage per book at a time.
# ----------------------------------------------------------------------------
STOP_FLAG = threading.Event()
WORKER_THREAD = None
WORKER_LOCK = threading.Lock()
PER_BOOK_LOCKS: dict[int, threading.Lock] = {}

def book_lock(bid: int) -> threading.Lock:
    if bid not in PER_BOOK_LOCKS:
        PER_BOOK_LOCKS[bid] = threading.Lock()
    return PER_BOOK_LOCKS[bid]

# -------- scrape (PDF download/build) --------
def download_page(url, dest, retries=4):
    if dest.exists() and dest.stat().st_size > 1024: return True
    for i in range(retries):
        if STOP_FLAG.is_set(): return False
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
            if len(data) < 1024: raise IOError(f"too small ({len(data)} bytes)")
            tmp = dest.with_suffix('.part'); tmp.write_bytes(data); tmp.replace(dest)
            return True
        except Exception:
            if i == retries - 1: return False
            time.sleep(1.2 * (i + 1))
    return False

def scrape_book(b):
    base, pages, slug = b['base'], b['pages'], b['slug']
    cdir = CACHE_DIR / slug; cdir.mkdir(exist_ok=True)
    update_book(b, status='downloading', error=None)
    todo, have = [], 0
    for n in range(1, pages + 1):
        dest = cdir / f"{n}.jpg"
        (have := have + 1) if (dest.exists() and dest.stat().st_size > 1024) else todo.append((n, dest))
    update_book(b, downloaded=have)
    if todo:
        with ThreadPoolExecutor(max_workers=10) as ex:
            futs = {ex.submit(download_page, f"{base}/files/mobile/{n}.jpg", dest): (n, dest) for n, dest in todo}
            for f in as_completed(futs):
                if STOP_FLAG.is_set():
                    update_book(b, status='stopped'); return
                if f.result():
                    have += 1
                    if have % 3 == 0 or have == pages: update_book(b, downloaded=have)
        update_book(b, downloaded=have)
    if STOP_FLAG.is_set():
        update_book(b, status='stopped'); return

    update_book(b, status='building')
    pdf_path = PDF_DIR / f"{slug}.pdf"
    if pdf_path.exists() and pdf_path.stat().st_size > 10 * 1024:
        update_book(b, status='done', pdf_size=pdf_path.stat().st_size); return
    imgs, missing = [], []
    for n in range(1, pages + 1):
        p = cdir / f"{n}.jpg"
        if not (p.exists() and p.stat().st_size > 1024): missing.append(n); continue
        try:
            im = Image.open(p); im.load()
            if im.mode != 'RGB': im = im.convert('RGB')
            imgs.append(im)
        except Exception: missing.append(n)
    if not imgs:
        update_book(b, status='error', error=f"no images (missing {len(missing)})"); return
    try:
        tmp = pdf_path.with_suffix('.pdf.part')
        imgs[0].save(tmp, format='PDF', save_all=True, append_images=imgs[1:], resolution=150.0)
        tmp.replace(pdf_path)
        update_book(b, status='done', pdf_size=pdf_path.stat().st_size)
    except Exception as e:
        update_book(b, status='error', error=f"PDF build failed: {e}")

def worker_loop(book_ids):
    try:
        for bid in book_ids:
            if STOP_FLAG.is_set(): break
            b = BOOKS_BY_ID.get(bid)
            if not b or b['status'] == 'done': continue
            try: scrape_book(b)
            except Exception as e:
                update_book(b, status='error', error=f"{e}\n{traceback.format_exc()[:500]}")
    finally:
        broadcast({'type': 'run_end'})
        global WORKER_THREAD; WORKER_THREAD = None

# -------- pipeline workers (per-book threaded) --------
def stage_ocr(b):
    with book_lock(b['id']):
        update_book(b, ocr_status='running', error=None)
        def prog(d, t): update_book(b, ocr_done=d)
        try:
            r = PL.run_ocr(b['slug'], b['pages'], on_progress=prog,
                           should_stop=lambda: STOP_FLAG.is_set(), workers=3)
            update_book(b, ocr_status='done' if r['done'] >= b['pages'] else 'partial', ocr_done=r['done'])
        except Exception as e:
            update_book(b, ocr_status='error', error=f"OCR failed: {e}")

def stage_ingest(b):
    with book_lock(b['id']):
        update_book(b, ingest_status='running', error=None)
        try:
            r = PL.run_ingest(b['slug'], b['pages'])
            update_book(b, ingest_status='done', ingest_chunks=r['chunks'])
        except Exception as e:
            update_book(b, ingest_status='error', error=f"Ingest failed: {e}")

def stage_extract(b):
    with book_lock(b['id']):
        if not PL.llm_available():
            update_book(b, extract_status='error', error="No LLM API key configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY."); return
        update_book(b, extract_status='running', error=None)
        try:
            r = PL.run_extract(b['slug'], b['pages'],
                               on_progress=lambda d,t: None,
                               should_stop=lambda: STOP_FLAG.is_set())
            update_book(b, extract_status='done', extract_people=r['people'])
        except Exception as e:
            update_book(b, extract_status='error', error=f"Extract failed: {e}")

# ----------------------------------------------------------------------------
# FastAPI
# ----------------------------------------------------------------------------
app = FastAPI(title="Knanayology Family Book Archiver")

@app.get("/")
def index():
    return FileResponse(STATIC_DIR / 'index.html')

@app.get("/api/books")
def api_books():
    return [public_book(b) for b in BOOKS]

@app.get("/api/health")
def api_health():
    return {
        "books": len(BOOKS),
        "llm_available": PL.llm_available(),
        "llm_provider": PL.llm_provider_name(),
        "tessdata": str(PL.TESSDATA),
    }

class StartReq(BaseModel):
    ids: list[int] | None = None

@app.post("/api/start")
def api_start(req: StartReq):
    global WORKER_THREAD
    with WORKER_LOCK:
        if WORKER_THREAD and WORKER_THREAD.is_alive():
            raise HTTPException(409, "already running")
        STOP_FLAG.clear()
        ids = req.ids if req.ids else [b['id'] for b in BOOKS if b['status'] != 'done']
        for bid in ids:
            b = BOOKS_BY_ID.get(bid)
            if b and b['status'] != 'done':
                update_book(b, status='queued', error=None)
        WORKER_THREAD = threading.Thread(target=worker_loop, args=(ids,), daemon=True)
        WORKER_THREAD.start()
        broadcast({'type': 'run_start', 'count': len(ids)})
    return {'started': len(ids)}

@app.post("/api/stop")
def api_stop():
    STOP_FLAG.set()
    return {'stopping': True}

# -------- pipeline endpoints --------
@app.get("/api/book/{bid}")
def api_book(bid: int):
    b = BOOKS_BY_ID.get(bid)
    if not b: raise HTTPException(404, "no such book")
    return public_book(b)

@app.post("/api/book/{bid}/ocr")
def api_book_ocr(bid: int):
    b = BOOKS_BY_ID.get(bid)
    if not b: raise HTTPException(404)
    if b['status'] != 'done':
        raise HTTPException(400, "Bind PDF first (download pages)")
    threading.Thread(target=stage_ocr, args=(b,), daemon=True).start()
    return {'started': True}

@app.post("/api/book/{bid}/ingest")
def api_book_ingest(bid: int):
    b = BOOKS_BY_ID.get(bid)
    if not b: raise HTTPException(404)
    if b['ocr_done'] == 0:
        raise HTTPException(400, "Run OCR first")
    threading.Thread(target=stage_ingest, args=(b,), daemon=True).start()
    return {'started': True}

@app.post("/api/book/{bid}/extract")
def api_book_extract(bid: int):
    b = BOOKS_BY_ID.get(bid)
    if not b: raise HTTPException(404)
    if b['ocr_done'] == 0:
        raise HTTPException(400, "Run OCR first")
    if not PL.llm_available():
        raise HTTPException(400, "ANTHROPIC_API_KEY not set — required for relationship extraction")
    threading.Thread(target=stage_extract, args=(b,), daemon=True).start()
    return {'started': True}

@app.get("/api/book/{bid}/page/{n}")
def api_book_page(bid: int, n: int):
    b = BOOKS_BY_ID.get(bid)
    if not b: raise HTTPException(404)
    if n < 1 or n > b['pages']:
        raise HTTPException(404, "page out of range")
    ocr = PL.load_page_ocr(b['slug'], n) or {}
    return {'page': n, 'image_url': f"/cache/{b['slug']}/{n}.jpg",
            'text': ocr.get('text', ''), 'lang': ocr.get('lang', 'unk')}

class TranslateReq(BaseModel):
    text: str
    target: str = "English"

@app.post("/api/translate")
def api_translate(req: TranslateReq):
    if not PL.llm_available():
        raise HTTPException(400, "No LLM API key configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY.")
    try:
        out = PL.translate_text(req.text, req.target)
        return {'translation': out}
    except Exception as e:
        raise HTTPException(500, str(e))

class ChatReq(BaseModel):
    message: str
    history: list[dict] = []

@app.post("/api/book/{bid}/chat")
def api_book_chat(bid: int, req: ChatReq):
    b = BOOKS_BY_ID.get(bid)
    if not b: raise HTTPException(404)
    if not PL.llm_available():
        raise HTTPException(400, "No LLM API key configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY.")
    if b['ingest_chunks'] == 0:
        raise HTTPException(400, "Ingest the book into the vector store first")
    try:
        return PL.chat(b['slug'], b['title'], req.message, req.history)
    except Exception as e:
        msg = str(e)
        if 'insufficient_quota' in msg or 'exceeded your current quota' in msg:
            raise HTTPException(402, f"OpenAI account has no credit balance. "
                                     f"Add credit at https://platform.openai.com/settings/organization/billing")
        if 'invalid_api_key' in msg or 'Incorrect API key' in msg:
            raise HTTPException(401, "Invalid API key")
        raise HTTPException(500, msg)

@app.get("/api/book/{bid}/people")
def api_book_people(bid: int):
    b = BOOKS_BY_ID.get(bid)
    if not b: raise HTTPException(404)
    data = PL.load_people(b['slug'])
    return data or {'people': [], 'relationships': []}

# -------- SSE --------
@app.get("/api/events")
def api_events():
    q: queue.Queue = queue.Queue(maxsize=200)
    with SUBS_LOCK: SUBSCRIBERS.append(q)
    def gen():
        snapshot = json.dumps({'type':'snapshot','books':[public_book(b) for b in BOOKS]}, ensure_ascii=False)
        yield f"data: {snapshot}\n\n"
        try:
            while True:
                try:
                    msg = q.get(timeout=15)
                    yield f"data: {msg}\n\n"
                except queue.Empty:
                    yield ": ping\n\n"
        except GeneratorExit:
            with SUBS_LOCK:
                if q in SUBSCRIBERS: SUBSCRIBERS.remove(q)
    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={'Cache-Control':'no-cache','X-Accel-Buffering':'no'})

# -------- file serving --------
@app.get("/pdfs/{slug}.pdf")
def get_pdf(slug: str):
    p = PDF_DIR / f"{slug}.pdf"
    if not p.exists(): raise HTTPException(404)
    return FileResponse(p, media_type='application/pdf', filename=f"{slug}.pdf")

@app.get("/cache/{slug}/{name}")
def get_page_image(slug: str, name: str):
    # security: no traversal
    if '..' in slug or '..' in name or '/' in name or '\\' in name:
        raise HTTPException(400)
    p = CACHE_DIR / slug / name
    if not p.exists(): raise HTTPException(404)
    return FileResponse(p, media_type='image/jpeg')

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

if __name__ == "__main__":
    print("Starting on http://127.0.0.1:5434")
    uvicorn.run(app, host="127.0.0.1", port=5434, log_level="warning")
