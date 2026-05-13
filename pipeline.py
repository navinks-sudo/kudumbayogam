"""Knowledge pipeline: OCR -> Embed -> RAG chat -> Relationship extraction.

Stages per book:
  1. OCR each page image (cache/<slug>/<n>.jpg) -> data/<slug>/ocr/<n>.json
  2. Chunk OCR text -> embed -> store in chromadb (collection per book)
  3. Run LLM extraction across chunks -> data/<slug>/people.json + tree.json
"""
from __future__ import annotations
import os, json, re, threading, time, traceback, base64, io
from pathlib import Path
from typing import Optional, Callable, Iterable
from concurrent.futures import ThreadPoolExecutor, as_completed
from PIL import Image
import chromadb
from chromadb.utils.embedding_functions import DefaultEmbeddingFunction

ROOT = Path(__file__).parent.resolve()

# -- Storage paths -----------------------------------------------------------
CACHE_DIR  = ROOT / "cache"
DATA_DIR   = ROOT / "data"
CHROMA_DIR = ROOT / "data" / "chroma"
DATA_DIR.mkdir(exist_ok=True)
CHROMA_DIR.mkdir(parents=True, exist_ok=True)

def book_dir(slug: str) -> Path:
    d = DATA_DIR / slug
    (d / "ocr").mkdir(parents=True, exist_ok=True)
    return d

# -- ChromaDB + embeddings ---------------------------------------------------
_chroma_lock = threading.Lock()
_chroma_client = None
GEMINI_EMBED_MODEL = os.environ.get("GEMINI_EMBED_MODEL", "gemini-embedding-001")
EMBED_PROVIDER = os.environ.get("EMBED_PROVIDER", "auto").lower()
#   auto    → gemini if Gemini key set, else local ONNX MiniLM
#   gemini  → force Gemini text-embedding-004
#   local   → force local MiniLM

class GeminiEmbedFn:
    """ChromaDB-compatible embedding function backed by Gemini text-embedding-004.
    Uses RETRIEVAL_DOCUMENT for documents and RETRIEVAL_QUERY for queries (set
    externally via .as_query()).
    """
    def __init__(self, model: str = GEMINI_EMBED_MODEL, task_type: str = "RETRIEVAL_DOCUMENT"):
        self.model = model
        self.task_type = task_type

    def name(self) -> str:                  # chromadb uses this for identification
        return f"gemini:{self.model}"

    def as_query(self) -> "GeminiEmbedFn":
        return GeminiEmbedFn(self.model, task_type="RETRIEVAL_QUERY")

    def __call__(self, input):
        from google.genai import types
        prov, client = llm()
        if prov != "gemini":
            raise RuntimeError("Gemini embeddings require GEMINI_API_KEY")
        if isinstance(input, str):
            input = [input]
        out: list[list[float]] = []
        BATCH = 100
        for i in range(0, len(input), BATCH):
            chunk = input[i:i+BATCH]
            last_err = None
            for attempt in range(4):
                try:
                    resp = client.models.embed_content(
                        model=self.model,
                        contents=chunk,
                        config=types.EmbedContentConfig(task_type=self.task_type),
                    )
                    out.extend([list(e.values) for e in resp.embeddings])
                    break
                except Exception as e:
                    last_err = e
                    msg = str(e).lower()
                    if any(s in msg for s in ("503","unavailable","overloaded","rate_limit","timeout","high demand")):
                        time.sleep(1.5 * (attempt + 1)); continue
                    raise
            else:
                raise last_err  # type: ignore
        return out

_local_embed_fn = None
_gemini_embed_fn = None

def _pick_embed_provider() -> str:
    if EMBED_PROVIDER == "gemini":
        if _detect_provider() != "gemini":
            raise RuntimeError("EMBED_PROVIDER=gemini but no Gemini key configured")
        return "gemini"
    if EMBED_PROVIDER == "local": return "local"
    # auto
    return "gemini" if _detect_provider() == "gemini" else "local"

def doc_embed_fn():
    global _local_embed_fn, _gemini_embed_fn
    if _pick_embed_provider() == "gemini":
        if _gemini_embed_fn is None:
            _gemini_embed_fn = GeminiEmbedFn()
        return _gemini_embed_fn
    if _local_embed_fn is None:
        _local_embed_fn = DefaultEmbeddingFunction()
    return _local_embed_fn

def embed_provider_name() -> str:
    return _pick_embed_provider()

def chroma() -> chromadb.api.ClientAPI:
    global _chroma_client
    with _chroma_lock:
        if _chroma_client is None:
            _chroma_client = chromadb.PersistentClient(path=str(CHROMA_DIR))
        return _chroma_client

def collection_for(slug: str):
    name = f"book_{slug}"[:60]
    return chroma().get_or_create_collection(
        name=name, embedding_function=doc_embed_fn(),
        metadata={"hnsw:space": "cosine"}
    )

def wipe_index(slug: str) -> None:
    """Drop the entire ChromaDB collection for one book — used when switching embed providers."""
    try:
        chroma().delete_collection(name=f"book_{slug}"[:60])
    except Exception:
        pass

# -- LLM (auto-detect Anthropic / OpenAI / Gemini) ---------------------------
# Provider precedence: ANTHROPIC_API_KEY > OPENAI_API_KEY > GEMINI_API_KEY.
# Override with LLM_PROVIDER=anthropic|openai|gemini.
_llm_client = None
_llm_lock = threading.Lock()
_llm_provider: Optional[str] = None  # "anthropic" | "openai" | "gemini"

CLAUDE_CHAT_MODEL    = os.environ.get("CLAUDE_CHAT_MODEL",    "claude-sonnet-4-5-20250929")
CLAUDE_FAST_MODEL    = os.environ.get("CLAUDE_FAST_MODEL",    "claude-haiku-4-5-20251001")
OPENAI_CHAT_MODEL    = os.environ.get("OPENAI_CHAT_MODEL",    "gpt-4o-mini")
OPENAI_FAST_MODEL    = os.environ.get("OPENAI_FAST_MODEL",    "gpt-4o-mini")
GEMINI_CHAT_MODEL    = os.environ.get("GEMINI_CHAT_MODEL",    "gemini-2.5-flash")
GEMINI_FAST_MODEL    = os.environ.get("GEMINI_FAST_MODEL",    "gemini-2.5-flash")
# Vision OCR needs the full flash model — lite produces empty/degenerate output on ornamented pages
GEMINI_OCR_MODEL     = os.environ.get("GEMINI_OCR_MODEL",     "gemini-2.5-flash")

def _detect_provider() -> Optional[str]:
    forced = os.environ.get("LLM_PROVIDER", "").strip().lower()
    if forced in ("anthropic", "openai", "gemini"):
        return forced
    if os.environ.get("ANTHROPIC_API_KEY"): return "anthropic"
    if os.environ.get("OPENAI_API_KEY"):    return "openai"
    if os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY"): return "gemini"
    return None

