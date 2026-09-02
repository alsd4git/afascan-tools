import { SEGMENT_NAMES, type AfaScanRecord, type RecordOverride, type SegmentValues } from './model.js';

const first = (patterns: RegExp[], text: string): string | null => {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1] != null) return match[1];
  }
  return null;
};

export const numberValue = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const match = value.replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  return match ? Number.parseFloat(match[0]) : null;
};

const integerValue = (value: string | null | undefined): number | null => {
  const n = numberValue(value);
  return n == null ? null : Math.trunc(n);
};

const filenameDate = (sourceFile: string): string | null => {
  const match = sourceFile.match(/Screenshot_(\d{4})(\d{2})(\d{2})-(\d{6})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
};

export function extractRecord(sourceFile: string, text: string): AfaScanRecord {
  const reportDate = first([/\b(20\d{2}-\d{2}-\d{2})\s+\d{2}:\d{2}:\d{2}/im, /\b(20\d{2}-\d{2}-\d{2})\b/im], text) ?? filenameDate(sourceFile);
  return {
    device: 'AfaScan',
    report_type: /Body Composition Analysis/i.test(text) ? 'body_composition' : 'unknown',
    date: reportDate,
    source_file: sourceFile,
    report_id: first([/\b(20\d{12})\b/im], text),
    height_cm: numberValue(first([/\b(17\d)\s+30\s+(?:Male|Female)/im], text)),
    gender: first([/\b(?:17\d)\s+30\s+(Male|Female)\b/im], text),
    weight_kg: numberValue(first([/Weight\s*=.*?\n\s*([0-9]+[.,][0-9])\s*kg/im, /Weight \(kg\)\s+([0-9]+[.,][0-9])/im], text)),
    muscle_mass_kg: numberValue(first([/Weight\s*=.*?\n\s*[0-9]+[.,][0-9]\s*kg\s+([0-9]+[.,][0-9])\s*kg/im], text)),
    bone_mass_kg: numberValue(first([/Weight\s*=.*?\n\s*[0-9]+[.,][0-9]\s*kg\s+[0-9]+[.,][0-9]\s*kg\s+([0-9]+[.,][0-9])\s*kg/im], text)),
    body_fat_mass_kg: numberValue(first([/Weight\s*=.*?\n\s*(?:[0-9]+[.,][0-9]\s*kg\s+){3}([0-9]+[.,][0-9])\s*kg/im], text)),
    skeletal_muscle_mass_kg: numberValue(first([/Skeletal Muscle Mass \(Kg\).*?\n.*?([0-9]+[.,][0-9])/im, /Skeletal Muscle Mass \(kg\).*?\n.*?([0-9]+[.,][0-9])/im], text)),
    bmi: numberValue(first([/BMI \(kg\/m\??2\).*?\n.*?([0-9]+[.,][0-9])/im], text)),
    body_fat_percent: numberValue(first([/Body Fat Percent \(%\).*?\n.*?([0-9]+[.,][0-9])/im, /Body Fat Percent \(%\)\s+([0-9]+[.,][0-9])/im], text)),
    score: integerValue(first([/AfaScan\s*\n\s*(\d{2})\s*\/\s*100/im, /AfaScan\s+(\d{2})\s*\/\s*100/im], text)),
    target_weight_kg: numberValue(first([/Target Weight\s+([0-9]+[.,][0-9])\s*kg/im], text)),
    basal_metabolic_rate_kcal: integerValue(first([/Basal Metabolic Rate\s+(\d{3,4})/im], text)),
    visceral_fat_level: integerValue(first([/Visceral Fat Level\s+(\d{1,2})/im], text)),
    protein_percent: numberValue(first([/Protein Percent\s+([0-9]+[.,][0-9])%/im], text)),
    water_percent: numberValue(first([/Water Percent\s+([0-9]+[.,][0-9])%/im], text)),
    segment_fat_kg: null,
    segment_lean_kg: null,
    ocr_status: 'ocr',
  };
}

const completeSegment = (value: SegmentValues | null): boolean => value != null && SEGMENT_NAMES.every((name) => Number.isFinite(value[name]));

export function tidyRecord(record: AfaScanRecord): AfaScanRecord {
  let review = [record.date, record.weight_kg, record.body_fat_percent, record.skeletal_muscle_mass_kg].some((value) => value == null);
  if (record.report_type === 'body_composition') review ||= !completeSegment(record.segment_fat_kg) || !completeSegment(record.segment_lean_kg);
  return { ...record, review_required: review };
}

export function applyOverrides(record: AfaScanRecord, overrides: RecordOverride): AfaScanRecord {
  return tidyRecord({ ...record, ...overrides });
}

export function buildOverrides(base: AfaScanRecord, edited: AfaScanRecord): RecordOverride {
  const ignored = new Set(['device', 'report_type', 'source_file', 'review_required']);
  const result: Record<string, unknown> = {};
  const left = base as unknown as Record<string, unknown>;
  const right = edited as unknown as Record<string, unknown>;
  for (const key of Object.keys(right)) {
    if (!ignored.has(key) && JSON.stringify(left[key]) !== JSON.stringify(right[key])) result[key] = right[key];
  }
  return result as RecordOverride;
}
