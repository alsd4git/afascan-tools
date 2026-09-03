import { createWorker, OEM, PSM, type LoggerMessage, type Worker } from 'tesseract.js';

const assetUrl = (path: string): string => new URL(path, document.baseURI).href;

export async function sha256(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function createOcrWorker(onProgress: (status: string, progress: number) => void): Promise<Worker> {
  let rejectWorkerError: (reason?: unknown) => void = () => undefined;
  const workerError = new Promise<never>((_, reject) => {
    rejectWorkerError = reject;
  });
  let timeoutId: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(
      () => reject(new Error('OCR engine initialization timed out. Reload the page and try again.')),
      30_000,
    );
  });

  const workerPromise = createWorker('eng', OEM.LSTM_ONLY, {
    workerPath: assetUrl('ocr/worker.min.js'),
    corePath: assetUrl('ocr/core-loader.js'),
    langPath: assetUrl('ocr/lang').replace(/\/$/, ''),
    // All worker assets are same-origin. Avoid the default Blob wrapper so the
    // core loader can resolve its split WASM binary relative to worker.min.js.
    workerBlobURL: false,
    errorHandler: (error: unknown) => {
      rejectWorkerError(error instanceof Error ? error : new Error(String(error)));
    },
    logger: (message: LoggerMessage) =>
      onProgress(message.status, typeof message.progress === 'number' ? message.progress : 0),
  });

  try {
    const worker = await Promise.race([workerPromise, workerError, timeout]);
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
    return worker;
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  }
}

export async function recognize(worker: Worker, file: File): Promise<string> {
  return (await worker.recognize(file)).data.text;
}