def llm():
    """Returns (provider, client) or raises if no key configured."""
    global _llm_client, _llm_provider
    with _llm_lock:
        if _llm_client is None:
            prov = _detect_provider()
            if prov == "anthropic":
                from anthropic import Anthropic
                _llm_client = Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
            elif prov == "openai":
                from openai import OpenAI
                _llm_client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
            elif prov == "gemini":
                from google import genai
                key = os.environ.get("GEMINI_API_KEY") or os.environ["GOOGLE_API_KEY"]
                _llm_client = genai.Client(api_key=key)
            else:
                raise RuntimeError(
                    "No LLM API key configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY."
                )
            _llm_provider = prov
        return _llm_provider, _llm_client

def llm_available() -> bool:
    return _detect_provider() is not None

def llm_provider_name() -> str:
    p = _detect_provider()
    if p == "anthropic": return "Claude"
    if p == "openai":    return "OpenAI"
    if p == "gemini":    return "Gemini"
    return "(none)"

def _llm_complete(system: str, messages: list[dict], max_tokens: int = 1024,
                  fast: bool = False, retries: int = 3, want_json: bool = False) -> str:
    """Provider-agnostic completion with retry on transient errors.
    want_json=True asks the provider to return strict JSON (when supported).
    """
    last_err = None
    for attempt in range(retries):
        try:
            return _llm_complete_once(system, messages, max_tokens, fast, want_json)
        except Exception as e:
            last_err = e
            msg = str(e).lower()
            transient = any(s in msg for s in (
                "503", "unavailable", "overloaded", "rate_limit", "rate limit",
                "timeout", "timed out", "high demand", "try again",
            ))
            if not transient or attempt == retries - 1:
                raise
            time.sleep(2.0 * (attempt + 1))
    raise last_err  # unreachable

# JSON schema for relationship extraction — used by Gemini strict mode
EXTRACT_JSON_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "people": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "id": {"type": "STRING"},
                    "name": {"type": "STRING"},
                    "name_native": {"type": "STRING"},
                    "gender": {"type": "STRING"},
                    "birth": {"type": "STRING"},
                    "death": {"type": "STRING"},
                    "notes": {"type": "STRING"},
                    "pages": {"type": "ARRAY", "items": {"type": "INTEGER"}},
                },
                "required": ["id", "name"],
            },
        },
        "relationships": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "from":  {"type": "STRING"},
                    "to":    {"type": "STRING"},
                    "type":  {"type": "STRING"},
                    "notes": {"type": "STRING"},
                    "pages": {"type": "ARRAY", "items": {"type": "INTEGER"}},
                },
                "required": ["from", "to", "type"],
            },
        },
    },
    "required": ["people", "relationships"],
}

def _llm_complete_once(system: str, messages: list[dict], max_tokens: int,
                       fast: bool, want_json: bool = False) -> str:
    prov, client = llm()
    if prov == "anthropic":
        model = CLAUDE_FAST_MODEL if fast else CLAUDE_CHAT_MODEL
        resp = client.messages.create(
            model=model, max_tokens=max_tokens, system=system, messages=messages
        )
        return "".join(b.text for b in resp.content if hasattr(b, "text"))
    elif prov == "openai":
        model = OPENAI_FAST_MODEL if fast else OPENAI_CHAT_MODEL
        oa_msgs = [{"role": "system", "content": system}] + messages
        resp = client.chat.completions.create(
            model=model, messages=oa_msgs, max_tokens=max_tokens
        )
        return resp.choices[0].message.content or ""
    else:  # gemini
        from google.genai import types
        model = GEMINI_FAST_MODEL if fast else GEMINI_CHAT_MODEL
        contents = []
        for m in messages:
            role = "user" if m["role"] == "user" else "model"
            contents.append(types.Content(role=role,
                                          parts=[types.Part(text=m["content"])]))
        # Cap effective output and disable thinking so the budget goes to JSON.
        cfg_kwargs = dict(
            system_instruction=system,
            max_output_tokens=max(max_tokens, 16384) if want_json else max_tokens,
            thinking_config=types.ThinkingConfig(thinking_budget=0),
        )
        if want_json:
            cfg_kwargs["response_mime_type"] = "application/json"
            cfg_kwargs["response_schema"] = EXTRACT_JSON_SCHEMA
        resp = client.models.generate_content(
            model=model, contents=contents,
            config=types.GenerateContentConfig(**cfg_kwargs),
        )
        text = getattr(resp, "text", "") or ""
        # If we asked for JSON but got something truncated, surface the finish_reason.
        if want_json and resp.candidates:
            fr = resp.candidates[0].finish_reason
            if fr and str(fr) not in ("FinishReason.STOP", "STOP", "1"):
                raise RuntimeError(f"Gemini stopped early: {fr}; got {len(text)} chars")
        return text

# ============================================================================
# Stage 1 — OCR
# ============================================================================
OCR_PROMPT = (
    "You are a precise OCR engine for Indic-script family directories.\n"
    "Read all visible PROSE TEXT on this page exactly as printed.\n"
    "Preserve original scripts (Malayalam, Hindi, Tamil, English) — do NOT translate or transliterate.\n"
    "Preserve line order. Use tab or pipe '|' for table column separators.\n\n"
    "STRICT RULES:\n"
    "  • DO NOT transcribe decorative borders or ornaments — long runs of "
    "    'oooo', '====', '----', '••••', repeated dots, asterisks, page-edge circles "
    "    or corner flourishes. Skip them entirely.\n"
    "  • If you find yourself about to repeat the same character more than 10 times in a row, STOP.\n"
    "  • Page-number badges embedded in ornaments: include only the number, not the surrounding decoration.\n"
    "  • Stamps and watermarks: transcribe their legible text once, then move on.\n\n"
    "Output ONLY the extracted text. No preamble, no markdown fences, no explanation."
)

_DEGEN_RE = re.compile(r'(.)\1{30,}', re.DOTALL)

def _is_degenerate_ocr(text: str) -> bool:
    """Detect OCR output stuck in a repetition loop (e.g. '00000000…')."""
    if not text or len(text) < 40: return False
    if _DEGEN_RE.search(text): return True
    # any single non-whitespace char making up > 45% of the output is suspicious
    from collections import Counter
    chars = [c for c in text if not c.isspace()]
    if not chars: return False
    most, n = Counter(chars).most_common(1)[0]
    return (n / len(chars)) > 0.45

def _gemini_ocr_call(client, img_bytes: bytes, mime: str, prompt: str) -> str:
    from google.genai import types
    resp = client.models.generate_content(
        model=GEMINI_OCR_MODEL,
        contents=[
            types.Part.from_bytes(data=img_bytes, mime_type=mime),
            prompt,
        ],
        config=types.GenerateContentConfig(
            max_output_tokens=8192,
            temperature=0.2,                         # tiny non-zero — breaks repetition loops
            thinking_config=types.ThinkingConfig(thinking_budget=0),
        ),
    )
    return (getattr(resp, "text", "") or "").strip()

