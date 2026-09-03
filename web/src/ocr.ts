import { createWorker, OEM, PSM, type LoggerMessage, type Worker } from 'tesseract.js';

const assetUrl = (path: string): string => new URL(path, document.baseURI).href;

type ProgressHandler = (status: string, progress: number) => void;

let cachedWorker: Worker | null = null;
let initialization: Promise<Worker> | null = null;
let progressHandler: ProgressHandler = () => undefined;

export async function sha256(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function createOcrWorker(onProgress: ProgressHandler): Promise<Worker> {
  progressHandler = onProgress;
  if (cachedWorker) return cachedWorker;
  if (initialization) return initialization;

  let rejectWorkerError: (reason?: unknown) => void = () => undefined;
  const workerError = new Promise<never>((_, reject) => {
    rejectWorkerError = reject;
  });
  let timeoutId: number | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(
      () => {
        timedOut = true;
        reject(new Error('OCR engine initialization timed out after 5 minutes. Check the connection and try again.'));
      },
      300_000,
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
      progressHandler(message.status, typeof message.progress === 'number' ? message.progress : 0),
  }).then((worker) => {
    if (timedOut) {
      void worker.terminate();
      throw new Error('OCR engine initialization timed out after 5 minutes. Check the connection and try again.');
    }
    return worker;
  });

  const pending = (async () => {
    try {
      const worker = await Promise.race([workerPromise, workerError, timeout]);
      try {
        await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
      } catch (error) {
        await worker.terminate();
        throw error;
      }
      cachedWorker = worker;
      return worker;
    } catch (error) {
      throw error;
    } finally {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    }
  })();
  initialization = pending;
  try {
    return await pending;
  } catch (error) {
    if (initialization === pending) initialization = null;
    throw error;
  }
}

export async function recognize(worker: Worker, file: File): Promise<string> {
  return (await worker.recognize(file)).data.text;
}

export async function releaseOcrWorker(): Promise<void> {
  const worker = cachedWorker;
  cachedWorker = null;
  initialization = null;
  if (worker) await worker.terminate();
}
