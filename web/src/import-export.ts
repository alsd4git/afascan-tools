import type { AfaScanRecord, BackupFile, RecordOverride, StoredReport } from './model.js';
import { tidyRecord } from './parser.js';

const fields = ['date','source_file','weight_kg','skeletal_muscle_mass_kg','body_fat_percent','body_fat_mass_kg','bmi','basal_metabolic_rate_kcal','visceral_fat_level','water_percent','protein_percent','score','target_weight_kg','review_required'] as const;
const segments = ['right_arm','left_arm','trunk','right_leg','left_leg'] as const;
const numericFields = ['height_cm','weight_kg','muscle_mass_kg','bone_mass_kg','body_fat_mass_kg','skeletal_muscle_mass_kg','bmi','body_fat_percent','score','target_weight_kg','basal_metabolic_rate_kcal','visceral_fat_level','protein_percent','water_percent'] as const;
const numericOverrideFields = new Set<string>(numericFields);
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

const isNullableNumber = (value: unknown): value is number | null => value === null || (typeof value === 'number' && Number.isFinite(value));
const isNullableString = (value: unknown, maxLength = 512): value is string | null => value === null || (typeof value === 'string' && value.length <= maxLength && !value.includes('\0'));
const isDate = (value: unknown): value is string | null => {
  if (value === null) return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};
const isGender = (value: unknown): value is string | null => value === null || value === 'Male' || value === 'Female';
const isOcrStatus = (value: unknown): value is AfaScanRecord['ocr_status'] => value === null || value === 'ocr' || value === 'manual';
const isSegmentValues = (value: unknown): boolean => value === null || (!!value && typeof value === 'object' && !Array.isArray(value) && Object.entries(value).every(([key, entry]) => segments.includes(key as (typeof segments)[number]) && isNullableNumber(entry)));

const isRecord = (value: unknown): value is AfaScanRecord => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<AfaScanRecord>;
  if (typeof record.source_file !== 'string' || !record.source_file || record.source_file.length > 512 || record.source_file.includes('\0')) return false;
  if (typeof record.device !== 'string' || record.device.length > 64) return false;
  if (typeof record.report_type !== 'string' || record.report_type.length > 64) return false;
  if (!isDate(record.date) || !isNullableString(record.report_id, 128) || !isGender(record.gender)) return false;
  if (!numericFields.every((field) => isNullableNumber(record[field]))) return false;
  if (!isSegmentValues(record.segment_fat_kg) || !isSegmentValues(record.segment_lean_kg)) return false;
  if (!isOcrStatus(record.ocr_status)) return false;
  return record.review_required === undefined || typeof record.review_required === 'boolean';
};

const isRecordOverride = (value: unknown): value is RecordOverride => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  for (const [key, entry] of Object.entries(value)) {
    if (numericOverrideFields.has(key)) {
      if (!isNullableNumber(entry)) return false;
      continue;
    }
    if (key === 'date') {
      if (!isDate(entry)) return false;
      continue;
    }
    if (key === 'report_id') {
      if (!isNullableString(entry, 128)) return false;
      continue;
    }
    if (key === 'gender') {
      if (!isGender(entry)) return false;
      continue;
    }
    if (key === 'segment_fat_kg' || key === 'segment_lean_kg') {
      if (!isSegmentValues(entry)) return false;
      continue;
    }
    if (key === 'ocr_status') {
      if (!isOcrStatus(entry)) return false;
      continue;
    }
    return false;
  }
  return true;
};

const isStoredReport = (value: unknown): value is StoredReport => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const report = value as Partial<StoredReport>;
  return typeof report.id === 'string'
    && typeof report.source_file === 'string'
    && report.source_file.length <= 512
    && (report.source_sha256 === null || (typeof report.source_sha256 === 'string' && /^[a-f0-9]{64}$/i.test(report.source_sha256)))
    && typeof report.imported_at === 'string'
    && Number.isFinite(Date.parse(report.imported_at))
    && (report.ocr_text === null || (typeof report.ocr_text === 'string' && report.ocr_text.length <= 5_000_000))
    && isRecord(report.extracted_record)
    && report.source_file === report.extracted_record.source_file
    && isRecordOverride(report.overrides)
    && typeof report.review_required === 'boolean'
    && report.schema_version === 1
    && report.parser_version === 1;
};

export function parseImport(text: string): StoredReport[] {
  const value: unknown = JSON.parse(text);
  if (value && typeof value === 'object' && (value as BackupFile).format === 'afascan-tools-backup') {
    const backup = value as BackupFile;
    if (backup.version !== 1 || !Array.isArray(backup.reports) || !backup.reports.every(isStoredReport)) throw new Error('Unsupported AfaScan backup');
    return backup.reports.map((report) => {
      const normalized = tidyRecord(report.extracted_record);
      return {
        ...report,
        id: crypto.randomUUID(),
        source_file: normalized.source_file,
        extracted_record: normalized,
        review_required: Boolean(normalized.review_required),
      };
    });
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