def ocr_page(img_path: Path) -> dict:
    """Gemini-vision OCR (Gemini-only — Tesseract removed).
    Up to two passes: first with the standard prompt, then with a stricter
    one if the output came back empty or in a degenerate repetition loop.
    """
    if _detect_provider() != "gemini":
        return {"text": "", "lang": "unk",
                "engine": "none",
                "error": "OCR requires GEMINI_API_KEY (Gemini-only)"}
    try:
        prov, client = llm()
        img_bytes = img_path.read_bytes()
        mime = "image/jpeg" if img_path.suffix.lower() in (".jpg", ".jpeg") else "image/png"

        text = _gemini_ocr_call(client, img_bytes, mime, OCR_PROMPT)
        if (not text.strip()) or _is_degenerate_ocr(text):
            strict = (OCR_PROMPT +
                      "\n\nIMPORTANT: the page may have decorative borders made of small circles, "
                      "dots or repeated symbols. IGNORE them entirely. "
                      "Find the actual sentence text on the page and transcribe ONLY that.")
            text2 = _gemini_ocr_call(client, img_bytes, mime, strict)
            if text2.strip() and not _is_degenerate_ocr(text2):
                text = text2
            else:
                return {"text": "", "lang": "unk",
                        "engine": f"gemini:{GEMINI_OCR_MODEL}",
                        "error": "Gemini returned empty or degenerate output after retry"}
        return {"text": text, "lang": detect_script(text),
                "engine": f"gemini:{GEMINI_OCR_MODEL}"}
    except Exception as e:
        return {"text": "", "lang": "unk",
                "engine": f"gemini:{GEMINI_OCR_MODEL}",
                "error": f"OCR failed: {e}"}

def _which_ocr() -> str:
    """Kept for /api/config — always 'gemini' now."""
    return "gemini"

def detect_script(text: str) -> str:
    if not text: return "unk"
    counts = {"mal":0, "hin":0, "tam":0, "eng":0, "other":0}
    for ch in text:
        cp = ord(ch)
        if 0x0D00 <= cp <= 0x0D7F: counts["mal"] += 1
        elif 0x0900 <= cp <= 0x097F: counts["hin"] += 1
        elif 0x0B80 <= cp <= 0x0BFF: counts["tam"] += 1
        elif 0x0041 <= cp <= 0x007A or 0x0061 <= cp <= 0x007A: counts["eng"] += 1
        elif ch.isalpha(): counts["other"] += 1
    return max(counts, key=counts.get) if any(counts.values()) else "unk"

def run_ocr(slug: str, total_pages: int, on_progress: Optional[Callable[[int, int], None]] = None,
            should_stop: Optional[Callable[[], bool]] = None, workers: int = 4) -> dict:
    """OCR every page of a book. Resumable (skips already-processed pages)."""
    bdir = book_dir(slug)
    cdir = CACHE_DIR / slug

    todo = []
    done = 0
    for n in range(1, total_pages + 1):
        out = bdir / "ocr" / f"{n}.json"
        if out.exists() and out.stat().st_size > 4:
            done += 1; continue
        img = cdir / f"{n}.jpg"
        if img.exists() and img.stat().st_size > 1024:
            todo.append((n, img, out))

    if on_progress: on_progress(done, total_pages)

    if not todo:
        return {"done": done, "total": total_pages}

    def task(item):
        n, img, out = item
        result = ocr_page(img)
        result["page"] = n
        out.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
        return n

    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = [ex.submit(task, it) for it in todo]
        for f in as_completed(futs):
            if should_stop and should_stop():
                for ff in futs: ff.cancel()
                break
            try:
                f.result()
                done += 1
                if on_progress: on_progress(done, total_pages)
            except Exception:
                pass

    return {"done": done, "total": total_pages}

def load_page_ocr(slug: str, n: int) -> Optional[dict]:
    f = book_dir(slug) / "ocr" / f"{n}.json"
    if not f.exists(): return None
    return json.loads(f.read_text(encoding="utf-8"))

def load_all_ocr(slug: str, pages: int) -> list[dict]:
    out = []
    for n in range(1, pages + 1):
        d = load_page_ocr(slug, n)
        if d: out.append(d)
        else: out.append({"page": n, "text": "", "lang": "unk"})
    return out

# ============================================================================
# Stage 2 — Chunk & embed
# ============================================================================
def chunk_text(text: str, chunk_size: int = 700, overlap: int = 120) -> list[str]:
    text = re.sub(r'\s+', ' ', text).strip()
    if not text: return []
    if len(text) <= chunk_size: return [text]
    chunks, i = [], 0
    while i < len(text):
        end = min(i + chunk_size, len(text))
        # try to break on whitespace for cleanliness
        if end < len(text):
            sp = text.rfind(' ', i + int(chunk_size * 0.6), end)
            if sp > 0: end = sp
        chunks.append(text[i:end].strip())
        if end >= len(text): break
        i = max(end - overlap, i + 1)
    return [c for c in chunks if len(c) > 25]

def run_ingest(slug: str, pages: int,
               on_progress: Optional[Callable[[int, int], None]] = None,
               should_stop: Optional[Callable[[], bool]] = None) -> dict:
    """Chunk all OCR'd pages and store embeddings in chroma.
    Calls on_progress(done_pages, total_pages, current_chunks) after each page
    and again after each embedding-write batch.
    """
    coll = collection_for(slug)
    try:
        existing = coll.get(include=[])
        if existing and existing.get("ids"):
            coll.delete(ids=existing["ids"])
    except Exception:
        pass

    def _emit(done: int, total: int, chunks: int):
        if not on_progress: return
        try: on_progress(done, total, chunks)
        except TypeError: on_progress(done, total)

    ids, docs, metas = [], [], []
    for n in range(1, pages + 1):
        page = load_page_ocr(slug, n)
        if page and page.get("text"):
            chunks = chunk_text(page["text"])
            for ci, c in enumerate(chunks):
                ids.append(f"{slug}_p{n}_c{ci}")
                docs.append(c)
                metas.append({"slug": slug, "page": n, "lang": page.get("lang","unk"), "chunk": ci})
        _emit(n, pages, len(docs))
        if should_stop and should_stop(): break

    if not docs:
        return {"chunks": 0}

    # Embed + write in batches. Each batch is the slowest part (Gemini API)
    # so we emit progress after every batch as well.
    BATCH = 100
    total_batches = (len(docs) + BATCH - 1) // BATCH
    for bi, i in enumerate(range(0, len(docs), BATCH), 1):
        coll.add(ids=ids[i:i+BATCH], documents=docs[i:i+BATCH], metadatas=metas[i:i+BATCH])
        # During the embed phase we map batches back to pages for nice progress.
        # Use a synthetic "done" = pages × (bi/total_batches) so the bar moves.
        if on_progress:
            try: on_progress(pages, pages, len(docs))
            except TypeError: on_progress(pages, pages)
        if should_stop and should_stop(): break

    return {"chunks": len(docs)}

