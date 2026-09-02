import type { StoredReport } from './model.js';

const STORE = 'reports';
const deploymentKey = (import.meta.env.VITE_DEPLOYMENT_KEY || 'local').replace(/[^a-zA-Z0-9._-]+/g, '-');
export const DATABASE_NAME = `afascan-tools:${deploymentKey}`;

const openDb = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const request = indexedDB.open(DATABASE_NAME, 1);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(STORE)) {
      const store = db.createObjectStore(STORE, { keyPath: 'id' });
      store.createIndex('source_sha256', 'source_sha256');
      store.createIndex('report_id', 'extracted_record.report_id');
    }
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const result = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

export async function listReports(): Promise<StoredReport[]> {
  const db = await openDb();
  try {
    const reports = await result(db.transaction(STORE, 'readonly').objectStore(STORE).getAll()) as StoredReport[];
    return reports.sort((a, b) => (a.extracted_record.date || '').localeCompare(b.extracted_record.date || '') || a.source_file.localeCompare(b.source_file));
  } finally { db.close(); }
}

export async function saveReport(report: StoredReport): Promise<void> {
  const db = await openDb();
  try { await result(db.transaction(STORE, 'readwrite').objectStore(STORE).put(report)); } finally { db.close(); }
}

export async function saveReports(reports: StoredReport[]): Promise<void> {
  const db = await openDb();
  try {
    const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
    await Promise.all(reports.map((report) => result(store.put(report))));
  } finally { db.close(); }
}

export async function deleteReport(id: string): Promise<void> {
  const db = await openDb();
  try { await result(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id)); } finally { db.close(); }
}

export async function clearReports(): Promise<void> {
  const db = await openDb();
  try { await result(db.transaction(STORE, 'readwrite').objectStore(STORE).clear()); } finally { db.close(); }
}
