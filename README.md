# Kudumbayogam — Heritage Vault

A multilingual archive portal for Knanaya family-history flipbooks published on
[knanayology.org](https://www.knanayology.org/category/persons/families/).

It mirrors every flipbook as a PDF, runs **Gemini-vision OCR** across Malayalam · Hindi · Tamil · English,
ingests every page into a **vector store** with Gemini embeddings, and lets you **chat** with each book
or trace the **family tree** hidden in its pages.

![Stack](https://img.shields.io/badge/Python-3.10%2B-blue) ![FastAPI](https://img.shields.io/badge/FastAPI-0.115-009688) ![Chroma](https://img.shields.io/badge/Chroma-1.0-orange) ![LLM](https://img.shields.io/badge/LLM-Claude%20%7C%20OpenAI%20%7C%20Gemini-95c11f)

---

## Pipeline

```
flipbook URL
   │
   ▼  scrape — pull every page JPEG
PDF (Pillow)
   │
   ▼  OCR — Gemini-2.5-flash vision (Malayalam, Hindi, Tamil, English)
per-page text
   │
   ▼  chunk + embed (Gemini gemini-embedding-001, 768-dim)
vector store
   │
   ├──▶  Smart Chat   (RAG over book, cites page numbers)
   ├──▶  Translation  (any page → English/Malayalam/Hindi/Tamil)
   └──▶  People + Relationships  (LLM JSON-schema extraction)
              │
              ▼
        Family Tree visualisation (D3 force / radial)
```

---

## Setup

### 1. Install Python dependencies

```bash
pip install -r requirements.txt
```

### 2. Set a Gemini API key (required)

OCR, embeddings, chat, and relationship extraction all go through Gemini.

```powershell
# PowerShell
$env:GEMINI_API_KEY    = "AIza..."
$env:GEMINI_OCR_MODEL  = "gemini-2.5-flash"        # vision OCR — full flash needed
$env:GEMINI_CHAT_MODEL = "gemini-2.5-flash"        # chat / extraction
$env:GEMINI_FAST_MODEL = "gemini-2.5-flash"        # translation, follow-ups
```

```bash
# bash / zsh
export GEMINI_API_KEY="AIza..."
```

> Anthropic / OpenAI are also wired up as alternates for chat / extraction (set
> `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` instead), but **OCR is Gemini-only** —
> no Tesseract, no other backend.

### 3. Bootstrap the catalogue index

If `books_index.json` isn't present, regenerate it from the live site:

```bash
python -c "
import json, urllib.request, re, html as _h
def fetch(u): return urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent':'BookArchiver'}), timeout=30).read().decode('utf-8','replace')
out = []
for cat in (24, 35):
    posts = json.loads(fetch(f'https://www.knanayology.org/wp-json/wp/v2/posts?categories={cat}&per_page=100&_fields=id,slug,link,title'))
    for p in posts:
        c = json.loads(fetch(f\"https://www.knanayology.org/wp-json/wp/v2/posts/{p['id']}?_fields=content\"))
        m = re.search(r'\\[flip-book[^\\]]*?url\\s*=\\s*[\"“”‘’\\']([^\"“”‘’\\'\\\\]]+)', _h.unescape(c['content']['rendered']))
        if m:
            base = m.group(1).strip().rstrip('/')
            base = re.sub(r'/(mobile/)?index\\.html$', '', base).rstrip('/')
            if not base.startswith('http'): base = 'https://www.knanayology.org/' + base.lstrip('/')
            out.append({'id': p['id'], 'title': re.sub(r'<[^>]+>','',p['title']['rendered']).strip(), 'base': base, 'post': p['link']})
json.dump(out, open('books_index.json','w', encoding='utf-8'), indent=2, ensure_ascii=False)
print(len(out), 'books indexed')
"
```

### 4. Run

**On Windows** — copy the template launcher, fill in your key, run it:

```powershell
copy run_server.example.cmd run_server.cmd
# edit run_server.cmd and replace PUT_YOUR_KEY_HERE
.\run_server.cmd
```

The script sets all env vars and starts the server detached. `run_server.cmd` is gitignored so your key stays local.

**On macOS / Linux**:

```bash
export GEMINI_API_KEY="AIza..."
export GEMINI_OCR_MODEL="gemini-2.5-flash"
python server.py
```

Open <http://127.0.0.1:5434>.

---

## Architecture

| File | Role |
|---|---|
| `server.py`     | FastAPI app on port 5434, SSE event bus, scrape worker |
| `pipeline.py`   | Gemini OCR + chunking + Gemini embeddings + LLM chat + relationship extraction + GedcomX export |
| `scrape_books.py` | Standalone bulk-PDF builder (CLI) |
| `static/`       | Single-page UI: catalogue + book detail (Pages · Chat · People · Family Tree) |

### Data layout

```
cache/<slug>/<n>.jpg          # downloaded page images (600 KB / page)
pdfs/<slug>.pdf               # bound PDF
data/<slug>/ocr/<n>.json      # OCR text per page (Gemini)
data/<slug>/people.json       # extracted people + relationships
data/<slug>/family.gedcomx.json # GedcomX export (auto-written after extract)
data/chroma/                  # ChromaDB persistent vector store
```

### Endpoints (highlights)

| Method | Path | Purpose |
|---|---|---|
| GET  | `/api/health` | provider, key status, totals |
| GET  | `/api/books`  | catalogue snapshot |
| POST | `/api/start` `{ids?:[int]}` | bind PDFs |
| POST | `/api/book/{id}/ocr` | OCR all pages |
| POST | `/api/book/{id}/ingest` | chunk + embed into ChromaDB |
| POST | `/api/book/{id}/extract` | LLM → people + relationships |
| POST | `/api/book/{id}/chat` `{message,history}` | RAG-grounded answer + cited pages |
| POST | `/api/translate` `{text,target}` | any-to-any translation |
| GET  | `/api/book/{id}/page/{n}` | image URL + OCR text + lang |
| GET  | `/api/book/{id}/people` | people + relationships JSON |
| GET  | `/api/events` | Server-Sent Events stream |
| GET  | `/pdfs/{slug}.pdf` | bound PDF download |

---

## Stage workflow on a single book

1. Click **Open** on any catalogue card.
2. **Bind** — downloads every page from knanayology.org and packs them into a PDF.
3. **Run OCR** — Tesseract extracts text per page. Auto-detects script.
4. **Index** — chunks the OCR'd text and embeds into ChromaDB (one collection per book).
5. **Extract** — LLM walks pages in batches, returns strict JSON of people + relationships, deduped by name.
6. **Chat / People / Tree** tabs are now live.

---

## Design notes

- **Light theme**, navy + lime accent — Poppins throughout.
- The **Family Tree** is rendered as the only dark-contrast surface in the app (force-directed or radial-by-generation).
- Resume-friendly: every stage skips already-completed pages on rerun.
- LLM extraction uses **strict JSON-schema response** (Gemini), with thinking budget disabled to avoid output truncation.

---

## License

This is a personal-use archival tool. Source content (the family books) belongs to
the original publishers and to knanayology.org. Respect those rights when sharing
the generated PDFs or extracted data.