def _vector_search(coll, query: str, k: int) -> list[dict]:
    """Single-call vector search."""
    try:
        if isinstance(doc_embed_fn(), GeminiEmbedFn):
            q_emb = GeminiEmbedFn().as_query()([query])
            r = coll.query(query_embeddings=q_emb, n_results=k)
        else:
            r = coll.query(query_texts=[query], n_results=k)
        out = []
        for i in range(len(r["ids"][0])):
            out.append({
                "id": r["ids"][0][i],
                "doc": r["documents"][0][i],
                "meta": r["metadatas"][0][i],
                "dist": r["distances"][0][i] if r.get("distances") else None,
                "src": "vector",
            })
        return out
    except Exception:
        return []

def _substring_search(coll, needle: str, k: int) -> list[dict]:
    """Literal-substring search through chunk documents — recall for exact names."""
    try:
        r = coll.get(where_document={"$contains": needle}, limit=k)
        out = []
        for i, _id in enumerate(r.get("ids", [])):
            out.append({
                "id": _id,
                "doc": r["documents"][i],
                "meta": r["metadatas"][i],
                "dist": 0.0,             # exact match — best possible
                "src": "substring",
            })
        return out
    except Exception:
        return []

_NAME_RE = re.compile(r"\b([A-Z][a-z]{2,})\b")

def _candidate_names(query: str) -> list[str]:
    """Pull capitalized words / multi-word names out of a question.

    Filters obvious English stopwords like 'Who', 'What', 'When', 'List', 'Tell'.
    """
    STOP = {"Who","What","When","Where","Why","How","List","Tell","Show","Did",
            "Does","Find","Give","Name","The","Is","Are","Was","Were","And",
            "Of","In","On","To","For","With","From","Book","Family"}
    # find runs of capitalized words (e.g., "Tony Pathyil", "Mar Joseph")
    tokens = []
    for m in re.finditer(r"\b[A-Z][\w’'-]+(?:\s+[A-Z][\w’'-]+){0,3}\b", query):
        s = m.group(0)
        # drop sentence-initial stopwords like "Who is …"
        if s in STOP: continue
        first = s.split()[0]
        if first in STOP and len(s.split()) > 1:
            s = " ".join(s.split()[1:])
        if s and s not in STOP: tokens.append(s)
    # dedupe preserving order
    seen, out = set(), []
    for t in tokens:
        if t.lower() not in seen:
            seen.add(t.lower()); out.append(t)
    return out

def search_pages(slug: str, query: str, mode: str = "hybrid", limit: int = 80) -> dict:
    """Hybrid search across OCR pages of a single book.

    Returns ranked pages with snippets, match counts, and a src flag.
    - lexical : substring matches on raw OCR text (exact recall)
    - semantic: vector retrieval (related concepts)
    - hybrid  : both, with lexical hits ranked above semantic
    """
    bdir = book_dir(slug)
    by_page: dict[int, dict] = {}

    # ---- Lexical pass — every substring match in every OCR file
    if mode in ("lexical", "hybrid") and query.strip():
        ql = query.lower()
        ocr_dir = bdir / "ocr"
        if ocr_dir.exists():
            files = sorted(ocr_dir.glob("*.json"), key=lambda p: int(p.stem))
            for f in files:
                try:
                    d = json.loads(f.read_text(encoding="utf-8"))
                except Exception:
                    continue
                text = d.get("text", "") or ""
                tl = text.lower()
                # collect all match positions
                positions = []
                i = 0
                while True:
                    j = tl.find(ql, i)
                    if j < 0: break
                    positions.append(j)
                    i = j + max(len(ql), 1)
                if not positions:
                    continue
                page = int(f.stem)
                snippets = []
                for p in positions[:3]:
                    s = max(0, p - 60)
                    e = min(len(text), p + len(query) + 100)
                    snippets.append({
                        "before": text[s:p],
                        "match":  text[p:p + len(query)],
                        "after":  text[p + len(query):e],
                    })
                by_page[page] = {
                    "page": page,
                    "match_count": len(positions),
                    "snippets": snippets,
                    "src": "lexical",
                    "lang": d.get("lang", "unk"),
                }

    # ---- Semantic pass — vector retrieval over indexed chunks
    if mode in ("semantic", "hybrid") and query.strip():
        try:
            hits = search(slug, query, k=12)
        except Exception:
            hits = []
        for h in hits:
            p = h.get("meta", {}).get("page")
            if p is None: continue
            if p in by_page: continue        # lexical wins
            by_page[p] = {
                "page": p,
                "match_count": 0,
                "snippets": [{
                    "before": "",
                    "match":  "",
                    "after":  (h.get("doc") or "")[:240],
                }],
                "src": "semantic",
                "dist": h.get("dist"),
                "lang": h.get("meta", {}).get("lang", "unk"),
            }

    sorted_results = sorted(
        by_page.values(),
        key=lambda r: (
            0 if r["src"] == "lexical" else 1,
            -r["match_count"],
            r.get("dist") or 1.0,
            r["page"],
        ),
    )
    return {
        "query": query,
        "mode": mode,
        "total": len(sorted_results),
        "lexical_count": sum(1 for r in sorted_results if r["src"] == "lexical"),
        "semantic_count": sum(1 for r in sorted_results if r["src"] == "semantic"),
        "results": sorted_results[:limit],
    }

def search(slug: str, query: str, k: int = 12) -> list[dict]:
    """Hybrid retrieval: vector + literal substring on detected proper nouns.
    Substring hits take priority (dist=0), then vector hits sorted by distance.
    """
    coll = collection_for(slug)
    pool: dict[str, dict] = {}

    # 1) primary vector pass
    for hit in _vector_search(coll, query, k=max(k, 16)):
        pool[hit["id"]] = hit

    # 2) per-name substring passes (recall for specific people)
    for name in _candidate_names(query)[:5]:
        for hit in _substring_search(coll, name, k=8):
            # substring hit wins over vector if same chunk
            pool[hit["id"]] = {**pool.get(hit["id"], {}), **hit}

    # 3) sort: substring matches first (dist=0), then vector by distance asc
    sorted_hits = sorted(
        pool.values(),
        key=lambda h: (0 if h.get("src") == "substring" else 1, h.get("dist") or 1.0),
    )
    return sorted_hits[:k]

# ============================================================================
# Stage 3 — Translation
# ============================================================================
def translate_text(text: str, target_lang: str = "English") -> str:
    if not text.strip(): return ""
    sys = ("You are an expert translator. Translate the provided text into "
           f"{target_lang}. Preserve names, dates, places, and numbers exactly. "
           "Output ONLY the translation — no preamble, no explanation.")
    return _llm_complete(sys, [{"role": "user", "content": text}],
                         max_tokens=4000, fast=True)

