import './style.css';
import { renderDashboard } from './dashboard.js';
import { createBackup, downloadText, parseImport, recordsToCsv } from './import-export.js';
import { SEGMENT_NAMES, type AfaScanRecord, type StoredReport } from './model.js';
import { applyOverrides, buildOverrides, extractRecord, tidyRecord } from './parser.js';
import { createOcrWorker, recognize, releaseOcrWorker, sha256 } from './ocr.js';
import { clearReports, DATABASE_NAME, deleteReport, listReports, saveReport, saveReports } from './storage.js';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Missing #app');

app.innerHTML = `
<header class="site-header"><div><h1>AfaScan Tools</h1><p>Local-first OCR and report history. Screenshots are processed in your browser and are not stored.</p></div><a href="https://github.com/alsd4git/afascan-tools" target="_blank" rel="noreferrer">GitHub</a></header>
<nav class="tabs"><button data-tab="import" class="active">Import</button><button data-tab="dashboard">Dashboard</button><button data-tab="reports">Reports <span id="report-count"></span></button><button data-tab="data">Import / Export</button></nav>
<main>
<div id="notice" class="notice" hidden></div>
<section id="tab-import" class="tab active">
  <div class="privacy"><strong>Your reports stay on this device.</strong><span>OCR runs locally with self-hosted Tesseract.js assets. Original screenshots are released after processing.</span></div>
  <div id="drop" class="drop" tabindex="0"><strong>Drop AfaScan screenshots here</strong><span>or choose PNG/JPEG/WebP files · clipboard paste is supported</span><button id="choose">Choose screenshots</button><input id="files" type="file" accept="image/png,image/jpeg,image/webp" multiple hidden /></div>
  <div id="ocr" class="card" hidden><div class="status"><strong id="ocr-name"></strong><span id="ocr-label"></span></div><p id="ocr-hint" class="ocr-hint"></p><progress id="ocr-progress" max="1"></progress></div>
  <div id="review" class="card" hidden></div>
</section>
<section id="tab-dashboard" class="tab"><div id="dashboard"></div></section>
<section id="tab-reports" class="tab"><div class="heading"><div><h2>Saved reports</h2><p>Only normalized data, OCR text and overrides are persisted.</p></div></div><div id="reports"></div></section>
<section id="tab-data" class="tab"><div class="cards">
  <article class="card"><h2>Export</h2><p>Back up the archive or export CLI-compatible data.</p><div class="stack"><button id="export-json">Export measurements.json</button><button id="export-csv">Export measurements.csv</button><button id="export-backup">Export full backup</button></div></article>
  <article class="card"><h2>Import</h2><p>Import a web backup or CLI measurements.json.</p><button id="import-json">Choose JSON file</button><input id="import-file" type="file" accept="application/json,.json" hidden /></article>
  <article class="card"><h2>Local storage</h2><p>Database: <code>${DATABASE_NAME}</code></p><button id="delete-all" class="danger">Delete all local data</button></article>
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
let reports: StoredReport[] = [];
type ReviewItem = { mode: 'new'; hash: string; text: string; base: AfaScanRecord } | { mode: 'edit'; stored: StoredReport; base: AfaScanRecord };
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
  ['height_cm','Height','cm'],['weight_kg','Weight','kg'],['muscle_mass_kg','Muscle mass','kg'],['bone_mass_kg','Bone mass','kg'],['body_fat_mass_kg','Body fat mass','kg'],['skeletal_muscle_mass_kg','Skeletal muscle mass','kg'],['bmi','BMI',''],['body_fat_percent','Body fat','%'],['score','Score','/100'],['target_weight_kg','Target weight','kg'],['basal_metabolic_rate_kcal','Basal metabolic rate','kcal'],['visceral_fat_level','Visceral fat',''],['protein_percent','Protein','%'],['water_percent','Water','%']
];
const escapeHtml = (value: unknown): string => { const div = document.createElement('div'); div.textContent = String(value ?? ''); return div.innerHTML; };
const field = (name: string, label: string, value: unknown, suffix = '', type = 'number') => `<label class="field"><span>${label}${suffix ? ` <small>${suffix}</small>` : ''}</span><input name="${name}" type="${type}" ${type === 'number' ? 'step="any"' : ''} value="${escapeHtml(value)}"></label>`;

function renderReview(item: ReviewItem): void {
  active = item;
  const current = item.mode === 'edit' ? applyOverrides(item.base, item.stored.overrides) : tidyRecord(item.base);
  const segment = (kind: 'segment_fat_kg' | 'segment_lean_kg', title: string) => `<fieldset><legend>${title}</legend><div class="grid compact">${SEGMENT_NAMES.map((name) => field(`${kind}.${name}`, name.replaceAll('_',' '), current[kind]?.[name], 'kg')).join('')}</div></fieldset>`;
  reviewRoot.innerHTML = `<div class="heading"><div><h2>${item.mode === 'new' ? 'Review extracted data' : 'Edit saved report'}</h2><p>${escapeHtml(current.source_file)}${current.review_required ? ' · review recommended' : ''}</p></div></div>
