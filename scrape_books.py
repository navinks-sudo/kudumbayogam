"""Download Knanayology family flipbooks and assemble each as a PDF.

Reads books_index.json (produced earlier) and writes:
  pdfs/<slug>.pdf            - the assembled PDF
  cache/<slug>/<n>.jpg       - downloaded page images (kept for resume)
  scrape_log.txt             - progress log
"""
import json, os, sys, io, re, urllib.request, urllib.error, time, traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from PIL import Image

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', line_buffering=True)

ROOT = os.path.dirname(os.path.abspath(__file__))
PDF_DIR = os.path.join(ROOT, 'pdfs')
CACHE_DIR = os.path.join(ROOT, 'cache')
LOG_PATH = os.path.join(ROOT, 'scrape_log.txt')
os.makedirs(PDF_DIR, exist_ok=True)
os.makedirs(CACHE_DIR, exist_ok=True)

UA = {'User-Agent': 'Mozilla/5.0 (compatible; FamilyBookArchiver/1.0)'}

def log(msg):
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(line)
    with open(LOG_PATH, 'a', encoding='utf-8') as f:
        f.write(line + '\n')

def slugify(s):
    s = re.sub(r'[^\w\s-]', '', s, flags=re.UNICODE).strip()
    s = re.sub(r'\s+', '_', s)
    return s[:80] or 'book'

def download(url, dest, retries=4):
    if os.path.exists(dest) and os.path.getsize(dest) > 1024:
        return True
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
            if len(data) < 1024:
                raise IOError(f"too small ({len(data)} bytes)")
            tmp = dest + '.part'
            with open(tmp, 'wb') as f:
                f.write(data)
            os.replace(tmp, dest)
            return True
        except Exception as e:
            if i == retries - 1:
                log(f"  FAIL {url}: {e}")
                return False
            time.sleep(1.5 * (i + 1))
    return False

def fetch_pages(book, workers=8):
    base = book['base']
    pages = book['pages']
    slug = book['slug']
    cdir = os.path.join(CACHE_DIR, slug)
    os.makedirs(cdir, exist_ok=True)
    todo = []
    for n in range(1, pages + 1):
        dest = os.path.join(cdir, f"{n}.jpg")
        if not (os.path.exists(dest) and os.path.getsize(dest) > 1024):
            todo.append((n, dest))
    if not todo:
        return True
    log(f"  downloading {len(todo)}/{pages} pages")
    ok_count = 0
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(download, f"{base}/files/mobile/{n}.jpg", dest): n for n, dest in todo}
        for f in as_completed(futs):
            if f.result():
                ok_count += 1
    log(f"  downloaded {ok_count}/{len(todo)} new pages")
    return ok_count == len(todo)

def assemble_pdf(book):
    slug = book['slug']
    pages = book['pages']
    cdir = os.path.join(CACHE_DIR, slug)
    pdf_path = os.path.join(PDF_DIR, f"{slug}.pdf")
    if os.path.exists(pdf_path) and os.path.getsize(pdf_path) > 10 * 1024:
        log(f"  PDF already exists: {pdf_path}")
        return pdf_path
    imgs = []
    missing = []
    for n in range(1, pages + 1):
        p = os.path.join(cdir, f"{n}.jpg")
        if not (os.path.exists(p) and os.path.getsize(p) > 1024):
            missing.append(n)
            continue
        try:
            im = Image.open(p)
            im.load()
            if im.mode != 'RGB':
                im = im.convert('RGB')
            imgs.append(im)
        except Exception as e:
            log(f"  bad image {p}: {e}")
            missing.append(n)
    if missing:
        log(f"  WARNING: missing pages {missing[:10]}{'...' if len(missing) > 10 else ''}")
    if not imgs:
        log("  NO IMAGES, skipping PDF")
        return None
    tmp = pdf_path + '.part'
    imgs[0].save(tmp, format='PDF', save_all=True, append_images=imgs[1:],
                 resolution=150.0, optimize=False)
    os.replace(tmp, pdf_path)
    size_mb = os.path.getsize(pdf_path) / 1024 / 1024
    log(f"  wrote PDF: {pdf_path} ({len(imgs)} pages, {size_mb:.1f} MB)")
    return pdf_path

def main():
    books = json.load(open(os.path.join(ROOT, 'books_index.json'), encoding='utf-8'))
    # ensure slugs
    seen = {}
    for b in books:
        s = slugify(b['title'])
        seen[s] = seen.get(s, 0) + 1
        if seen[s] > 1:
            s = f"{s}_{b['id']}"
        b['slug'] = s
    json.dump(books, open(os.path.join(ROOT, 'books_index.json'), 'w', encoding='utf-8'),
              indent=2, ensure_ascii=False)

    only = sys.argv[1] if len(sys.argv) > 1 else None
    total = len(books)
    for i, b in enumerate(books, 1):
        if only and only not in b['slug'] and only != str(b['id']):
            continue
        log(f"[{i}/{total}] {b['title']} ({b.get('pages','?')} pages) -> {b['slug']}")
        try:
            fetch_pages(b)
            assemble_pdf(b)
        except Exception:
            log("  EXCEPTION:\n" + traceback.format_exc())

if __name__ == '__main__':
    main()
