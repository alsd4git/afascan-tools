import assert from 'node:assert/strict';
import test from 'node:test';
import { detectReportCrop } from '../.test-dist/src/ocr.js';

function image(width, height, top, bottom) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = top; y < bottom; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      data[offset] = 255;
      data[offset + 1] = 255;
      data[offset + 2] = 255;
      data[offset + 3] = 255;
    }
  }
  return data;
}

test('detects large dark bands around a report', () => {
  assert.deepEqual(detectReportCrop(image(100, 100, 20, 80), 100, 100), { top: 16, bottom: 84 });
});

test('does not crop an image without meaningful outer bands', () => {
  assert.equal(detectReportCrop(image(100, 100, 4, 96), 100, 100), null);
});
