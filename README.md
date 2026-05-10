# Kudumbayogam — Heritage Vault

A multilingual archive portal for Knanaya family-history flipbooks published on
[knanayology.org](https://www.knanayology.org/category/persons/families/).

It mirrors every flipbook as a PDF, runs **OCR** across Malayalam · Hindi · Tamil · English,
ingests every page into a **vector store**, and lets you **chat** with each book
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
   ▼  OCR — Tesseract (mal+hin+eng+tam)
per-page text
   │
   ▼  chunk + embed (ChromaDB ONNX MiniLM)
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

### 2. Install Tesseract OCR

- **Windows**: <https://github.com/UB-Mannheim/tesseract/wiki>
- **macOS**: `brew install tesseract`
- **Ubuntu**: `sudo apt install tesseract-ocr`

The code expects the binary at `C:\Program Files\Tesseract-OCR\tesseract.exe`
on Windows; adjust `TESS_EXE` in `pipeline.py` for other paths.

### 3. Download language packs

The `tessdata/` folder is `.gitignore`d. Download these files into it:

```bash
mkdir -p tessdata && cd tessdata
for lang in mal hin eng tam; do
  curl -L -O "https://github.com/tesseract-ocr/tessdata/raw/main/$lang.traineddata"
done
```

### 4. Set an LLM API key (any one)

The portal auto-detects whichever is set:

```powershell
# PowerShell
$env:GEMINI_API_KEY    = "AIza..."          # Gemini (recommended — cheap + multilingual)
$env:GEMINI_CHAT_MODEL = "gemini-2.5-flash-lite"
$env:GEMINI_FAST_MODEL = "gemini-2.5-flash-lite"

# OR
$env:ANTHROPIC_API_KEY = "sk-ant-..."

# OR
$env:OPENAI_API_KEY    = "sk-proj-..."
$env:OPENAI_CHAT_MODEL = "gpt-4o"
```

```bash
# bash / zsh
export GEMINI_API_KEY="AIza..."
```

Provider precedence: **Anthropic > OpenAI > Gemini**.
Force one with `LLM_PROVIDER=anthropic|openai|gemini`.

### 5. Bootstrap the catalogue index

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

### 6. Run

```bash
python server.py
```

Open <http://127.0.0.1:5434>.

---

## Architecture

| File | Role |
|---|---|
| `server.py`     | FastAPI app on port 5434, SSE event bus, scrape worker |
| `pipeline.py`   | OCR + chunking + embeddings + LLM (Anthropic / OpenAI / Gemini) + RAG chat + relationship extraction |
| `scrape_books.py` | Standalone bulk-PDF builder (CLI) |
| `static/`       | Single-page UI: catalogue + book detail (Pages · Chat · People · Family Tree) |

### Data layout

```
cache/<slug>/<n>.jpg          # downloaded page images (600 KB / page)
pdfs/<slug>.pdf               # bound PDF
data/<slug>/ocr/<n>.json      # OCR text per page
data/<slug>/people.json       # extracted people + relationships
data/chroma/                  # ChromaDB persistent vector store
tessdata/                     # Tesseract language packs
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
