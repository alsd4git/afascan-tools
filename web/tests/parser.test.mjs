import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { extractRecord, tidyRecord } from '../.test-dist/src/parser.js';
import { recordsToCsv } from '../.test-dist/src/import-export.js';

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
test('CSV export includes segment columns', () => {
  const record = tidyRecord(extractRecord('Screenshot_20260901-090000.png','Body Composition Analysis\nWeight (kg) 81.2'));
  const csv = recordsToCsv([record]);
  assert.match(csv,/segment_fat_right_arm_kg/);
  assert.match(csv,/Screenshot_20260901-090000\.png/);
});