# ============================================================================
# Stage 4 — Smart chat (RAG)
# ============================================================================
def chat(slug: str, book_title: str, message: str, history: list[dict]) -> dict:
    hits = search(slug, message, k=14)
    # Annotate retrieval method so the model knows substring hits are exact-match
    context_parts = []
    for h in hits:
        tag = "EXACT" if h.get("src") == "substring" else "SEMANTIC"
        context_parts.append(f"[Page {h['meta']['page']} · {tag}]\n{h['doc']}")
    context = "\n\n".join(context_parts) or "(no relevant passages indexed)"

    # Also surface a compact derived view of the people graph so questions like
    # "who is the founder", "who is the most connected person", etc. can be
    # answered from the same source of truth as the Insights / Tree tabs.
    graph_view = ""
    try:
        ana = analyze(slug, book_title)
        if not ana.get("empty"):
            lines = []
            m = ana["metrics"]
            lines.append(f"Derived graph: {m['people']} people, {m['relationships']} relationships, "
                         f"{m['generations']} generations, {m['branches']} branches.")
            if ana.get("founders"):
                lines.append("Founders (no recorded parents): " +
                             "; ".join(f"{f['name']} ({f['descendants']} desc.)" for f in ana["founders"][:5]))
            if ana.get("hubs"):
                lines.append("Most connected: " +
                             "; ".join(f"{h['name']} ({h['degree']} ties)" for h in ana["hubs"][:5]))
            graph_view = "\n".join(lines)
    except Exception:
        pass

    sys = (
        f"You are a precise genealogist assistant for the family-history book \"{book_title}\".\n\n"
        "You are given (a) the most relevant OCR passages with page numbers, each tagged "
        "[Page N · EXACT] for exact-string matches or [Page N · SEMANTIC] for vector matches, "
        "and (b) a derived people-graph summary computed from the same book.\n\n"
        "CITATION RULES — strict:\n"
        "  • Every factual sentence MUST end with the page citation in the form [p.N].\n"
        "  • Cite EXACTLY the page where the fact appears in the passages — never invent a number.\n"
        "  • If a fact appears on multiple pages, cite the lowest page number, optionally followed by others: [p.5][p.12].\n"
        "  • [Page N · EXACT] passages are highest priority — the name you asked about literally appears there.\n\n"
        "HOW TO ANSWER:\n"
        "  1. Prefer facts you can cite from the passages with [p.N]. Cite EVERY factual claim.\n"
        "  2. Where compact family-tree notation appears in OCR — 'Tony+Bindhu' means Tony married Bindhu; "
        "     'Tessley and Tony' inside a children list means both are children of the named parents above. Read these correctly.\n"
        "  3. You MAY synthesise across passages — e.g. if a page lists generations or "
        "     identifies an ancestor with no parents, conclude they are the earliest known [p.N].\n"
        "  4. You MAY use the derived graph for structural questions (founder, hub, generations, branches), "
        "     but state it as 'derived from the book structure'.\n"
        "  5. If a person's existence is supported only by an EXACT match in a passage, say so — "
        "     do not deny their existence just because no narrative explains them.\n"
        "  6. If neither passages nor the derived graph support an answer, reply exactly:\n"
        "       'The book does not say.'\n"
        "  7. When a name is in Malayalam/Hindi/Tamil, give it once in original script, then transliterate.\n"
        "  8. Be concise. Use bullets for multiple items. No preamble, no sign-off.\n"
    )
    if graph_view:
        context = f"{context}\n\n[DERIVED PEOPLE-GRAPH SUMMARY]\n{graph_view}"

    msgs = []
    for h in history[-8:]:
        msgs.append({"role": h["role"], "content": h["content"]})
    msgs.append({"role": "user",
                 "content": f"Question: {message}\n\nRelevant passages from the book:\n{context}"})

    answer = _llm_complete(sys, msgs, max_tokens=1024, fast=False)

    # Auto-generate three precise follow-up questions grounded in the same passages.
    followups: list[str] = []
    try:
        f_sys = ("Given the user's question, the assistant's answer, and source passages, "
                 "propose THREE concise, specific follow-up questions the reader is most likely "
                 "to ask next about THIS BOOK. Output ONLY a JSON array of three short strings, no preamble.")
        f_body = (f"Question:\n{message}\n\nAnswer:\n{answer}\n\nPassages:\n{context}")
        raw = _llm_complete(f_sys, [{"role":"user","content":f_body}],
                            max_tokens=300, fast=True, want_json=False)
        raw = _strip_json(raw)
        if raw.startswith('['):
            arr = json.loads(raw)
            followups = [s for s in arr if isinstance(s, str)][:3]
    except Exception:
        pass

    return {
        "answer": answer,
        "sources": [{"page": h["meta"]["page"], "snippet": h["doc"][:240]} for h in hits],
        "followups": followups,
    }

# ============================================================================
# Stage 5 — People & relationship extraction
# ============================================================================
EXTRACT_SYSTEM = """You are an expert genealogist analyzing a family-directory book.
Extract a JSON object describing EVERY person mentioned and their relationships.

Output ONLY valid JSON, no preamble, no markdown fences. Schema:
{
  "people": [
    {"id": "p1", "name": "Full name (English transliteration)",
     "name_native": "Original-script name if non-English", "gender": "M|F|?",
     "birth": "year or null", "death": "year or null",
     "notes": "<=120 chars summary if anything notable",
     "pages": [12,15]}
  ],
  "relationships": [
    {"from": "p1", "to": "p2", "type": "parent|spouse|child|sibling|grandparent|uncle|aunt|cousin|in-law|other", "notes": "<=80 chars", "pages": [15]}
  ]
}

CRITICAL — common compact notations in family directories. Treat EVERY name token as a person, even when it appears in shorthand:
  • "A+B"           → A and B are a married COUPLE (spouse relationship between A and B)
  • "A & B" or "A and B" inside a list of children → A and B are SIBLINGS (siblings of each other, children of the row above)
  • Numbered list under a couple "1. X, 2. Y, 3. Z" → X, Y, Z are CHILDREN of that couple
  • Indented sub-list under a person → those names are descendants of that person
  • "Name (place)" → the location is a note, the person is "Name"

Rules:
- Use STABLE ids p1, p2, p3, … Reuse the same id when the same person appears in multiple passages.
- Capture EVERY single named person — even when the entry is just one or two words like "Tony+Bindhu" or "Tessley and Tony". Do not skip short entries.
- For non-Latin names, also Romanize and put the original in name_native.
- Surnames inferred from family branch headings should be appended to first-name-only entries (e.g. inside a "Pathiyil" subsection, "Tony+Bindhu" → "Tony Pathiyil" and "Bindhu" — Bindhu is the spouse marrying in, so keep just "Bindhu" unless her surname is given).
- Skip vague references ("his uncle", "the priest") unless a name follows.
- If a relationship is ambiguous, use type "other" and explain in notes.
- Do NOT cap the people list — this is a comprehensive family directory and may have hundreds of names.
"""

