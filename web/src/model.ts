export const SEGMENT_NAMES = ['right_arm', 'left_arm', 'trunk', 'right_leg', 'left_leg'] as const;
export type SegmentName = (typeof SEGMENT_NAMES)[number];
export type SegmentValues = Partial<Record<SegmentName, number | null>>;

export interface AfaScanRecord {
  device: string;
  report_type: string;
  date: string | null;
  source_file: string;
  report_id: string | null;
  height_cm: number | null;
  gender: string | null;
  weight_kg: number | null;
  muscle_mass_kg: number | null;
  bone_mass_kg: number | null;
  body_fat_mass_kg: number | null;
  skeletal_muscle_mass_kg: number | null;
  bmi: number | null;
  body_fat_percent: number | null;
  score: number | null;
  target_weight_kg: number | null;
  basal_metabolic_rate_kcal: number | null;
  visceral_fat_level: number | null;
  protein_percent: number | null;
  water_percent: number | null;
  segment_fat_kg: SegmentValues | null;
  segment_lean_kg: SegmentValues | null;
  ocr_status: 'ocr' | 'manual' | null;
  review_required?: boolean;
}

export type RecordOverride = Partial<Omit<AfaScanRecord, 'device' | 'report_type' | 'source_file' | 'review_required'>>;

export interface StoredReport {
  id: string;
  source_file: string;
  source_sha256: string | null;
  imported_at: string;
  ocr_text: string | null;
  extracted_record: AfaScanRecord;
  overrides: RecordOverride;
  review_required: boolean;
  schema_version: 1;
  parser_version: 1;
}

export interface BackupFile {
  format: 'afascan-tools-backup';
  version: 1;
  exported_at: string;
  reports: StoredReport[];
}
