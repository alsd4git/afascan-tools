# AfaScan tools

[![CI](https://github.com/alsd4git/afascan-tools/actions/workflows/ci.yml/badge.svg)](https://github.com/alsd4git/afascan-tools/actions/workflows/ci.yml)

> Strumenti locali per trasformare i report AfaScan ricevuti come screenshot in dati strutturati e grafici consultabili.

Il progetto nasce da un’esigenza personale, ma il parser è pensato per essere riutilizzabile con report AfaScan dello stesso formato.

> **Stato:** prototipo funzionante, semi-automatico. I valori estratti vanno verificati quando l’OCR segnala un’anomalia.

## Cosa fa

- legge gli screenshot con OCR tramite Tesseract;
- conserva il testo OCR originale per il controllo manuale;
- normalizza i valori in JSON e CSV;
- genera una dashboard HTML offline con grafici interattivi e tabella storica;
- include una sezione sempre visibile per i dettagli del referto selezionato, comprese massa grassa e massa magra dei singoli segmenti;
- permette correzioni esplicite tramite un file di override, senza perdere l’estrazione originale;
- mantiene separati dispositivo e tipo di report, così da poter estendere il progetto a eventuali test funzionali o posturali.

Il progetto non interpreta i risultati dal punto di vista medico: visualizza e organizza le misure riportate dallo strumento.

## Requisiti

- [uv](https://docs.astral.sh/uv/);
- [Tesseract OCR](https://github.com/tesseract-ocr/tesseract).

`uv` gestisce automaticamente l’ambiente Python del progetto e il relativo lockfile. Non serve attivare manualmente un virtual environment.

Installare `uv` seguendo la [documentazione ufficiale](https://docs.astral.sh/uv/getting-started/installation/). Su macOS con Homebrew:

```bash
brew install uv
```

Su Linux:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

Su Windows PowerShell:

```powershell
winget install --id=astral-sh.uv -e
```

Tesseract è il motore OCR nativo e va installato separatamente. Su macOS con Homebrew:

```bash
brew install tesseract
```

Su Debian/Ubuntu:

```bash
sudo apt install tesseract-ocr
```

Su Windows, installare Tesseract tramite [l’installer UB Mannheim](https://github.com/UB-Mannheim/tesseract/wiki), includendo i dati lingua inglese e aggiungendo `C:\Program Files\Tesseract-OCR` al `PATH`. Riavviare PowerShell dopo la modifica.

Non sono richieste librerie Python esterne al momento.

## Utilizzo

Dalla directory del progetto:

```bash
uv run parse_scans.py
```

Lo script cerca i file `screenshots/Screenshot_*.png`, esegue l’OCR solo sugli screenshot non ancora presenti nell’archivio e aggiorna:

- `data/measurements.json` — archivio normalizzato generato;
- `data/measurements.csv` — esportazione tabellare;
- `data/ocr/*.txt` — testo OCR grezzo;
- `dashboard.html` — dashboard generata.

Per aggiungere una nuova pesata è sufficiente copiare il PNG nella cartella `screenshots/` e rilanciare il comando. È consigliato il nome `Screenshot_YYYYMMDD-HHMMSS.png`.

Se l’OCR sbaglia, aggiungere i valori corretti in `data/overrides.json`, usando il nome del file come chiave, e rilanciare l’importazione. Per rigenerare CSV e dashboard senza ripetere l’OCR:

```bash
uv run parse_scans.py --no-ocr
```

Per rielaborare intenzionalmente tutti gli screenshot già importati:

```bash
uv run parse_scans.py --force-ocr
```

Il parser valida struttura, tipi, intervalli plausibili e identificatori prima di aggiornare gli output. In caso di errore indica il file e il campo problematico e non scrive gli output della nuova esecuzione.

`data/measurements.json` è un output generato: non modificarlo direttamente. Per correggere un valore usare `data/overrides.json`; alla rigenerazione il parser ricostruisce la base dal testo in `data/ocr/` e riapplica le correzioni.
Le chiavi di `overrides.json` devono corrispondere a uno screenshot presente o a un referto già archiviato; un nome file inesistente viene segnalato come errore.

## Come vedere la dashboard

La dashboard è un normale file HTML autosufficiente.

Su macOS:

```bash
open dashboard.html
```

Su Windows PowerShell:

```powershell
Start-Process .\dashboard.html
```

Su Linux:

```bash
xdg-open dashboard.html
```

## Come aggiornare l’aspetto dell’HTML

- modificare `dashboard.template.html` per cambiare layout, colori, tabelle o grafici;
- non modificare direttamente `dashboard.html`: è un artefatto generato;
- dopo le modifiche eseguire `uv run parse_scans.py --no-ocr` per rigenerare la dashboard usando i dati già presenti.

Il JSON viene incorporato direttamente nell’HTML, quindi la dashboard non richiede database, rete o servizi esterni.

## Struttura

```text
parse_scans.py            # importazione OCR e generazione output
dashboard.template.html   # sorgente della dashboard
dashboard.html            # dashboard generata (locale)
screenshots/              # screenshot originali (locale)
data/
  measurements.json       # dati normalizzati generati (locale)
  measurements.csv        # esportazione (locale)
  overrides.json          # correzioni OCR (locale)
  ocr/                    # OCR grezzo (locale)
```

## Licenza

Distribuito con licenza [MIT](LICENSE).
