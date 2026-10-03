# Campus-Karte · Tag der offenen Tür Garching (3. Oktober 2026)

Interaktive, mobile Karte aller Stationen des Tags der offenen Tür am Forschungscampus Garching:

- **Filter** nach Zielgruppe (🧒 Kinder, Jugendliche, Studieninteressierte, Erwachsene), Format (Mitmachstationen, Vorträge, Maustag, Science Shows …) und Sprache – innerhalb einer Gruppe „oder“, zwischen Gruppen „und“.
- **Karte** (OpenStreetMap) mit allen Stationen; Gebäude mit mehreren Stationen zeigen die Lageplan-Nummer und die Anzahl.
- **📍 Standort**: eigene GPS-Position, Entfernung und Sortierung nach Nähe, „Route“ öffnet die Fußgänger-Navigation.
- **Details**: Programmbeschreibung, Standort/Raum, Vorträge mit Uhrzeit (vergangene ausgegraut), Kontakt, Link zum Original.
- **★ Mein Plan**: Stationen merken (lokal im Browser).
- Filter stecken im Link, z. B. `#cat=targets:kinder,formats:mitmachstationen` – zum Teilen oder als QR-Code.
- Funktioniert offline weiter (Service Worker), sobald die Seite einmal geladen wurde.

Quelle aller Inhalte: <https://forschungscampus-garching.de/3-okt-2026/stationen/> und der offizielle
[Lageplan](https://forschungscampus-garching.de/3-okt-2026/lageplan/). Kartendaten © OpenStreetMap-Mitwirkende.

## Daten aktualisieren

```sh
pip install -r scripts/requirements.txt      # + poppler-utils (pdftoppm, pdftotext)
python scripts/fetch_sources.py              # Seiten, Lageplan-PDF, OSM-Daten -> sources/
python scripts/georef.py                     # Lageplan an OSM ausrichten -> data/georef.json
python scripts/build_data.py                 # -> data/stations.json, data/pois.json
```

`georef.py` erkennt die lila markierten Gebäude im Lageplan, ordnet sie den OSM-Gebäudeumrissen zu und
berechnet daraus eine affine Transformation (≈ 11 m RMS). Die Nummern-Kreise des Plans werden auf ihr
Gebäude gezogen. Korrekturen einzelner Stationen: `data/manual_coords.json`.

Die Workflow-Datei `.github/workflows/fetch-sources.yml` kann die Quellen auch auf GitHub laden.

## Lokal ansehen / testen

```sh
python -m http.server 8000                   # http://localhost:8000
node tests/ui.test.mjs http://127.0.0.1:8000/            # Playwright-Smoke-Test (echte Daten)
node tests/ui.test.mjs http://127.0.0.1:8000/ --fixture  # mit Testdaten
```

Deployment: GitHub Pages über `.github/workflows/pages.yml` (Settings → Pages → Source: GitHub Actions).
