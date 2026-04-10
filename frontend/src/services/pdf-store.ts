const DB_NAME = "maxcavator-files";
const PDF_STORE_NAME = "pdfs";
const ASSET_STORE_NAME = "context_assets";
const DB_VERSION = 2;

function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(PDF_STORE_NAME)) {
                db.createObjectStore(PDF_STORE_NAME);
            }
            if (!db.objectStoreNames.contains(ASSET_STORE_NAME)) {
                db.createObjectStore(ASSET_STORE_NAME);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

export const pdfStore = {
    async savePdf(docId: string, file: File): Promise<void> {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(PDF_STORE_NAME, "readwrite");
            tx.objectStore(PDF_STORE_NAME).put(
                { blob: file, name: file.name, type: file.type },
                docId
            );
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    },

    async getPdf(docId: string): Promise<File | null> {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(PDF_STORE_NAME, "readonly");
            const request = tx.objectStore(PDF_STORE_NAME).get(docId);
            request.onsuccess = () => {
                const result = request.result;
                if (!result) return resolve(null);
                const file = new File([result.blob], result.name, { type: result.type });
                resolve(file);
            };
            request.onerror = () => reject(request.error);
        });
    },

    async deletePdf(docId: string): Promise<void> {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(PDF_STORE_NAME, "readwrite");
            tx.objectStore(PDF_STORE_NAME).delete(docId);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    },

    async saveAsset(assetId: string, blob: Blob, meta?: { name?: string; type?: string }): Promise<void> {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(ASSET_STORE_NAME, "readwrite");
            tx.objectStore(ASSET_STORE_NAME).put(
                {
                    blob,
                    name: meta?.name || assetId,
                    type: meta?.type || blob.type || "application/octet-stream"
                },
                assetId
            );
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    },

    async getAsset(assetId: string): Promise<File | null> {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(ASSET_STORE_NAME, "readonly");
            const request = tx.objectStore(ASSET_STORE_NAME).get(assetId);
            request.onsuccess = () => {
                const result = request.result;
                if (!result) return resolve(null);
                resolve(new File([result.blob], result.name || assetId, { type: result.type || "application/octet-stream" }));
            };
            request.onerror = () => reject(request.error);
        });
    },

    async deleteAsset(assetId: string): Promise<void> {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(ASSET_STORE_NAME, "readwrite");
            tx.objectStore(ASSET_STORE_NAME).delete(assetId);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    },
};
