import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { extractOcrRecord, extractRecord, tidyRecord } from '../.test-dist/src/parser.js';
import { parseImport, recordsToCsv } from '../.test-dist/src/import-export.js';

const cases = [['standard-report','Screenshot_20260830-101500.png'],['noisy-report','Screenshot_20260831-113000.png'],['incomplete-report','Screenshot_20260901-090000.png']];
for (const [fixture, sourceFile] of cases) test(`parser parity fixture: ${fixture}`, () => {
  const root = resolve('..','tests','fixtures');
  const text = readFileSync(resolve(root,`${fixture}.txt`),'utf8');
  const expected = JSON.parse(readFileSync(resolve(root,`${fixture}.expected.json`),'utf8'));
  assert.deepEqual(extractRecord(sourceFile,text), expected);
});
test('incomplete report is marked for review', () => {
  const text = readFileSync(resolve('..','tests','fixtures','incomplete-report.txt'),'utf8');
  assert.equal(tidyRecord(extractRecord('Screenshot_20260901-090000.png',text)).review_required,true);
});
test('parser tolerates common OCR label separators', () => {
  const text = `Body Composition Analysis
BasalMetabolicRate 1693
Water Percent) = 51.0%
Body Composition Analysis | AfaScan
100% 72.7% 3.7% 23.6% | 68 100
Skeletal Muscle Mass (kg) 70 100 37.6
BMI m 26.3`;
  const record = extractRecord('Screenshot_20260612-173147.png', text);
  assert.equal(record.basal_metabolic_rate_kcal, 1693);
  assert.equal(record.water_percent, 51);
  assert.equal(record.score, 68);
  assert.equal(record.skeletal_muscle_mass_kg, 37.6);
  assert.equal(record.bmi, 26.3);
});
test('profile header supports different heights, ages and genders', () => {
  const record = extractRecord('Screenshot_20260910-101500.png', '20260910101500 164 47 Female 2026-09-10 10:15:00');
  assert.equal(record.height_cm, 164);
  assert.equal(record.gender, 'Female');
});
test('supplementary OCR only fills values missing from primary OCR', () => {
  const primary = `Body Composition Analysis
BMI (kg/m2)
26.3
Water Percent`;
  const supplementary = `BMI (kg/m2)
99.9
Water Percent 51.0%`;
  const record = extractOcrRecord('Screenshot_20260910-101500.png', primary, [supplementary]);
  assert.equal(record.bmi, 26.3);
  assert.equal(record.water_percent, 51);
});
test('CSV export includes segment columns', () => {
  const record = tidyRecord(extractRecord('Screenshot_20260901-090000.png','Body Composition Analysis\nWeight (kg) 81.2'));
  const csv = recordsToCsv([record]);
  assert.match(csv,/segment_fat_right_arm_kg/);
  assert.match(csv,/Screenshot_20260901-090000\.png/);
});
test('JSON import rejects malformed records before persistence', () => {
  const malicious = [{ source_file: 'test.png', date: '<img src=x onerror=alert(1)>' }];
  assert.throws(() => parseImport(JSON.stringify(malicious)), /Not a compatible/);
});
test('backup import rejects unknown override fields', () => {
  const record = tidyRecord(extractRecord('Screenshot_20260910-101500.png', 'Body Composition Analysis'));
  const backup = {
    format: 'afascan-tools-backup', version: 1, exported_at: new Date().toISOString(), reports: [{
      id: 'untrusted-id', source_file: record.source_file, source_sha256: null,
      imported_at: new Date().toISOString(), ocr_text: null, extracted_record: record,
      overrides: { source_file: 'other.png' }, review_required: Boolean(record.review_required),
      schema_version: 1, parser_version: 1,
    }],
  };
  assert.throws(() => parseImport(JSON.stringify(backup)), /Unsupported AfaScan backup/);
});
test('backup import regenerates internal ids', () => {
  const record = tidyRecord(extractRecord('Screenshot_20260910-101500.png', 'Body Composition Analysis'));
  const backup = {
    format: 'afascan-tools-backup', version: 1, exported_at: new Date().toISOString(), reports: [{
      id: 'untrusted-id', source_file: record.source_file, source_sha256: null,
      imported_at: new Date().toISOString(), ocr_text: null, extracted_record: record,
      overrides: {}, review_required: Boolean(record.review_required), schema_version: 1, parser_version: 1,
    }],
  };
  const [imported] = parseImport(JSON.stringify(backup));
  assert.notEqual(imported.id, 'untrusted-id');
  assert.match(imported.id, /^[0-9a-f-]{36}$/i);
});