def _strip_json(s: str) -> str:
    """Extract a JSON object from a possibly-noisy LLM response."""
    s = s.strip()
    s = re.sub(r"^```(?:json)?\s*", "", s)
    s = re.sub(r"\s*```\s*$", "", s)
    s = s.strip()
    # If the model wrapped it in prose, find the outermost {...}
    if not s.startswith("{"):
        i = s.find("{")
        if i != -1: s = s[i:]
    if not s.endswith("}"):
        j = s.rfind("}")
        if j != -1: s = s[:j+1]
    return s.strip()

def _canonicalize_rel(a: str, b: str, t: str) -> tuple[str, str, str]:
    """Normalize a relationship so inverse / symmetric duplicates collapse.

    Rules:
      child(a→b)    ==  parent(b→a)   →  store as parent
      father/mother(a→b)               →  store as parent
      son/daughter(a→b)                →  store as parent(b→a)
      spouse, sibling                  →  symmetric, sort endpoints
    """
    t = (t or "other").lower().strip()
    if t in ("father", "mother"):                t = "parent"
    if t in ("son", "daughter"):                 t = "child"
    if t in ("husband", "wife", "partner"):      t = "spouse"
    if t in ("brother", "sister"):               t = "sibling"

    if t == "child":      return (b, a, "parent")
    if t in ("spouse", "sibling"):
        return tuple(sorted([a, b])) + (t,)      # type: ignore
    return (a, b, t)

def _merge_people(merged: dict, new_data: dict):
    """Merge new extraction into running people/relationships dict."""
    # name -> existing id
    name_idx = {p["name"].strip().lower(): pid for pid, p in merged["people"].items()}
    id_map = {}  # local id -> canonical id

    for p in new_data.get("people", []):
        if not p.get("name"): continue
        key = p["name"].strip().lower()
        if key in name_idx:
            cid = name_idx[key]
            ex = merged["people"][cid]
            # accumulate
            for f in ("birth","death","gender","name_native","notes"):
                if not ex.get(f) and p.get(f): ex[f] = p[f]
            ex["pages"] = sorted(set((ex.get("pages") or []) + (p.get("pages") or [])))
        else:
            cid = f"p{len(merged['people']) + 1}"
            merged["people"][cid] = {
                "id": cid,
                "name": p["name"],
                "name_native": p.get("name_native"),
                "gender": p.get("gender") or "?",
                "birth": p.get("birth"),
                "death": p.get("death"),
                "notes": p.get("notes"),
                "pages": list(p.get("pages") or []),
            }
            name_idx[key] = cid
        id_map[p.get("id","")] = cid

    for r in new_data.get("relationships", []):
        a = id_map.get(r.get("from"))
        b = id_map.get(r.get("to"))
        if not a or not b or a == b: continue
        ca, cb, ct = _canonicalize_rel(a, b, r.get("type", "other"))
        if (ca, cb, ct) in merged["rel_seen"]: continue
        merged["rel_seen"].add((ca, cb, ct))
        merged["relationships"].append({
            "from": ca, "to": cb, "type": ct,
            "notes": r.get("notes"), "pages": r.get("pages") or [],
        })

def run_extract(slug: str, pages: int, batch_pages: int = 4,
                on_progress: Optional[Callable[[int, int], None]] = None,
                should_stop: Optional[Callable[[], bool]] = None) -> dict:
    """Walk OCR text in batches, ask LLM to extract people, merge.

    Raises if ALL batches fail (e.g. quota / auth issues) so the UI surfaces it.
    """
    bdir = book_dir(slug)
    merged = {"people": {}, "relationships": [], "rel_seen": set()}
    out_path = bdir / "people.json"

    batches_attempted = 0
    batches_ok = 0
    last_err: Optional[str] = None

    n = 1
    while n <= pages:
        if should_stop and should_stop(): break
        lo = n
        hi = min(n + batch_pages - 1, pages)
        chunks = []
        for p in range(lo, hi + 1):
            page = load_page_ocr(slug, p)
            if not page or not page.get("text"): continue
            txt = page["text"][:2400]
            chunks.append(f"--- PAGE {p} ---\n{txt}")
        n = hi + 1

        if not chunks:
            if on_progress: on_progress(hi, pages)
            continue

        batches_attempted += 1
        body = "\n\n".join(chunks)
        try:
            raw = _llm_complete(EXTRACT_SYSTEM,
                                [{"role": "user", "content": body}],
                                max_tokens=8192, fast=False, want_json=True)
            try:
                data = json.loads(_strip_json(raw))
            except json.JSONDecodeError as je:
                dbg = bdir / f"extract_raw_{lo}_{hi}.txt"
                dbg.write_text(raw or "(empty)", encoding="utf-8")
                raise RuntimeError(f"JSON parse failed ({je}); raw saved to {dbg.name}") from je
            _merge_people(merged, data)
            batches_ok += 1
        except Exception as e:
            last_err = str(e)
            print(f"extract batch {lo}-{hi} failed:", e)

        # Persist partial results after every batch so the UI shows people streaming in.
        try:
            partial = {
                "people": list(merged["people"].values()),
                "relationships": merged["relationships"],
            }
            out_path.write_text(json.dumps(partial, ensure_ascii=False, indent=2),
                                encoding="utf-8")
        except Exception as e:
            print(f"partial people.json write failed: {e}")

        # Report progress with the running people count so the UI can update live.
        if on_progress:
            try: on_progress(hi, pages, len(merged["people"]))
            except TypeError:
                on_progress(hi, pages)

    # If every attempted batch failed, raise so caller marks status=error.
    if batches_attempted > 0 and batches_ok == 0:
        raise RuntimeError(
            f"All {batches_attempted} LLM batches failed. Last error: {last_err}"
        )

    final = {
        "people": list(merged["people"].values()),
        "relationships": merged["relationships"],
    }
    out_path.write_text(json.dumps(final, ensure_ascii=False, indent=2), encoding="utf-8")

    # Also write a GedcomX file — that becomes the canonical interchange format.
    try:
        write_gedcomx(slug)
    except Exception as e:
        print(f"GedcomX write failed for {slug}: {e}")

    return {"people": len(final["people"]),
            "relationships": len(final["relationships"]),
            "batches_ok": batches_ok,
            "batches_attempted": batches_attempted}

# ============================================================================
# Stage 5b — GedcomX export
# https://github.com/FamilySearch/gedcomx — open genealogy interchange format
# ============================================================================
GX_NS = "http://gedcomx.org/"

