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
import pytesseract
import chromadb
from chromadb.utils.embedding_functions import DefaultEmbeddingFunction

# -- Tesseract setup ---------------------------------------------------------
ROOT = Path(__file__).parent.resolve()
TESSDATA = ROOT / "tessdata"
TESS_EXE = r"C:\Program Files\Tesseract-OCR\tesseract.exe"
if Path(TESS_EXE).exists():
    pytesseract.pytesseract.tesseract_cmd = TESS_EXE
# point tesseract at our local tessdata folder so Malayalam/Hindi/Tamil work
os.environ["TESSDATA_PREFIX"] = str(TESSDATA)

# Languages we support for OCR (data files in tessdata/)
TESS_LANGS = "mal+hin+eng+tam"

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

# -- ChromaDB ----------------------------------------------------------------
_chroma_lock = threading.Lock()
_chroma_client = None
_embed_fn = DefaultEmbeddingFunction()  # ONNX MiniLM (multilingual-capable)

def chroma() -> chromadb.api.ClientAPI:
    global _chroma_client
    with _chroma_lock:
        if _chroma_client is None:
            _chroma_client = chromadb.PersistentClient(path=str(CHROMA_DIR))
        return _chroma_client

def collection_for(slug: str):
    name = f"book_{slug}"[:60]
    return chroma().get_or_create_collection(
        name=name, embedding_function=_embed_fn,
        metadata={"hnsw:space": "cosine"}
    )

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
def ocr_page(img_path: Path) -> dict:
    """Run Tesseract on one page; returns {text, lang, conf}."""
    try:
        im = Image.open(img_path)
        im.load()
        # try with all languages first (best accuracy on mixed Indic content)
        text = pytesseract.image_to_string(im, lang=TESS_LANGS)
        # detect language of text (very rough heuristic)
        lang = detect_script(text)
        return {"text": text.strip(), "lang": lang}
    except Exception as e:
        return {"text": "", "lang": "unk", "error": str(e)}

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
            should_stop: Optional[Callable[[], bool]] = None, workers: int = 3) -> dict:
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
    """Chunk all OCR'd pages and store embeddings in chroma."""
    coll = collection_for(slug)
    # wipe any existing entries for this book
    try:
        existing = coll.get(include=[])
        if existing and existing.get("ids"):
            coll.delete(ids=existing["ids"])
    except Exception:
        pass

    ids, docs, metas = [], [], []
    for n in range(1, pages + 1):
        page = load_page_ocr(slug, n)
        if not page or not page.get("text"): continue
        chunks = chunk_text(page["text"])
        for ci, c in enumerate(chunks):
            ids.append(f"{slug}_p{n}_c{ci}")
            docs.append(c)
            metas.append({"slug": slug, "page": n, "lang": page.get("lang","unk"), "chunk": ci})
        if on_progress: on_progress(n, pages)
        if should_stop and should_stop(): break

    if not docs:
        return {"chunks": 0}

    # add in batches
    BATCH = 100
    for i in range(0, len(docs), BATCH):
        coll.add(ids=ids[i:i+BATCH], documents=docs[i:i+BATCH], metadatas=metas[i:i+BATCH])
        if should_stop and should_stop(): break

    return {"chunks": len(docs)}

def search(slug: str, query: str, k: int = 6) -> list[dict]:
    coll = collection_for(slug)
    try:
        r = coll.query(query_texts=[query], n_results=k)
        out = []
        for i in range(len(r["ids"][0])):
            out.append({
                "id": r["ids"][0][i],
                "doc": r["documents"][0][i],
                "meta": r["metadatas"][0][i],
                "dist": r["distances"][0][i] if r.get("distances") else None,
            })
        return out
    except Exception as e:
        return []

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
    hits = search(slug, message, k=8)
    context = "\n\n".join(
        f"[Page {h['meta']['page']}]\n{h['doc']}" for h in hits
    ) or "(no relevant passages indexed)"

    sys = (f"You are a knowledgeable assistant for the family-history book "
           f"\"{book_title}\". Answer ONLY using the provided passages. "
           "If the answer is not in the passages, say so plainly. "
           "Cite page numbers like [p.42]. "
           "If a passage is in Malayalam/Hindi/Tamil, you may quote and translate it briefly. "
           "Be concise and factual.")

    msgs = []
    for h in history[-8:]:
        msgs.append({"role": h["role"], "content": h["content"]})
    msgs.append({"role": "user",
                 "content": f"Question: {message}\n\nRelevant passages from the book:\n{context}"})

    answer = _llm_complete(sys, msgs, max_tokens=1024, fast=False)
    return {"answer": answer, "sources": [{"page": h["meta"]["page"], "snippet": h["doc"][:240]} for h in hits]}

# ============================================================================
# Stage 5 — People & relationship extraction
# ============================================================================
EXTRACT_SYSTEM = """You are an expert genealogist analyzing a family history book.
Extract a JSON object describing every person mentioned and their relationships.

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

Rules:
- Use STABLE ids: p1, p2, p3, ... Reuse the same id when the same person appears in multiple passages.
- Only include people clearly named.
- For non-Latin names, also Romanize and put the original in name_native.
- Skip vague references ("his uncle", "the priest") unless a name follows.
- If a relationship is ambiguous, use type "other" and explain in notes.
- Limit to the most important ~80 people if there are too many.
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
        key = (a, b, r.get("type","other"))
        if key in merged["rel_seen"]: continue
        merged["rel_seen"].add(key)
        merged["relationships"].append({
            "from": a, "to": b, "type": r.get("type","other"),
            "notes": r.get("notes"), "pages": r.get("pages") or [],
        })

def run_extract(slug: str, pages: int, batch_pages: int = 8,
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
                # save raw output for diagnosis
                dbg = bdir / f"extract_raw_{lo}_{hi}.txt"
                dbg.write_text(raw or "(empty)", encoding="utf-8")
                raise RuntimeError(f"JSON parse failed ({je}); raw saved to {dbg.name}") from je
            _merge_people(merged, data)
            batches_ok += 1
        except Exception as e:
            last_err = str(e)
            print(f"extract batch {lo}-{hi} failed:", e)

        if on_progress: on_progress(hi, pages)

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
    return {"people": len(final["people"]),
            "relationships": len(final["relationships"]),
            "batches_ok": batches_ok,
            "batches_attempted": batches_attempted}

def load_people(slug: str) -> Optional[dict]:
    p = book_dir(slug) / "people.json"
    if not p.exists(): return None
    return json.loads(p.read_text(encoding="utf-8"))
