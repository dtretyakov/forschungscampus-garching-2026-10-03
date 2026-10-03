#!/usr/bin/env python3
"""Build data/stations.json and data/pois.json from the fetched sources.

Inputs (see fetch_sources.py / georef.py):
  sources/pages/3-okt-2026_stationen.html      station list with filters
  sources/pages/3-okt-2026_stationen_*.html    station detail pages
  sources/osm_campus.json                      OSM POIs (U-Bahn, bus stops)
  data/georef.json                             plan numbers -> lat/lng
  data/manual_coords.json                      optional per-station overrides
"""
import html
import json
import os
import re
import sys

from bs4 import BeautifulSoup, NavigableString, Tag

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
SRC = os.path.join(ROOT, "sources")
DATA = os.path.join(ROOT, "data")
LIST = os.path.join(SRC, "pages", "3-okt-2026_stationen.html")
BASE = "https://forschungscampus-garching.de"

# Filter groups in the order the app shows them; colours for the chips.
GROUPS = [
    ("targets", "Zielgruppe"),
    ("formats", "Format"),
    ("languages", "Sprache"),
]
TARGET_ORDER = ["kinder", "jugendliche", "studieninteressierte", "erwachsene"]
COLORS = {
    "kinder": "#d9480f", "jugendliche": "#7048e8", "studieninteressierte": "#1971c2", "erwachsene": "#2b8a3e",
}
GROUP_COLOR = {"formats": "#5c677d", "languages": "#0b7285"}
GROUP_EN = {"targets": "Audience", "formats": "Format", "languages": "Language"}
LABEL_EN = {
    "kinder": "Children", "jugendliche": "Teens", "studieninteressierte": "Prospective students", "erwachsene": "Adults",
    "experiment": "Experiments", "information": "Information/advice", "laborfuehrungen": "Lab tours",
    "maustag": "Maus-Tag (kids)", "mitmachstationen": "Hands-on stations", "offene-labore": "Open labs",
    "science-shows": "Science shows", "verpflegung": "Food & drinks", "vortraege": "Talks", "workshops": "Workshops",
    "deutsch": "German", "englisch": "English",
}

ALLOWED = {"p", "br", "ul", "ol", "li", "strong", "b", "em", "i", "h3", "h4", "h5", "a"}


def slug_of(url):
    return url.rstrip("/").rsplit("/", 1)[-1]


def page_for(url):
    p = re.sub(r"^https?://[^/]+/", "", url).strip("/")
    return os.path.join(SRC, "pages", re.sub(r"[^A-Za-z0-9._-]+", "_", p) + ".html")


def text(el):
    return re.sub(r"\s+", " ", el.get_text(" ", strip=True)).strip() if el else ""


def clean_html(nodes):
    """Whitelist-sanitise a list of block nodes into compact HTML."""
    out = []

    def walk(n):
        if isinstance(n, NavigableString):
            return html.escape(str(n), quote=False)
        if not isinstance(n, Tag):
            return ""
        inner = "".join(walk(c) for c in n.children)
        name = n.name
        if name in ("h1", "h2"):
            name = "h3"
        if name not in ALLOWED:
            return inner
        if name == "br":
            return "<br>"
        if name == "a":
            href = n.get("href", "")
            if not re.match(r"^(https?:|mailto:)", href):
                return inner
            return f'<a href="{html.escape(href)}" target="_blank" rel="noopener">{inner}</a>'
        return f"<{name}>{inner}</{name}>"

    for n in nodes:
        s = walk(n).strip()
        s = re.sub(r"\s+", " ", s)
        if s and re.sub(r"<[^>]+>", "", s).strip():
            out.append(s)
    return "".join(out)


def parse_list():
    soup = BeautifulSoup(open(LIST, encoding="utf-8").read(), "html.parser")
    # Filter option labels
    labels = {}
    for g, _ in GROUPS + [("tags", "Schlagwort")]:
        sel = soup.find("select", id=g)
        labels[g] = {o["value"]: text(o) for o in sel.find_all("option")} if sel else {}
    stations = []
    for it in soup.select("div.list_items > div.list_item"):
        a = it.select_one(".list_item_title a")
        url = a["href"]
        if not re.search(r"/stationen/[^/?#]+/?$", url):
            continue  # general event pages (FAQ, Lageplan, ...) are listed too
        st = {"slug": slug_of(url), "url": url, "title": text(a),
              "teaser": text(it.select_one(".list_item_teaser")).replace("Teaser:", "").strip()}
        for d in it.select("[data-filter]"):
            k, _, v = d["data-filter"].partition("=")
            st[k] = [x for x in v.split(",") if x]
        num = it.select_one(".numbercircle a")
        st["number"] = text(num).rstrip(".") if num else ""
        m = re.search(r'url\("([^"]*)"\)', it.select_one(".list_item_img").get("style", ""))
        st["image"] = m.group(1) if m and m.group(1) else ""
        stations.append(st)
    return stations, labels