def to_gedcomx(slug: str, book_title: str = "") -> dict:
    """Convert our people.json into a GedcomX document."""
    data = load_people(slug) or {"people": [], "relationships": []}
    persons = []
    for p in data["people"]:
        person: dict = {"id": p["id"], "private": False}
        # primary name (Latin transliteration)
        names = []
        if p.get("name"):
            names.append({"nameForms": [{"fullText": p["name"], "lang": "en"}]})
        if p.get("name_native"):
            names.append({"nameForms": [{"fullText": p["name_native"], "lang": "ml"}]})
        if names: person["names"] = names
        # gender
        g = p.get("gender")
        if g == "M":
            person["gender"] = {"type": f"{GX_NS}Male"}
        elif g == "F":
            person["gender"] = {"type": f"{GX_NS}Female"}
        else:
            person["gender"] = {"type": f"{GX_NS}Unknown"}
        # facts
        facts = []
        if p.get("birth"):
            facts.append({"type": f"{GX_NS}Birth", "date": {"original": str(p["birth"])}})
        if p.get("death"):
            facts.append({"type": f"{GX_NS}Death", "date": {"original": str(p["death"])}})
        if facts: person["facts"] = facts
        # notes (from extraction)
        if p.get("notes"):
            person["notes"] = [{"text": p["notes"], "lang": "en"}]
        # source references — link back to the original page numbers
        pages = p.get("pages") or []
        if pages:
            person["sources"] = [
                {"description": f"#src-page-{n}"} for n in pages
            ]
        persons.append(person)

    # GedcomX relationship types
    type_map = {
        "parent":  f"{GX_NS}ParentChild",       # person1 = parent, person2 = child
        "spouse":  f"{GX_NS}Couple",
    }

    rels: list[dict] = []
    for i, r in enumerate(data.get("relationships", [])):
        a, b, t = r.get("from"), r.get("to"), (r.get("type") or "other").lower()
        gx_type = type_map.get(t)
        if not gx_type:
            # Map sibling / other to a custom URI per GedcomX extension guidance
            gx_type = f"{GX_NS}Custom/{t or 'other'}"
        rel = {
            "id": f"r{i+1}",
            "type": gx_type,
            "person1": {"resource": f"#{a}"},
            "person2": {"resource": f"#{b}"},
        }
        if r.get("notes"):
            rel["notes"] = [{"text": r["notes"]}]
        if r.get("pages"):
            rel["sources"] = [{"description": f"#src-page-{n}"} for n in r["pages"]]
        rels.append(rel)

    # Source descriptions per referenced page (so downstream readers can resolve)
    referenced_pages: set = set()
    for p in data["people"]:
        for n in (p.get("pages") or []): referenced_pages.add(n)
    for r in data.get("relationships", []):
        for n in (r.get("pages") or []): referenced_pages.add(n)
    source_descriptions = [
        {
            "id": f"src-page-{n}",
            "titles": [{"value": f"{book_title or slug} — page {n}"}],
            "resourceType": f"{GX_NS}PhysicalArtifact",
        } for n in sorted(referenced_pages)
    ]

    return {
        "description": book_title or slug,
        "lang": "en",
        "attribution": {
            "contributor": {"resource": "#heritage-vault"},
            "modified": int(time.time() * 1000),
            "changeMessage": "Auto-extracted from OCR by Gemini",
        },
        "persons": persons,
        "relationships": rels,
        "sourceDescriptions": source_descriptions,
    }

def write_gedcomx(slug: str, book_title: str = "") -> Path:
    gx = to_gedcomx(slug, book_title)
    path = book_dir(slug) / "family.gedcomx.json"
    path.write_text(json.dumps(gx, ensure_ascii=False, indent=2), encoding="utf-8")
    return path

def load_gedcomx(slug: str) -> Optional[dict]:
    path = book_dir(slug) / "family.gedcomx.json"
    if not path.exists(): return None
    return json.loads(path.read_text(encoding="utf-8"))

def _dedupe_relationships(rels: list[dict]) -> list[dict]:
    """Canonicalize + dedupe a relationship list (in-memory only)."""
    seen: set = set()
    out: list[dict] = []
    for r in rels or []:
        a, b = r.get("from"), r.get("to")
        if not a or not b or a == b: continue
        ca, cb, ct = _canonicalize_rel(a, b, r.get("type", "other"))
        if (ca, cb, ct) in seen: continue
        seen.add((ca, cb, ct))
        out.append({
            "from": ca, "to": cb, "type": ct,
            "notes": r.get("notes"),
            "pages": r.get("pages") or [],
        })
    return out

def load_people(slug: str) -> Optional[dict]:
    p = book_dir(slug) / "people.json"
    if not p.exists(): return None
    data = json.loads(p.read_text(encoding="utf-8"))
    raw_rels = data.get("relationships", [])
    deduped = _dedupe_relationships(raw_rels)
    # rewrite to disk if we made a change (one-time migration)
    if len(deduped) != len(raw_rels):
        data["relationships"] = deduped
        try: p.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception: pass
    else:
        data["relationships"] = deduped
    return data

# ============================================================================
# Stage 6 — Analytics & insights derived from the extracted graph
# ============================================================================
PARENT_TYPES   = {"parent", "child", "father", "mother", "son", "daughter"}
SPOUSE_TYPES   = {"spouse", "wife", "husband", "partner"}
SIBLING_TYPES  = {"sibling", "brother", "sister"}

def _build_graph(data: dict) -> dict:
    """Build adjacency views for fast traversal."""
    people = {p["id"]: p for p in data.get("people", [])}
    parents_of  = {pid: set() for pid in people}     # pid -> set of parent ids
    children_of = {pid: set() for pid in people}
    spouses_of  = {pid: set() for pid in people}
    siblings_of = {pid: set() for pid in people}
    all_neighbors = {pid: set() for pid in people}

    for r in data.get("relationships", []):
        a, b, t = r.get("from"), r.get("to"), (r.get("type") or "").lower()
        if a not in people or b not in people or a == b:
            continue
        all_neighbors[a].add(b); all_neighbors[b].add(a)
        if t in ("parent", "father", "mother"):
            parents_of[b].add(a);   children_of[a].add(b)
        elif t in ("child", "son", "daughter"):
            parents_of[a].add(b);   children_of[b].add(a)
        elif t in SPOUSE_TYPES:
            spouses_of[a].add(b);   spouses_of[b].add(a)
        elif t in SIBLING_TYPES:
            siblings_of[a].add(b);  siblings_of[b].add(a)
    return {
        "people": people,
        "parents_of": parents_of, "children_of": children_of,
        "spouses_of": spouses_of, "siblings_of": siblings_of,
        "all_neighbors": all_neighbors,
    }

def _generations(g: dict) -> dict[str, int]:
    """Assign generation index (0 = founders) using longest-parent-chain depth."""
    parents_of = g["parents_of"]
    memo: dict[str, int] = {}
    stack_in: set[str] = set()
    def depth(pid):
        if pid in memo: return memo[pid]
        if pid in stack_in: return 0   # cycle guard
        stack_in.add(pid)
        ps = parents_of.get(pid, set())
        d = 0 if not ps else 1 + max(depth(p) for p in ps)
        stack_in.discard(pid)
        memo[pid] = d
        return d
    for pid in g["people"]: depth(pid)
    return memo

