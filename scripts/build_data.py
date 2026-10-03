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
import math
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
# Translations of filter groups and values; station texts come from data/i18n_<lang>.json.
LANGS = ["en", "ru"]
GROUP_TR = {
    "en": {"targets": "Audience", "formats": "Format", "languages": "Language"},
    "ru": {"targets": "Для кого", "formats": "Формат", "languages": "Язык"},
}
LABEL_TR = {
    "en": {
        "kinder": "Children", "jugendliche": "Teens", "studieninteressierte": "Prospective students", "erwachsene": "Adults",
        "experiment": "Experiments", "information": "Information/advice", "laborfuehrungen": "Lab tours",
        "maustag": "Maus-Tag (kids)", "mitmachstationen": "Hands-on stations", "offene-labore": "Open labs",
        "science-shows": "Science shows", "verpflegung": "Food & drinks", "vortraege": "Talks", "workshops": "Workshops",
        "deutsch": "German", "englisch": "English",
    },
    "ru": {
        "kinder": "Дети", "jugendliche": "Подростки", "studieninteressierte": "Абитуриенты", "erwachsene": "Взрослые",
        "experiment": "Эксперименты", "information": "Информация/консультации", "laborfuehrungen": "Экскурсии по лабораториям",
        "maustag": "Maus-Tag (для детей)", "mitmachstationen": "Интерактивные станции", "offene-labore": "Открытые лаборатории",
        "science-shows": "Научные шоу", "verpflegung": "Еда и напитки", "vortraege": "Доклады", "workshops": "Мастер-классы",
        "deutsch": "Немецкий", "englisch": "Английский",
    },
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


# Food search words per kind, in DE / EN / RU, so "кофе", "coffee" and "Kaffee" all find the cafés.
FOOD_KINDS = [
    (r"caff|espresso|bean|café|cafe", "Kaffee Café coffee кофе кофейня"),
    (r"pizza", "Pizza пицца"),
    (r"burger", "Burger бургер"),
    (r"waffel", "Waffeln waffles вафли десерт dessert süß сладкое"),
    (r"churro", "Churros чуррос десерт dessert süß сладкое"),
    (r"lukumades", "Lukumades griechische Donuts dessert десерт пончики сладкое süß"),
    (r"pommes", "Pommes fries картошка фри"),
    (r"döner|doner", "Döner kebab кебаб шаурма"),
    (r"curry", "Curry карри"),
    (r"kässpatzen|spatzen", "Kässpätzle spätzle шпецле"),
    (r"luu", "asiatisch asian азиатская кухня"),
    (r"grieche", "griechisch greek греческая кухня"),
    (r"tibet", "tibetisch tibetan тибетская кухня"),
    (r"mensa|kantine|bistro|cafeteria|five", "Kantine Mensa canteen cafeteria столовая обед lunch Mittagessen"),
    (r"cneipe|kneipe", "Kneipe pub Bier beer бар пиво"),
]
FOOD_ALL = "Essen Trinken Verpflegung Gastronomie food drinks eat еда напитки поесть кафе ресторан"
# FAQ vendors whose name differs from OpenStreetMap: (name pattern, where pattern) -> OSM name
FOOD_OSM = [
    (r"StuBistro", r"Mensa", "StuBistro Garching Mensa"),
    (r"StuBistro", r"Maschinenwesen", "StuBistro Garching Maschinenwesen"),
    (r"IPP Kantine", r"", "Max-Planck Kantine Garching"),
    (r"Campus Cneipe", r"", "Campus-Cneipe C2"),
]


def squash(t):
    return re.sub(r"[^a-z0-9äöüß]+", "", t.lower())


def parse_food(geo, osm):
    """Food & drinks from the FAQ, placed via OSM name, a plan food symbol near the building, or the building."""
    path = os.path.join(SRC, "pages", "3-okt-2026_faq.html")
    if not os.path.exists(path):
        return []
    soup = BeautifulSoup(open(path, encoding="utf-8").read(), "html.parser")
    box = soup.find(id="gastronomie")
    if not box:
        return []
    named = {}
    for e in osm["elements"]:
        t = e.get("tags", {})
        if "name" in t and t.get("amenity") or "name" in t and "building" in t:
            c = e.get("center") or {"lat": e.get("lat"), "lon": e.get("lon")}
            named.setdefault(squash(t["name"]), (c["lat"], c["lon"]))
    labels = geo["labels"]
    symbols = [(a, b) for a, b, *_ in geo["symbols"].get("food", [])]
    ubahn = next(((e.get("lat"), e.get("lon")) for e in osm["elements"]
                  if e.get("tags", {}).get("railway") == "station" and "Forschungszentrum" in e["tags"].get("name", "")), None)

    def meters(a, b):
        return math.hypot((a[0] - b[0]) * 111132, (a[1] - b[1]) * 111320 * math.cos(math.radians(a[0])))

    out = []
    for li in box.select("li"):
        txt = text(li)
        name, _, where = txt.partition(" – ")
        hours = ""
        m = re.search(r"\(([^)]*Uhr)\)", name)
        if m:
            hours, name = m.group(1), name.replace(m.group(0), "").strip()
        a = li.find("a", href=True)
        url = a["href"] if a and "forschungscampus-garching.de" not in a["href"] else ""
        b = re.search(r"Gebäude ([\d/]+)", where)
        buildings = b.group(1).split("/") if b else []
        where = re.sub(r"\s*\(\s*Gebäude [\d/]+\s*\)", "", where).strip()
        pos, how = None, ""
        for pat, wpat, osm_name in FOOD_OSM:
            if re.search(pat, name) and re.search(wpat, where):
                pos, how = named.get(squash(osm_name)), "osm"
        if not pos:
            key = squash(name.replace("’s", "s").replace("'s", "s"))
            for k, v in named.items():
                if key and (k == key or k.startswith(key)) and len(key) >= 4:
                    pos, how = v, "osm"
                    break
        if not pos and "U-Bahn" in where and ubahn:
            pos, how = ubahn, "ubahn"
        if not pos and buildings:
            pts = [labels[x]["lat_lng"] for x in buildings if x in labels]
            if pts:
                ref = (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))
                pos, how = ref, "building"
                if where.startswith("vor ") or "zwischen" in where:
                    near = sorted(symbols, key=lambda s_: meters(s_, ref))
                    if near and meters(near[0], ref) < 150:
                        pos, how = near[0], "plan-symbol"
        if not pos:
            m2 = re.search(r"Chemie", where)
            if m2 and "1" in labels:
                pos, how = labels["1"]["lat_lng"], "building"
        if not pos:
            print(f"  ! food without position: {txt}", file=sys.stderr)
            continue
        kinds = " ".join(words for pat, words in FOOD_KINDS if re.search(pat, name, re.I))
        out.append({"type": "food", "icon": "🍴", "name": name.strip(), "where": where, "hours": hours, "url": url,
                    "building": "/".join(buildings), "lat": round(pos[0], 6), "lng": round(pos[1], 6), "placed_by": how,
                    "search": f"{name} {where} {kinds} {FOOD_ALL}"})
    return out


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
                             **{f"label_{l}": LABEL_TR[l].get(v, values[v]) for l in LANGS},
                             "color": COLORS.get(v) or GROUP_COLOR.get(g)})
    tr = {}
    for l in LANGS:
        path = os.path.join(DATA, f"i18n_{l}.json")
        tr[l] = json.load(open(path, encoding="utf-8")) if os.path.exists(path) else {}
        missing = [s["slug"] for s in stations if s["slug"] not in tr[l]]
        if missing:
            print(f"  ! no {l} text for: {', '.join(missing)}", file=sys.stderr)
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
            **{f"{f}_{l}": tr[l].get(st["slug"], {}).get(f, "") for l in LANGS for f in ("title", "teaser", "position_note")},
        })
    # Talk titles: translations keyed by the original title (the timetable changes during the day).
    tt_path = os.path.join(DATA, "i18n_talks.json")
    tt = json.load(open(tt_path, encoding="utf-8")) if os.path.exists(tt_path) else {}
    untranslated = set()
    for st in out_st:
        for t in st["talks"]:
            for l in LANGS:
                t[f"title_{l}"] = tt.get(t["title"], {}).get(l, "")
            if t["title"] and t["title"] not in tt:
                untranslated.add(t["title"])
    if untranslated:
        print(f"  ! {len(untranslated)} talk titles without translation: {sorted(untranslated)[:5]}", file=sys.stderr)
    data = {
        "event": "Tag der offenen Tür · Forschungscampus Garching · 3. Oktober 2026 · 10–17 Uhr",
        "source": BASE + "/3-okt-2026/stationen/",
        "center": [48.2645, 11.6700],
        "zoom": 16,
        "groups": [{"id": g, "label": gl, **{f"label_{l}": GROUP_TR[l][g] for l in LANGS}} for g, gl in GROUPS],
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
    food = parse_food(geo, osm)
    pois.extend(food)
    if not food:  # FAQ list missing: fall back to the anonymous food symbols of the plan
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