def parse_detail(st):
    path = page_for(st["url"])
    if not os.path.exists(path):
        print("  ! missing detail page", st["url"], file=sys.stderr)
        return
    soup = BeautifulSoup(open(path, encoding="utf-8").read(), "html.parser")
    content = soup.select_one("div.entry-content")
    if not content:
        return
    blocks = [c for c in content.children if isinstance(c, Tag)]
    # Sections: [figure, meta columns] <hr> description <hr> Standort <hr> Kontakt
    sections, cur = [], []
    for b in blocks:
        if b.name == "hr":
            sections.append(cur)
            cur = []
        else:
            cur.append(b)
    sections.append(cur)
    desc, where, contact, links = [], "", "", []
    for sec in sections[1:]:
        head = sec[0] if sec and sec[0].name in ("h2", "h3") else None
        title = text(head).lower() if head else ""
        body = sec[1:] if head else sec
        if title.startswith("standort"):
            where = "\n".join(t for t in (b.get_text("\n", strip=True) for b in body) if t)
        elif title.startswith("kontakt"):
            contact = clean_html(body)
        else:
            for b in body:
                if "wp-block-buttons" in (b.get("class") or []):
                    for l in b.select("a[href]"):
                        links.append({"label": text(l), "url": l["href"]})
                else:
                    desc.append(b)
    st["description_html"] = clean_html(desc)
    st["description"] = re.sub(r"\s+", " ", " ".join(d.get_text(" ", strip=True) for d in desc)).strip()
    st["location"] = re.sub(r"[ \t]+", " ", where).strip()
    st["contact_html"] = contact
    st["links"] = links


def parse_talks():
    """Lecture timetable (updated live by the organisers on the day)."""
    path = os.path.join(SRC, "pages", "3-okt-2026_vortraege.html")
    if not os.path.exists(path):
        return {}, ""
    soup = BeautifulSoup(open(path, encoding="utf-8").read(), "html.parser")
    m = re.search(r"letzte Aktualisierung:\s*([\d.]+\s+[\d:]+)", soup.get_text(" "))
    talks = {}
    for tr in soup.select("table tbody tr"):
        td = tr.find_all("td")
        if len(td) < 5:
            continue
        when = text(td[0]).replace("2026-10-03", "").strip()
        start, _, end = when.partition("–")
        a = td[4].find("a", href=True)
        slug = slug_of(a["href"]) if a else ""
        talks.setdefault(slug, []).append({
            "start": start.strip(), "end": end.strip(), "title": text(td[1]),
            "speaker": text(td[2]), "where": re.sub(r"\s{2,}", " · ", td[3].get_text(" ").strip()).replace("  ", " "),
        })
    for v in talks.values():
        v.sort(key=lambda t: t["start"])
    return talks, (m.group(1) if m else "")