def _connected_components(g: dict) -> list[set[str]]:
    """Undirected components — each = one branch/family unit."""
    nbrs = g["all_neighbors"]
    seen, comps = set(), []
    for pid in g["people"]:
        if pid in seen: continue
        comp, stack = set(), [pid]
        while stack:
            x = stack.pop()
            if x in seen: continue
            seen.add(x); comp.add(x)
            stack.extend(n for n in nbrs.get(x, ()) if n not in seen)
        comps.append(comp)
    return sorted(comps, key=len, reverse=True)

def _name_for(g: dict, pid: str) -> str:
    return g["people"][pid].get("name") or pid

def analyze(slug: str, book_title: str) -> dict:
    """Compute insights, suggestions, and branch metadata from people.json.
    Pure derivation — no LLM calls, deterministic, fast.
    """
    data = load_people(slug) or {"people": [], "relationships": []}
    g = _build_graph(data)
    n = len(g["people"])
    rels = data.get("relationships", [])

    if n == 0:
        return {"empty": True, "summary": "No people extracted yet."}

    # --- generations
    gen = _generations(g)
    max_gen = max(gen.values()) if gen else 0
    gen_counts: dict[int, int] = {}
    for d in gen.values(): gen_counts[d] = gen_counts.get(d, 0) + 1

    # --- founders (people with no recorded parents)
    founders = sorted(
        [pid for pid, ps in g["parents_of"].items() if not ps],
        key=lambda pid: (-len(g["children_of"][pid]), -len(g["all_neighbors"][pid]))
    )

    # --- hubs (most connected = central figures)
    hubs = sorted(g["people"], key=lambda pid: -len(g["all_neighbors"][pid]))

    # --- branches (connected components)
    comps = _connected_components(g)
    components = []
    for ci, comp in enumerate(comps):
        # name a branch by its highest-degree member
        elders = sorted(comp, key=lambda pid: (-len(g["all_neighbors"][pid]),
                                               gen.get(pid, 99)))
        head = elders[0] if elders else None
        components.append({
            "id": f"b{ci+1}",
            "size": len(comp),
            "head": _name_for(g, head) if head else None,
            "head_id": head,
            "members": list(comp),
            "generations": (max((gen[m] for m in comp), default=0) -
                            min((gen[m] for m in comp), default=0) + 1) if comp else 0,
        })

    # --- orphans (people with no relationships)
    orphans = [pid for pid in g["people"] if not g["all_neighbors"][pid]]

    # --- couples (any spouse pair)
    couples = []
    seen_pairs: set = set()
    for pid, partners in g["spouses_of"].items():
        for q in partners:
            key = tuple(sorted([pid, q]))
            if key in seen_pairs: continue
            seen_pairs.add(key)
            couples.append((_name_for(g, key[0]), _name_for(g, key[1])))

    # --- gender split
    gender = {"M": 0, "F": 0, "?": 0}
    for p in g["people"].values():
        gender[p.get("gender") if p.get("gender") in ("M","F") else "?"] += 1

    # --- relationship type breakdown
    rel_types: dict[str, int] = {}
    for r in rels:
        t = (r.get("type") or "other").lower()
        rel_types[t] = rel_types.get(t, 0) + 1

    # --- people referenced on most pages (importance signal)
    pages_per = sorted(
        [(pid, len(p.get("pages") or [])) for pid, p in g["people"].items()],
        key=lambda x: -x[1]
    )

    # --- density: edges per node
    density = round(len(rels) / max(n, 1), 2)

    # --- chat suggestions derived from real data
    suggestions = []
    if founders:
        suggestions.append(f"Tell me about {_name_for(g, founders[0])} — what does the book say about them?")
    if hubs and len(g["all_neighbors"][hubs[0]]) >= 2:
        suggestions.append(f"List all relatives of {_name_for(g, hubs[0])}.")
    if len(comps) > 1:
        suggestions.append(
            f"What links the {comps[0].__len__()}-person branch led by "
            f"{components[0]['head']} to the smaller branches?"
        )
    if couples:
        suggestions.append(f"What is the marriage of {couples[0][0]} and {couples[0][1]}? When did it take place?")
    if max_gen >= 2:
        suggestions.append(f"Trace the lineage across all {max_gen + 1} generations.")
    if not suggestions:
        suggestions = [
            "Who is the head of this family?",
            "List everyone mentioned by occupation.",
            "What dates are mentioned in this book?",
        ]

    # --- narrative summary (one paragraph, fully derived)
    bits = [
        f"This book records **{n}** people connected by **{len(rels)}** relationships",
    ]
    if max_gen >= 1:
        bits.append(f"spanning **{max_gen + 1}** generations")
    if len(comps) > 1:
        bits.append(f"split across **{len(comps)}** family branches")
    if founders:
        bits.append(f"with **{_name_for(g, founders[0])}** as the earliest documented ancestor")
    if hubs:
        bits.append(f"and **{_name_for(g, hubs[0])}** as the most connected figure"
                    f" ({len(g['all_neighbors'][hubs[0]])} ties)")
    summary = ", ".join(bits) + "."

    # --- branch assignment for tree colouring
    branch_of = {}
    for ci, comp in enumerate(comps):
        for pid in comp: branch_of[pid] = ci

    return {
        "empty": False,
        "summary": summary,
        "metrics": {
            "people": n,
            "relationships": len(rels),
            "generations": max_gen + 1,
            "branches": len(comps),
            "orphans": len(orphans),
            "couples": len(couples),
            "density": density,
            "gender": gender,
        },
        "rel_types": rel_types,
        "founders": [
            {"id": pid, "name": _name_for(g, pid),
             "children": len(g["children_of"][pid]),
             "descendants": _count_descendants(g, pid)}
            for pid in founders[:6]
        ],
        "hubs": [
            {"id": pid, "name": _name_for(g, pid),
             "degree": len(g["all_neighbors"][pid]),
             "generation": gen.get(pid, 0)}
            for pid in hubs[:6]
        ],
        "components": components[:8],
        "gen_counts": [{"gen": k, "count": v} for k, v in sorted(gen_counts.items())],
        "most_mentioned": [
            {"id": pid, "name": _name_for(g, pid), "pages": cnt}
            for pid, cnt in pages_per[:6] if cnt > 0
        ],
        "suggestions": suggestions,
        "branch_of": branch_of,
        "generation_of": gen,
    }

def _count_descendants(g: dict, root: str) -> int:
    seen, stack = set(), [root]
    while stack:
        x = stack.pop()
        for c in g["children_of"].get(x, ()):
            if c not in seen:
                seen.add(c); stack.append(c)
    return len(seen)