<form id="review-form"><div class="grid">${field('date','Report date',current.date,'','date')}${field('report_id','Report ID',current.report_id,'','text')}${field('gender','Gender',current.gender,'','text')}${numberFields.map(([key,label,suffix]) => field(String(key),label,current[key],suffix)).join('')}</div><div class="segments">${segment('segment_fat_kg','Segment fat')}${segment('segment_lean_kg','Segment lean')}</div><details><summary>Raw OCR text</summary><pre>${escapeHtml(item.mode === 'new' ? item.text : item.stored.ocr_text || 'Not available for imported CLI data.')}</pre></details><div class="review-actions"><button type="button" id="cancel" class="secondary">${item.mode === 'new' ? 'Discard' : 'Cancel'}</button><button type="submit">Save report</button></div></form>`;
  reviewRoot.hidden = false;
  $('#cancel').addEventListener('click', finishReview);
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
  message(`Saved ${stored.source_file}${stored.review_required ? ' (review still recommended)' : ''}.`);
  finishReview();
}
function finishReview(): void {
  active = null; reviewRoot.hidden = true; reviewRoot.replaceChildren();
  const next = queue.shift(); if (next) renderReview(next);
}

async function refresh(): Promise<void> {
  reports = await listReports();
  reportCount.textContent = reports.length ? `(${reports.length})` : '';
  renderReports();
  if ($('#tab-dashboard').classList.contains('active')) renderDashboard(dashboardRoot, reports.map((r) => r.extracted_record));
}
function renderReports(): void {
  if (!reports.length) { reportsRoot.innerHTML = '<div class="empty">No reports saved yet.</div>'; return; }
  reportsRoot.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Source</th><th>Weight</th><th>Body fat</th><th>Status</th><th></th></tr></thead><tbody>${reports.slice().reverse().map((r) => `<tr><td>${r.extracted_record.date ?? '—'}</td><td>${escapeHtml(r.source_file)}</td><td>${r.extracted_record.weight_kg ?? '—'} kg</td><td>${r.extracted_record.body_fat_percent ?? '—'}%</td><td>${r.review_required ? '<span class="warning">Review</span>' : 'Ready'}</td><td class="actions"><button data-edit="${r.id}" class="secondary">Edit</button><button data-delete="${r.id}" class="danger ghost">Delete</button></td></tr>`).join('')}</tbody></table></div>`;
  reportsRoot.querySelectorAll<HTMLButtonElement>('[data-edit]').forEach((button) => button.addEventListener('click', () => editReport(button.dataset.edit || '')));
  reportsRoot.querySelectorAll<HTMLButtonElement>('[data-delete]').forEach((button) => button.addEventListener('click', () => void removeReport(button.dataset.delete || '')));
}
function editReport(id: string): void {
  const stored = reports.find((r) => r.id === id); if (!stored) return;
  const base = stored.ocr_text ? extractRecord(stored.source_file, stored.ocr_text) : stored.extracted_record;
  tab('import'); renderReview({ mode: 'edit', stored, base });
}
async function removeReport(id: string): Promise<void> {
  const stored = reports.find((r) => r.id === id); if (!stored || !confirm(`Delete ${stored.source_file}?`)) return;
  await deleteReport(id); await refresh();
}

const OCR_STATUS: Record<string, string> = {
  'loading tesseract core': 'Downloading OCR engine…',
  'initializing tesseract': 'Initializing OCR engine…',
  'loading language traineddata': 'Downloading English OCR data…',
  'initializing api': 'Preparing OCR API…',
  'recognizing text': 'Reading screenshot…',
};

function updateOcrStatus(status: string, progress: number, current: string): void {
  const isResourceLoad = status === 'loading tesseract core' || status === 'loading language traineddata';
  ocrName.textContent = current || 'Preparing OCR engine';
  ocrLabel.textContent = OCR_STATUS[status] || status;
  ocrHint.textContent = isResourceLoad
    ? 'First OCR start downloads about 6 MB of self-hosted resources. This can take a while; your screenshot is not uploaded.'
    : status === 'recognizing text'
      ? 'OCR is running locally in your browser.'
      : 'Preparing the local OCR engine…';

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

  ocrName.textContent = 'Preparing OCR engine';
  ocrLabel.textContent = 'Loading local OCR resources…';
  ocrHint.textContent = 'First OCR start downloads about 6 MB of self-hosted resources. Later runs may reuse the browser cache.';
  ocrProgress.removeAttribute('value');

  try {
    worker = await createOcrWorker((status, progress) => updateOcrStatus(status, progress, current));
    for (const file of images) {
      current = file.name || `clipboard-${Date.now()}.png`;
      ocrName.textContent = current;
      ocrLabel.textContent = 'Checking duplicate…';
      ocrHint.textContent = 'Computing a SHA-256 hash locally before OCR.';
      ocrProgress.removeAttribute('value');
      const hash = await sha256(file);
      if (reports.some((r) => r.source_sha256 === hash)) { skipped += 1; continue; }
      const text = await recognize(worker, file);
      const record = tidyRecord(extractRecord(current, text));
      if (record.report_id && reports.some((r) => r.extracted_record.report_id === record.report_id)) { skipped += 1; continue; }
      queue.push({ mode: 'new', hash, text, base: record }); added += 1;
    }
  } catch (error) {
    failed = true;
    message(error instanceof Error ? error.message : 'OCR failed', true);
  } finally {
    ocrBox.hidden = true;
  }
  if (!active) { const next = queue.shift(); if (next) renderReview(next); }
  if (!failed && (added || skipped)) message(`${added} report${added === 1 ? '' : 's'} ready for review${skipped ? ` · ${skipped} duplicate${skipped === 1 ? '' : 's'} skipped` : ''}.`);
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
importFile.addEventListener('change', async () => { const file = importFile.files?.[0]; if (!file) return; try { const imported = parseImport(await file.text()); await saveReports(imported); await refresh(); message(`Imported ${imported.length} report${imported.length === 1 ? '' : 's'}.`); } catch (error) { message(error instanceof Error ? error.message : 'Import failed', true); } finally { importFile.value = ''; } });
$('#delete-all').addEventListener('click', async () => { if (!confirm('Delete every locally stored report for this deployment?')) return; await clearReports(); await refresh(); message('All local data deleted.'); });
void refresh();
