import './style.css';
import { renderDashboard } from './dashboard.js';
import { createBackup, downloadText, parseImport, recordsToCsv } from './import-export.js';
import { SEGMENT_NAMES, type AfaScanRecord, type StoredReport } from './model.js';
import { applyOverrides, buildOverrides, extractRecord, tidyRecord } from './parser.js';
import { createOcrWorker, prepareOcrImage, recognize, releaseOcrWorker, sha256 } from './ocr.js';
import { clearReports, DATABASE_NAME, deleteReport, listReports, saveReport, saveReports } from './storage.js';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Missing #app');

app.innerHTML = `
<header class="site-header"><div><h1>AfaScan Tools</h1><p>OCR locale e storico dei referti. Gli screenshot vengono elaborati nel browser e non vengono inviati.</p></div><a href="https://github.com/alsd4git/afascan-tools" target="_blank" rel="noreferrer">GitHub</a></header>
<nav class="tabs"><button data-tab="import" class="active">Importa</button><button data-tab="dashboard">Dashboard</button><button data-tab="reports">Referti <span id="report-count"></span></button><button data-tab="data">Dati</button></nav>
<main>
<div id="notice" class="notice" hidden></div>
<section id="tab-import" class="tab active">
  <div class="privacy"><strong>I tuoi referti restano su questo dispositivo.</strong><span>L'OCR viene eseguito localmente con risorse Tesseract.js servite dalla stessa pagina. Lo screenshot originale resta disponibile solo durante la revisione.</span><span class="precision-note"><strong>Serve la massima precisione?</strong> Per i valori ambigui, il CLI offline può risultare più affidabile perché usa Tesseract nativo sul PC e consente preprocessing aggiuntivo. Usa gli stessi dati linguistici: la revisione manuale resta consigliata. Le bande nere esterne degli screenshot standard vengono ignorate automaticamente quando riconosciute.</span></div>
  <div id="drop" class="drop" tabindex="0"><strong>Trascina qui gli screenshot AfaScan</strong><span>oppure scegli file PNG/JPEG/WebP · puoi anche incollarli dagli appunti</span><button id="choose">Scegli screenshot</button><input id="files" type="file" accept="image/png,image/jpeg,image/webp" multiple hidden /></div>
  <div id="ocr" class="card" hidden><div class="status"><strong id="ocr-name"></strong><span id="ocr-label"></span></div><p id="ocr-hint" class="ocr-hint"></p><progress id="ocr-progress" max="1"></progress></div>
  <div id="review" class="card" hidden></div>
</section>
<section id="tab-dashboard" class="tab"><div id="dashboard"></div></section>
<section id="tab-reports" class="tab"><div class="heading"><div><h2>Referti salvati</h2><p>Vengono conservati solo dati normalizzati, testo OCR e correzioni.</p></div><button id="delete-all-reports" class="danger">Cancella tutto</button></div><div id="reports"></div></section>
<section id="tab-data" class="tab"><div class="cards">
  <article class="card"><h2>Esporta</h2><p>Salva una copia dell'archivio o dati compatibili con il CLI.</p><div class="stack"><button id="export-json">Esporta measurements.json</button><button id="export-csv">Esporta measurements.csv</button><button id="export-backup">Esporta backup completo</button></div></article>
  <article class="card"><h2>Importa</h2><p>Importa un backup web o un measurements.json del CLI.</p><button id="import-json">Scegli file JSON</button><input id="import-file" type="file" accept="application/json,.json" hidden /></article>
  <article class="card"><h2>Archiviazione locale</h2><p>Database: <code>${DATABASE_NAME}</code></p><button id="delete-all" class="danger">Cancella tutti i dati locali</button></article>
</div></section>
</main>`;

