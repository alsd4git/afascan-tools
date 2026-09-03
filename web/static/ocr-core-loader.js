(() => {
  const supports = (bytes) => typeof WebAssembly === 'object' && WebAssembly.validate(new Uint8Array(bytes));

  // Same feature probes used by Tesseract.js. We keep the selection local but
  // load the much smaller glue JS + binary WASM pair instead of the ~4 MB
  // base64-packed *.wasm.js file through importScripts().
  const relaxedSimd = supports([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0,
    10, 15, 1, 13, 0, 65, 1, 253, 15, 65, 2, 253, 15, 253, 128, 2, 11,
  ]);
  const simd = supports([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0,
    10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
  ]);

  const variant = relaxedSimd
    ? 'tesseract-core-relaxedsimd-lstm'
    : simd
      ? 'tesseract-core-simd-lstm'
      : 'tesseract-core-lstm';

  // workerBlobURL is disabled by the app, therefore self.location is the
  // self-hosted /ocr/worker.min.js URL and gives us a stable same-origin base.
  const coreBase = new URL('core/', self.location.href).href;
  importScripts(`${coreBase}${variant}.js`);

  const selectedCore = self.TesseractCore;
  if (typeof selectedCore !== 'function') {
    throw new Error(`Unable to load ${variant}`);
  }

  self.TesseractCore = (options = {}) => selectedCore({
    ...options,
    locateFile: (path) => new URL(path, coreBase).href,
  });
})();
