import { createWorker, OEM, PSM, type LoggerMessage, type Worker } from 'tesseract.js';

const assetUrl = (path: string): string => new URL(path, document.baseURI).href;

type ProgressHandler = (status: string, progress: number) => void;
type Rectangle = { left: number; top: number; width: number; height: number };
type CropBounds = { top: number; bottom: number };

let cachedWorker: Worker | null = null;
let initialization: Promise<Worker> | null = null;
let progressHandler: ProgressHandler = () => undefined;

/** Find a large bright report area surrounded by dark screenshot bands. */
export function detectReportCrop(data: Uint8ClampedArray, width: number, height: number): CropBounds | null {
  if (width < 100 || height < 100 || data.length < width * height * 4) return null;
  const brightCoverage: number[] = [];
  const sampleStep = Math.max(1, Math.floor(width / 360));
  for (let y = 0; y < height; y += 1) {
    let bright = 0;
    let samples = 0;
    for (let x = 0; x < width; x += sampleStep) {
      const offset = (y * width + x) * 4;
      if (Math.max(data[offset], data[offset + 1], data[offset + 2]) > 32) bright += 1;
      samples += 1;
    }
    brightCoverage.push(bright / samples);
  }

  const hasReportContent = (row: number): boolean => brightCoverage[row] >= 0.2;
  const runLength = 8;
  let top = -1;
  for (let row = 0; row <= height - runLength; row += 1) {
    if (hasReportContent(row) && hasReportContent(row + runLength - 1)) {
      top = row;
      break;
    }
  }
  let bottom = -1;
  for (let row = height - 1; row >= runLength - 1; row -= 1) {
    if (hasReportContent(row) && hasReportContent(row - runLength + 1)) {
      bottom = row + 1;
      break;
    }
  }
  if (top < 8 || bottom < 0 || bottom - top < height * 0.5) return null;

  const topPadding = Math.min(4, top);
  const bottomPadding = Math.min(4, height - bottom);
  const crop: CropBounds = { top: top - topPadding, bottom: bottom + bottomPadding };
  return crop.bottom - crop.top < height - 16 ? crop : null;
}

async function prepareOcrImage(file: File): Promise<Blob | File> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return file;
    context.drawImage(bitmap, 0, 0);
    const crop = detectReportCrop(context.getImageData(0, 0, bitmap.width, bitmap.height).data, bitmap.width, bitmap.height);
    if (!crop) return file;

    canvas.width = bitmap.width;
    canvas.height = crop.bottom - crop.top;
    context.drawImage(bitmap, 0, crop.top, bitmap.width, canvas.height, 0, 0, bitmap.width, canvas.height);
    const cropped = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    return cropped ?? file;
  } finally {
    bitmap.close();
  }
}

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
  const source = await prepareOcrImage(file);
  const primary = (await worker.recognize(source)).data.text;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(source);
  } catch {
    return primary;
  }

  // AfaScan reports are tall screenshots with two columns. The full-page
  // single-block pass is best for the header and composition values, while
  // sparse text on targeted regions recovers labels such as BMI and visceral
  // fat that otherwise get mixed with chart ticks.
  const isReportLayout = bitmap.width >= 700 && bitmap.height / bitmap.width >= 1.2;
  if (!isReportLayout) {
    bitmap.close();
    return primary;
  }
  const rectangles: Rectangle[] = [
    {
      left: 0,
      top: Math.round(bitmap.height * 0.39),
      width: Math.round(bitmap.width * 0.66),
      height: Math.round(bitmap.height * 0.16),
    },
    {
      left: Math.round(bitmap.width * 0.64),
      top: Math.round(bitmap.height * 0.14),
      width: Math.round(bitmap.width * 0.36),
      height: Math.round(bitmap.height * 0.72),
    },
  ];
  const supplementary: string[] = [];
  try {
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
    for (const rectangle of rectangles) {
      supplementary.push((await worker.recognize(source, { rectangle })).data.text);
    }
  } catch {
    return primary;
  } finally {
    try {
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
    } finally {
      bitmap.close();
    }
  }
  return `${supplementary.join('\n')}\n${primary}`;
}

export async function releaseOcrWorker(): Promise<void> {
  const worker = cachedWorker;
  cachedWorker = null;
  initialization = null;
  if (worker) await worker.terminate();
}
