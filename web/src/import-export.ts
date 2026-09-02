import type { AfaScanRecord, BackupFile, StoredReport } from './model.js';
import { tidyRecord } from './parser.js';

const fields = ['date','source_file','weight_kg','skeletal_muscle_mass_kg','body_fat_percent','body_fat_mass_kg','bmi','basal_metabolic_rate_kcal','visceral_fat_level','water_percent','protein_percent','score','target_weight_kg','review_required'] as const;
const segments = ['right_arm','left_arm','trunk','right_leg','left_leg'] as const;
const esc = (value: unknown): string => {
  if (value == null) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

export function recordsToCsv(records: AfaScanRecord[]): string {
  const headers = [...fields, ...segments.map((s) => `segment_fat_${s}_kg`), ...segments.map((s) => `segment_lean_${s}_kg`)];
  const rows = records.map((r) => {
    const values: unknown[] = fields.map((field) => r[field]);
    values.push(...segments.map((s) => r.segment_fat_kg?.[s] ?? null));
    values.push(...segments.map((s) => r.segment_lean_kg?.[s] ?? null));
    return values.map(esc).join(',');
  });
  return `${headers.join(',')}\n${rows.join('\n')}${rows.length ? '\n' : ''}`;
}

export function createBackup(reports: StoredReport[]): BackupFile {
  return { format: 'afascan-tools-backup', version: 1, exported_at: new Date().toISOString(), reports };
}

const isRecord = (value: unknown): value is AfaScanRecord => !!value && typeof value === 'object' && typeof (value as AfaScanRecord).source_file === 'string';

export function parseImport(text: string): StoredReport[] {
  const value: unknown = JSON.parse(text);
  if (value && typeof value === 'object' && (value as BackupFile).format === 'afascan-tools-backup') {
    const backup = value as BackupFile;
    if (backup.version !== 1 || !Array.isArray(backup.reports)) throw new Error('Unsupported AfaScan backup');
    return backup.reports;
  }
  if (!Array.isArray(value) || !value.every(isRecord)) throw new Error('Not a compatible measurements.json or AfaScan backup');
  return value.map((record) => {
    const normalized = tidyRecord(record);
    return { id: crypto.randomUUID(), source_file: normalized.source_file, source_sha256: null, imported_at: new Date().toISOString(), ocr_text: null, extracted_record: normalized, overrides: {}, review_required: Boolean(normalized.review_required), schema_version: 1, parser_version: 1 };
  });
}

export function downloadText(filename: string, text: string, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