const $ = <T extends HTMLElement>(selector: string): T => {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Missing ${selector}`);
  return node;
};
const notice = $('#notice');
const reviewRoot = $('#review');
const reportsRoot = $('#reports');
const dashboardRoot = $('#dashboard');
const reportCount = $('#report-count');
const ocrBox = $('#ocr');
const ocrName = $('#ocr-name');
const ocrLabel = $('#ocr-label');
const ocrHint = $('#ocr-hint');
const ocrProgress = $<HTMLProgressElement>('#ocr-progress');
const deleteAllReportsButton = $<HTMLButtonElement>('#delete-all-reports');
let reports: StoredReport[] = [];
type ReviewItem = { mode: 'new'; hash: string; text: string; base: AfaScanRecord; file: Blob | File; cropped: boolean; previewUrl?: string } | { mode: 'edit'; stored: StoredReport; base: AfaScanRecord };
let queue: ReviewItem[] = [];
let active: ReviewItem | null = null;

function message(text: string, error = false): void {
  notice.textContent = text;
  notice.className = error ? 'notice error' : 'notice';
  notice.hidden = false;
}
function tab(name: string): void {
  document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((button) => button.classList.toggle('active', button.dataset.tab === name));
  document.querySelectorAll<HTMLElement>('.tab').forEach((panel) => panel.classList.toggle('active', panel.id === `tab-${name}`));
  if (name === 'dashboard') renderDashboard(dashboardRoot, reports.map((r) => r.extracted_record));
}
document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((button) => button.addEventListener('click', () => tab(button.dataset.tab || 'import')));

const numberFields: Array<[keyof AfaScanRecord, string, string]> = [
  ['height_cm','Altezza','cm'],['weight_kg','Peso','kg'],['muscle_mass_kg','Massa muscolare','kg'],['bone_mass_kg','Massa ossea','kg'],['body_fat_mass_kg','Massa grassa','kg'],['skeletal_muscle_mass_kg','Massa muscolare scheletrica','kg'],['bmi','BMI',''],['body_fat_percent','Grasso corporeo','%'],['score','Punteggio','/100'],['target_weight_kg','Peso obiettivo','kg'],['basal_metabolic_rate_kcal','Metabolismo basale','kcal'],['visceral_fat_level','Grasso viscerale',''],['protein_percent','Proteine','%'],['water_percent','Acqua','%']
];
const escapeHtml = (value: unknown): string => { const div = document.createElement('div'); div.textContent = String(value ?? ''); return div.innerHTML; };
const field = (name: string, label: string, value: unknown, suffix = '', type = 'number') => {
  const missing = value === null || value === undefined || value === '';
  return `<label class="field${missing ? ' missing' : ''}"><span>${label}${suffix ? ` <small>${suffix}</small>` : ''}${missing ? ' <small class="missing-label">mancante · verifica</small>' : ''}</span><input name="${name}" type="${type}" ${type === 'number' ? 'step="any"' : ''} value="${escapeHtml(value)}"></label>`;
};

function renderReview(item: ReviewItem): void {
  active = item;
  const current = item.mode === 'edit' ? applyOverrides(item.base, item.stored.overrides) : tidyRecord(item.base);
  const previewUrl = item.mode === 'new' ? (item.previewUrl ||= URL.createObjectURL(item.file)) : null;
  const segment = (kind: 'segment_fat_kg' | 'segment_lean_kg', title: string) => `<fieldset><legend>${title}</legend><div class="grid compact">${SEGMENT_NAMES.map((name) => field(`${kind}.${name}`, name.replaceAll('_',' '), current[kind]?.[name], 'kg')).join('')}</div></fieldset>`;
  const preview = previewUrl ? `<aside class="preview-card"><h3>${item.mode === 'new' && item.cropped ? 'Screenshot ripulito' : 'Screenshot originale'}</h3><p>${item.mode === 'new' && item.cropped ? 'Bande nere esterne rimosse automaticamente per facilitare la verifica.' : 'Usalo per verificare i valori prima di salvare.'}</p><button type="button" class="preview-trigger" id="open-preview"><img class="report-preview" src="${escapeHtml(previewUrl)}" alt="Screenshot AfaScan per la verifica"><span>Apri ingrandito</span></button><dialog class="preview-dialog" id="preview-dialog"><div class="preview-dialog-content"><div class="preview-dialog-toolbar"><strong>Screenshot AfaScan</strong><div><button type="button" class="secondary" data-zoom="-1" aria-label="Riduci zoom">−</button><button type="button" class="secondary" data-zoom="0">100%</button><button type="button" class="secondary" data-zoom="1" aria-label="Aumenta zoom">+</button><button type="button" class="secondary" id="close-preview">Chiudi</button></div></div><div class="preview-dialog-viewport"><img class="preview-dialog-image" src="${escapeHtml(previewUrl)}" alt="Screenshot AfaScan ingrandito"></div></div></dialog></aside>` : '';
  reviewRoot.innerHTML = `<div class="review-layout">${preview}<div class="review-form-panel"><div class="heading"><div><h2>${item.mode === 'new' ? 'Verifica dati estratti' : 'Modifica referto salvato'}</h2><p>${escapeHtml(current.source_file)}${current.review_required ? ' · revisione consigliata' : ''}</p></div></div>
<form id="review-form"><div class="grid">${field('date','Data referto',current.date,'','date')}${field('report_id','ID referto',current.report_id,'','text')}${field('gender','Sesso',current.gender,'','text')}${numberFields.map(([key,label,suffix]) => field(String(key),label,current[key],suffix)).join('')}</div><div class="segments">${segment('segment_fat_kg','Massa grassa segmentale')}${segment('segment_lean_kg','Massa magra segmentale')}</div><details><summary>Testo OCR grezzo (inglese)</summary><pre>${escapeHtml(item.mode === 'new' ? item.text : item.stored.ocr_text || 'Non disponibile per dati importati dal CLI.')}</pre></details><div class="review-actions"><button type="button" id="cancel" class="secondary">${item.mode === 'new' ? 'Scarta' : 'Annulla'}</button><button type="submit">Salva referto</button></div></form></div></div>`;
  reviewRoot.hidden = false;
  $('#cancel').addEventListener('click', () => finishReview(true));
  if (previewUrl) {
    const previewDialog = $<HTMLDialogElement>('#preview-dialog');
    const previewImage = $<HTMLImageElement>('.preview-dialog-image');
    let zoom = 1;
    const updateZoom = (): void => { previewImage.style.transform = `scale(${zoom})`; previewDialog.querySelector<HTMLButtonElement>('[data-zoom="0"]')!.textContent = `${Math.round(zoom * 100)}%`; };
    $('#open-preview').addEventListener('click', () => { zoom = 1; updateZoom(); previewDialog.showModal(); });
    $('#close-preview').addEventListener('click', () => previewDialog.close());
    previewDialog.querySelectorAll<HTMLButtonElement>('[data-zoom]').forEach((button) => button.addEventListener('click', () => { const delta = Number(button.dataset.zoom); zoom = delta === 0 ? 1 : Math.min(3, Math.max(1, zoom + delta * 0.5)); updateZoom(); }));
    previewDialog.addEventListener('click', (event) => { if (event.target === previewDialog) previewDialog.close(); });
  }
  $<HTMLFormElement>('#review-form').addEventListener('submit', (event) => { event.preventDefault(); void saveReview(new FormData(event.currentTarget as HTMLFormElement)); });
}
function formNumber(form: FormData, name: string): number | null {
  const value = String(form.get(name) ?? '').trim();
  if (!value) return null;
  const parsed = Number(value.replace(',','.'));
  return Number.isFinite(parsed) ? parsed : null;
}
function editedRecord(base: AfaScanRecord, form: FormData): AfaScanRecord {
  const record = { ...base };
  record.date = String(form.get('date') ?? '').trim() || null;
  record.report_id = String(form.get('report_id') ?? '').trim() || null;
  record.gender = String(form.get('gender') ?? '').trim() || null;
  for (const [key] of numberFields) (record as unknown as Record<string, unknown>)[key] = formNumber(form, String(key));
  record.segment_fat_kg = {}; record.segment_lean_kg = {};
  for (const name of SEGMENT_NAMES) { record.segment_fat_kg[name] = formNumber(form, `segment_fat_kg.${name}`); record.segment_lean_kg[name] = formNumber(form, `segment_lean_kg.${name}`); }
  return tidyRecord(record);
}
async function saveReview(form: FormData): Promise<void> {
  if (!active) return;
  const item = active;
  const edited = editedRecord(item.base, form);
  const overrides = buildOverrides(item.base, edited);
  const stored: StoredReport = item.mode === 'edit' ? { ...item.stored, extracted_record: edited, overrides, review_required: Boolean(edited.review_required) } : { id: crypto.randomUUID(), source_file: edited.source_file, source_sha256: item.hash, imported_at: new Date().toISOString(), ocr_text: item.text, extracted_record: edited, overrides, review_required: Boolean(edited.review_required), schema_version: 1, parser_version: 1 };
  await saveReport(stored);
  await refresh();
  message(`Referto ${stored.source_file} salvato${stored.review_required ? ' (revisione ancora consigliata)' : ''}.`);
  finishReview();
}
function finishReview(clearStatus = false): void {
  if (active?.mode === 'new' && active.previewUrl) URL.revokeObjectURL(active.previewUrl);
  active = null; reviewRoot.hidden = true; reviewRoot.replaceChildren();
  const next = queue.shift();
  if (next) renderReview(next);
  else if (clearStatus) notice.hidden = true;
}

async function refresh(): Promise<void> {
  reports = await listReports();
  reportCount.textContent = reports.length ? `(${reports.length})` : '';
  renderReports();
  if ($('#tab-dashboard').classList.contains('active')) renderDashboard(dashboardRoot, reports.map((r) => r.extracted_record));
}
function renderReports(): void {
  if (!reports.length) { reportsRoot.innerHTML = '<div class="empty">Nessun referto salvato.</div>'; return; }
  reportsRoot.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Data</th><th>Origine</th><th>Peso</th><th>Grasso corporeo</th><th>Stato</th><th></th></tr></thead><tbody>${reports.slice().reverse().map((r) => `<tr><td>${r.extracted_record.date ?? '—'}</td><td>${escapeHtml(r.source_file)}</td><td>${r.extracted_record.weight_kg ?? '—'} kg</td><td>${r.extracted_record.body_fat_percent ?? '—'}%</td><td>${r.review_required ? '<span class="warning">Da verificare</span>' : 'Pronto'}</td><td class="actions"><button data-edit="${r.id}" class="secondary">Modifica</button><button data-delete="${r.id}" class="danger ghost">Elimina</button></td></tr>`).join('')}</tbody></table></div>`;
  reportsRoot.querySelectorAll<HTMLButtonElement>('[data-edit]').forEach((button) => button.addEventListener('click', () => editReport(button.dataset.edit || '')));
  reportsRoot.querySelectorAll<HTMLButtonElement>('[data-delete]').forEach((button) => button.addEventListener('click', () => void removeReport(button.dataset.delete || '')));
}
function editReport(id: string): void {
  const stored = reports.find((r) => r.id === id); if (!stored) return;
  const base = stored.ocr_text ? extractRecord(stored.source_file, stored.ocr_text) : stored.extracted_record;
  tab('import'); renderReview({ mode: 'edit', stored, base });
}
async function removeReport(id: string): Promise<void> {
  const stored = reports.find((r) => r.id === id); if (!stored || !confirm(`Eliminare ${stored.source_file}?`)) return;
  await deleteReport(id); await refresh();
}
async function clearAllReports(): Promise<void> {
  if (!reports.length || !confirm('Eliminare tutti i referti salvati su questo dispositivo?')) return;
  await clearReports();
  await refresh();
  message('Tutti i referti locali sono stati cancellati.');
}
deleteAllReportsButton.addEventListener('click', () => void clearAllReports());

