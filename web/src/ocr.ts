import { createWorker, OEM, PSM, type LoggerMessage, type Worker } from 'tesseract.js';

const assetUrl = (path: string): string => new URL(path, document.baseURI).href;

export async function sha256(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function createOcrWorker(onProgress: (status: string, progress: number) => void): Promise<Worker> {
  const worker = await createWorker('eng', OEM.LSTM_ONLY, {
    workerPath: assetUrl('ocr/worker.min.js'),
    corePath: assetUrl('ocr/core').replace(/\/$/, ''),
    langPath: assetUrl('ocr/lang').replace(/\/$/, ''),
    logger: (message: LoggerMessage) => onProgress(message.status, typeof message.progress === 'number' ? message.progress : 0),
  });
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
  return worker;
}

export async function recognize(worker: Worker, file: File): Promise<string> {
  return (await worker.recognize(file)).data.text;
}