def main():
    stations, labels = parse_list()
    talks, talks_updated = parse_talks()
    for st in stations:
        parse_detail(st)

    geo = json.load(open(os.path.join(DATA, "georef.json")))
    manual_path = os.path.join(DATA, "manual_coords.json")
    manual = json.load(open(manual_path)) if os.path.exists(manual_path) else {}
    for st in stations:
        n = st["number"]
        cands = [n, n.split(".")[0]] if n else []
        st["lat"] = st["lng"] = None
        for c in cands:
            if c in geo["labels"]:
                st["lat"], st["lng"] = geo["labels"][c]["lat_lng"]
                st["plan_ref"] = c
                break
        if st["slug"] in manual:
            m = manual[st["slug"]]
            if "ref" in m:
                st["lat"], st["lng"] = geo["labels"][m["ref"]]["lat_lng"]
            else:
                st["lat"], st["lng"] = m["lat"], m["lng"]
            st["plan_ref"] = m.get("ref", "")
            st["position_note"] = m.get("note", "")
        if st["lat"] is None:
            print(f"  ! no position: {st['slug']} (number {n!r})", file=sys.stderr)

    # Categories: one entry per filter value, id prefixed by group.
    cats = []
    for g, gl in GROUPS:
        values = labels[g]
        order = TARGET_ORDER if g == "targets" else list(values)
        for v in order:
            if v in values:
                cats.append({"id": f"{g}:{v}", "group": g, "group_label": gl, "label": values[v],
                             "label_en": LABEL_EN.get(v, values[v]),
                             "color": COLORS.get(v) or GROUP_COLOR.get(g)})
    en_path = os.path.join(DATA, "i18n_en.json")
    en = json.load(open(en_path, encoding="utf-8")) if os.path.exists(en_path) else {}
    missing = [s["slug"] for s in stations if s["slug"] not in en]
    if missing:
        print(f"  ! no English text for: {', '.join(missing)}", file=sys.stderr)
    out_st = []
    for i, st in enumerate(sorted(stations, key=lambda s: ([int(x) for x in s["number"].split(".")] if s["number"] else [999], s["title"]))):
        out_st.append({
            "id": st["slug"],
            "number": st["number"],
            "title": st["title"],
            "teaser": st["teaser"],
            "categories": [f"{g}:{v}" for g, _ in GROUPS for v in st.get(g, [])],
            "tags": [labels["tags"].get(t, t) for t in st.get("tags", [])],
            "location": st.get("location", ""),
            "description": st.get("description", ""),
            "description_html": st.get("description_html", ""),
            "contact_html": st.get("contact_html", ""),
            "links": st.get("links", []),
            "image": st["image"],
            "url": st["url"],
            "lat": st["lat"], "lng": st["lng"],
            "plan_ref": st.get("plan_ref", ""),
            "position_note": st.get("position_note", ""),
            "talks": talks.get(st["slug"], []),
            "title_en": en.get(st["slug"], {}).get("title", ""),
            "teaser_en": en.get(st["slug"], {}).get("teaser", ""),
            "position_note_en": en.get(st["slug"], {}).get("position_note", ""),
        })
    data = {
        "event": "Tag der offenen Tür · Forschungscampus Garching · 3. Oktober 2026 · 10–17 Uhr",
        "source": BASE + "/3-okt-2026/stationen/",
        "center": [48.2645, 11.6700],
        "zoom": 16,
        "groups": [{"id": g, "label": gl, "label_en": GROUP_EN[g]} for g, gl in GROUPS],
        "categories": cats,
        "talks_updated": talks_updated,
        "stations": out_st,
    }
    with open(os.path.join(DATA, "stations.json"), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    known = {s["id"] for s in out_st}
    for slug, tl in talks.items():
        if slug not in known:
            print(f"  ! {len(tl)} talks for unknown station {slug!r}", file=sys.stderr)
    print(f"{sum(len(s['talks']) for s in out_st)} talks attached (updated {talks_updated})", file=sys.stderr)
    print(f"{len(out_st)} stations, {sum(1 for s in out_st if s['lat'] is not None)} with position", file=sys.stderr)

    # POIs: U-Bahn and bus stops from OSM, info / food / parking from the plan.
    pois = []
    osm = json.load(open(os.path.join(SRC, "osm_campus.json")))
    for e in osm["elements"]:
        t = e.get("tags", {})
        c = e.get("center") or {"lat": e.get("lat"), "lon": e.get("lon")}
        if t.get("railway") == "station" and "Forschungszentrum" in t.get("name", ""):
            pois.append({"type": "ubahn", "icon": "🚇", "name": "U6 Garching-Forschungszentrum",
                         "note": "U-Bahn verkehrt von 9:30 bis 11:30 im 10-Minuten-Takt.", "lat": c["lat"], "lng": c["lon"]})
    sym = geo["symbols"]
    for lat, lng, *_ in sym.get("info", []):
        pois.append({"type": "info", "icon": "ℹ️", "name": "Infostand", "lat": lat, "lng": lng})
    for lat, lng, *_ in sym.get("food", []):
        pois.append({"type": "food", "icon": "🍴", "name": "Gastronomie", "lat": lat, "lng": lng})
    for lat, lng, *_ in sym.get("bus", []):
        pois.append({"type": "bus", "icon": "🚌", "name": "Bushaltestelle", "lat": lat, "lng": lng})
    ub = [p for p in pois if p["type"] == "ubahn"]
    for lat, lng, x, y in sym.get("blue", []):
        # blue symbols are parking signs plus the U-Bahn sign (already from OSM)
        if ub and abs(lat - ub[0]["lat"]) < 0.0004 and abs(lng - ub[0]["lng"]) < 0.0006:
            continue
        pois.append({"type": "parking", "icon": "🅿️", "name": "Parkplatz", "lat": lat, "lng": lng})
    with open(os.path.join(DATA, "pois.json"), "w", encoding="utf-8") as f:
        json.dump(pois, f, ensure_ascii=False, indent=1)
    print(f"{len(pois)} POIs", file=sys.stderr)


if __name__ == "__main__":
    main()