const OCR_STATUS: Record<string, string> = {
  'loading tesseract core': 'Scaricamento motore OCR…',
  'initializing tesseract': 'Inizializzazione motore OCR…',
  'loading language traineddata': 'Scaricamento dati OCR inglesi…',
  'initializing api': 'Preparazione API OCR…',
  'recognizing text': 'Lettura screenshot…',
};

function updateOcrStatus(status: string, progress: number, current: string): void {
  const isResourceLoad = status === 'loading tesseract core' || status === 'loading language traineddata';
  ocrName.textContent = current || 'Preparazione motore OCR';
  ocrLabel.textContent = OCR_STATUS[status] || status;
  ocrHint.textContent = isResourceLoad
    ? 'Al primo avvio vengono scaricati circa 6 MB di risorse locali. Può richiedere tempo; lo screenshot non viene inviato.'
    : status === 'recognizing text'
      ? 'L’OCR viene eseguito localmente nel browser.'
      : 'Preparazione del motore OCR locale…';

  if (Number.isFinite(progress) && progress > 0 && progress <= 1) {
    ocrProgress.value = progress;
  } else {
    ocrProgress.removeAttribute('value');
  }
}

async function processFiles(files: File[]): Promise<void> {
  const images = files.filter((file) => file.type.startsWith('image/')); if (!images.length) return;
  ocrBox.hidden = false;
  let current = '';
  let worker: Awaited<ReturnType<typeof createOcrWorker>> | null = null;
  let added = 0; let skipped = 0;
  let failed = false;

  ocrName.textContent = 'Preparazione motore OCR';
  ocrLabel.textContent = 'Caricamento risorse OCR locali…';
  ocrHint.textContent = 'Al primo avvio vengono scaricati circa 6 MB di risorse locali. Gli avvii successivi possono riutilizzare la cache del browser.';
  ocrProgress.removeAttribute('value');

  try {
    worker = await createOcrWorker((status, progress) => updateOcrStatus(status, progress, current));
    for (const file of images) {
      current = file.name || `clipboard-${Date.now()}.png`;
      ocrName.textContent = current;
      ocrLabel.textContent = 'Controllo duplicati…';
      ocrHint.textContent = 'Calcolo locale dell’hash SHA-256 prima dell’OCR.';
      ocrProgress.removeAttribute('value');
      const hash = await sha256(file);
      if (reports.some((r) => r.source_sha256 === hash)) { skipped += 1; continue; }
      const prepared = await prepareOcrImage(file);
      const text = await recognize(worker, file, prepared);
      const record = tidyRecord(extractRecord(current, text));
      if (record.report_id && reports.some((r) => r.extracted_record.report_id === record.report_id)) { skipped += 1; continue; }
      queue.push({ mode: 'new', hash, text, base: record, file: prepared.source, cropped: prepared.cropped }); added += 1;
    }
  } catch (error) {
    failed = true;
    message(error instanceof Error ? error.message : 'OCR non riuscito', true);
  } finally {
    ocrBox.hidden = true;
  }
  if (!active) { const next = queue.shift(); if (next) renderReview(next); }
  if (!failed && (added || skipped)) message(`${added} referto${added === 1 ? '' : 'i'} pronto${added === 1 ? '' : 'i'} per la revisione${skipped ? ` · ${skipped} duplicato${skipped === 1 ? '' : 'i'} ignorato${skipped === 1 ? '' : 'i'}` : ''}.`);
}

