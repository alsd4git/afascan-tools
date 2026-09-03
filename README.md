# AfaScan tools

[![CI](https://github.com/alsd4git/afascan-tools/actions/workflows/ci.yml/badge.svg)](https://github.com/alsd4git/afascan-tools/actions/workflows/ci.yml)
[![Web app](https://github.com/alsd4git/afascan-tools/actions/workflows/web.yml/badge.svg)](https://github.com/alsd4git/afascan-tools/actions/workflows/web.yml)

Strumenti local-first per trasformare gli screenshot dei referti AfaScan in dati strutturati, esportazioni tabellari e una dashboard storica.

Sono disponibili due modalità:

- **Web app**: nessuna installazione, OCR direttamente nel browser e archivio locale in IndexedDB;
- **CLI**: Python + Tesseract locale, con JSON/CSV e dashboard HTML autosufficiente.

Il progetto organizza le misure riportate dallo strumento e non fornisce interpretazioni o indicazioni mediche.

![Preview della dashboard AfaScan con dati sintetici](docs/dashboard-preview.jpg)

## Web app

La versione canonica sarà pubblicata su:

**https://alsd4git.github.io/afascan-tools/**

Puoi trascinare, selezionare o incollare uno o più screenshot. Il browser calcola un hash SHA-256 locale, esegue OCR con Tesseract.js/WebAssembly, estrae lo stesso schema usato dal CLI, mostra i dati per la revisione e salva localmente il risultato.

### Privacy e persistenza

Gli screenshot originali **non vengono salvati** e non vengono inviati a un backend. Worker, core WASM e dati lingua di Tesseract sono copiati nella build e serviti dalla stessa GitHub Page.

IndexedDB conserva soltanto:

- record normalizzato corrente;
- testo OCR grezzo, quando disponibile;
- correzioni/override;
- hash SHA-256 e metadati tecnici necessari a deduplicazione e migrazioni.

La memoria del browser non è un backup. Dalla sezione **Import / Export** puoi scaricare `measurements.json`, `measurements.csv` o `afascan-backup.json`; il backup completo include OCR e override ma mai gli screenshot.

Le preview dei branch usano namespace IndexedDB separati dalla versione canonica, così i dati di test non vengono mescolati con l'archivio principale.

## CLI — avvio rapido

Sono necessari [uv](https://docs.astral.sh/uv/) e [Tesseract OCR](https://github.com/tesseract-ocr/tesseract).

Copia i PNG nella cartella `screenshots/`, preferibilmente con nomi come `Screenshot_YYYYMMDD-HHMMSS.png`, poi esegui:

```bash
uv run parse_scans.py
```

Alla prima esecuzione vengono importati gli screenshot presenti; nelle esecuzioni successive vengono processati solo quelli nuovi.

Apri poi `dashboard.html` direttamente nel browser. Non è necessario avviare un server web: la dashboard è un file HTML statico autosufficiente.

### Comandi CLI

| Comando | Uso |
| --- | --- |
| `uv run parse_scans.py` | Importa i nuovi screenshot ed esegue OCR solo quando serve. |
| `uv run parse_scans.py --no-ocr` | Rigenera JSON, CSV e dashboard senza eseguire Tesseract. |
| `uv run parse_scans.py --force-ocr` | Riesegue intenzionalmente l'OCR su tutti gli screenshot presenti. |
| `uv run parse_scans.py --help` | Mostra le opzioni disponibili. |

`--no-ocr` e `--force-ocr` sono alternativi.

### Correzioni OCR nel CLI

`data/measurements.json` è un output generato: non modificarlo direttamente. Inserisci invece le correzioni in `data/overrides.json`, usando il nome dello screenshot come chiave, poi rilancia il parser.

```json
{
  "Screenshot_20260101-120000.png": {
    "weight_kg": 80.4,
    "body_fat_percent": 21.7
  }
}
```

## Dashboard condivisa

`dashboard.template.html` rimane la sorgente della dashboard per entrambe le modalità:

- il CLI incorpora il JSON nel template e genera `dashboard.html`;
- la web app importa lo stesso template e gli passa i record conservati in IndexedDB.

Questo evita di mantenere due renderer indipendenti.

## Sviluppo e verifiche

### Python / CLI

```bash
uv sync --dev
uv run ruff format --check .
uv run ruff check .
uv run pytest -q
uv run python -m compileall -q parse_scans.py tests
```

### Web app

```bash
cd web
npm install
npm run typecheck
npm test
npm run dev
```

`npm run dev` copia prima in `web/public/ocr/` worker, core e lingua inglese installati dai pacchetti npm. La directory è generata e non viene versionata.

Durante la revisione l’app mostra lo screenshot originale a fianco dei campi; puoi aprirlo in una finestra ingrandita e usare i comandi di zoom. Sugli screenshot AfaScan con bande nere esterne, il passaggio OCR prova a ritagliare automaticamente solo l’area del referto; se il rilevamento non è abbastanza netto usa l’immagine originale.

Le fixture in `tests/fixtures/` sono condivise tra Python e TypeScript e mantengono allineato il comportamento dei due parser.

## GitHub Pages e preview dei branch

Il workflow `.github/workflows/web.yml` valida build e test sulle PR. Un push su un branch del repository pubblica inoltre una preview stabile sotto una directory derivata dal nome del branch, ad esempio:

```text
feat/web-app
→ https://alsd4git.github.io/afascan-tools/feat-web-app/
```

`main` aggiorna anche la root canonica `/afascan-tools/`. Il workflow conserva le build dei branch in uno stato `gh-pages` interno e pubblica il risultato tramite **GitHub Actions Pages**; le PR provenienti da fork non ricevono permessi di pubblicazione.

Per il primo deploy è necessario configurare una sola volta **Settings → Pages → Source → GitHub Actions**.

## Struttura

```text
parse_scans.py              # importazione OCR CLI e generazione output
dashboard.template.html     # dashboard condivisa CLI/web
web/                        # web app TypeScript + Vite + Tesseract.js
docs/dashboard-preview.jpg  # preview con dati sintetici
screenshots/                # screenshot originali (locale)
data/                       # OCR, measurements e override locali
tests/                      # test e fixture condivise
```

I dati personali e gli artefatti generati dal CLI sono esclusi dal repository tramite `.gitignore`.

## Licenza

Distribuito con licenza [MIT](LICENSE).
