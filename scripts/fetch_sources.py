#!/usr/bin/env python3
"""Download the raw source material for the open-day map into sources/.

Stdlib only, so it runs on a bare GitHub Actions runner. Saves:
  sources/pages/*.html     - Stationen, Lageplan and every linked /3-okt-2026/ page
  sources/files/*          - images / PDFs linked from the Lageplan page
  sources/wp-json/*.json   - WordPress REST API dumps (if the site exposes them)
  sources/osm_campus.json  - OSM buildings + named POIs on the campus (Overpass)
  sources/index.json       - url -> local file mapping
"""
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

BASE = "https://forschungscampus-garching.de"
START = [
    BASE + "/3-okt-2026/stationen/",
    BASE + "/3-okt-2026/lageplan/",
    BASE + "/3-okt-2026/",
    BASE + "/",
]
OUT = os.path.join(os.path.dirname(__file__), "..", "sources")
UA = "Mozilla/5.0 (open-day-map data fetch; +https://github.com/dtretyakov/forschungscampus-garching-2026-10-03)"
MAX_PAGES = 400
BBOX = (48.255, 11.645, 48.276, 11.692)  # S, W, N, E

index = {}


def get(url, binary=False, data=None, timeout=60):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body = r.read()
                return body if binary else body.decode(r.headers.get_content_charset() or "utf-8", "replace")
        except Exception as e:  # noqa: BLE001
            print(f"  ! {url}: {e}", file=sys.stderr)
            time.sleep(2 * (attempt + 1))
    return None


def slug(url):
    p = urllib.parse.urlparse(url)
    s = (p.path.strip("/") or "root") + (("_" + p.query) if p.query else "")
    return re.sub(r"[^A-Za-z0-9._-]+", "_", s)[:150]


def save(sub, name, content):
    d = os.path.join(OUT, sub)
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, name)
    mode = "wb" if isinstance(content, bytes) else "w"
    with open(path, mode, **({} if mode == "wb" else {"encoding": "utf-8"})) as f:
        f.write(content)
    return os.path.relpath(path, OUT)


def links(html, base):
    for m in re.finditer(r'(?:href|src|data-src|srcset)=["\']([^"\']+)["\']', html):
        for part in m.group(1).split(","):
            u = part.strip().split(" ")[0]
            if u and not u.startswith(("mailto:", "tel:", "javascript:", "#")):
                yield urllib.parse.urljoin(base, u).split("#")[0]


def crawl():
    seen, queue, files = set(), list(START), set()
    while queue and len(seen) < MAX_PAGES:
        url = queue.pop(0)
        if url in seen:
            continue
        seen.add(url)
        print("page", url)
        html = get(url)
        if html is None:
            continue
        index[url] = save("pages", slug(url) + ".html", html)
        for u in links(html, url):
            p = urllib.parse.urlparse(u)
            if p.netloc and p.netloc not in ("forschungscampus-garching.de", "www.forschungscampus-garching.de"):
                continue
            ext = os.path.splitext(p.path)[1].lower()
            if ext in (".pdf", ".png", ".jpg", ".jpeg", ".webp", ".svg", ".gif"):
                if "lageplan" in url or "lageplan" in u.lower() or "plan" in u.lower() or ext == ".pdf":
                    files.add(u)
            elif "/3-okt-2026/" in p.path and not ext and u not in seen:
                queue.append(u)
    for u in sorted(files):
        print("file", u)
        b = get(u, binary=True)
        if b:
            index[u] = save("files", slug(u), b)


def wp_json():
    for path in ["/wp-json/", "/wp-json/wp/v2/types", "/wp-json/wp/v2/taxonomies"]:
        txt = get(BASE + path)
        if txt and txt.lstrip().startswith(("{", "[")):
            index[BASE + path] = save("wp-json", slug(BASE + path) + ".json", txt)
    types = get(BASE + "/wp-json/wp/v2/types")
    try:
        types = json.loads(types) if types else {}
    except ValueError:
        types = {}
    taxes = get(BASE + "/wp-json/wp/v2/taxonomies")
    try:
        taxes = json.loads(taxes) if taxes else {}
    except ValueError:
        taxes = {}
    rest_bases = {v.get("rest_base") for v in list(types.values()) + list(taxes.values()) if isinstance(v, dict)}
    rest_bases |= {"pages"}
    for rb in sorted(b for b in rest_bases if b and b not in ("media", "blocks", "menu-items", "navigation", "templates", "template-parts", "global-styles", "font-families", "font-faces", "wp_pattern_category")):
        page = 1
        while page <= 20:
            url = f"{BASE}/wp-json/wp/v2/{rb}?per_page=100&page={page}"
            txt = get(url)
            if not txt or not txt.lstrip().startswith("["):
                break
            index[url] = save("wp-json", slug(url) + ".json", txt)
            if len(json.loads(txt)) < 100:
                break
            page += 1


def overpass():
    s, w, n, e = BBOX
    q = f"""[out:json][timeout:90];
(
  way["building"]({s},{w},{n},{e});
  relation["building"]({s},{w},{n},{e});
  nwr["name"]({s},{w},{n},{e});
  nwr["amenity"]({s},{w},{n},{e});
  nwr["railway"="station"]({s},{w},{n},{e});
  nwr["public_transport"]({s},{w},{n},{e});
  nwr["addr:housenumber"]({s},{w},{n},{e});
);
out center tags;"""
    for ep in ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]:
        txt = get(ep, data=urllib.parse.urlencode({"data": q}).encode(), timeout=180)
        if txt and txt.lstrip().startswith("{"):
            index["overpass"] = save("", "osm_campus.json", txt)
            return


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    crawl()
    wp_json()
    overpass()
    with open(os.path.join(OUT, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, indent=1, ensure_ascii=False)
    print(f"saved {len(index)} items")