window.addEventListener('pagehide', () => { void releaseOcrWorker(); });

const fileInput = $<HTMLInputElement>('#files');
$('#choose').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { void processFiles(Array.from(fileInput.files || [])); fileInput.value = ''; });
const drop = $('#drop');
drop.addEventListener('dragover', (event) => { event.preventDefault(); drop.classList.add('dragging'); });
drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
drop.addEventListener('drop', (event) => { event.preventDefault(); drop.classList.remove('dragging'); void processFiles(Array.from(event.dataTransfer?.files || [])); });
document.addEventListener('paste', (event) => { const files = Array.from(event.clipboardData?.files || []).filter((file) => file.type.startsWith('image/')); if (files.length) { tab('import'); void processFiles(files); } });

$('#export-json').addEventListener('click', () => downloadText('measurements.json', `${JSON.stringify(reports.map((r) => r.extracted_record), null, 2)}\n`));
$('#export-csv').addEventListener('click', () => downloadText('measurements.csv', recordsToCsv(reports.map((r) => r.extracted_record)), 'text/csv'));
$('#export-backup').addEventListener('click', () => downloadText('afascan-backup.json', `${JSON.stringify(createBackup(reports), null, 2)}\n`));
const importFile = $<HTMLInputElement>('#import-file');
$('#import-json').addEventListener('click', () => importFile.click());
importFile.addEventListener('change', async () => { const file = importFile.files?.[0]; if (!file) return; try { const imported = parseImport(await file.text()); await saveReports(imported); await refresh(); message(`Importati ${imported.length} refert${imported.length === 1 ? 'o' : 'i'}.`); } catch (error) { message(error instanceof Error ? error.message : 'Importazione non riuscita', true); } finally { importFile.value = ''; } });
$('#delete-all').addEventListener('click', () => void clearAllReports());
void refresh();
