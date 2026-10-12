/** Local browser IndexedDB persistence. No BDUSS stored here. */
const DB_NAME = "eztb-date-replies-v1";
const STORE = "entries";
const DB_VERSION = 1;

let opening: Promise<IDBDatabase> | undefined;

function openDb(): Promise<IDBDatabase> {
	if (opening) return opening;
	opening = new Promise((resolve, reject) => {
		if (!("indexedDB" in window))
			return reject(new Error("浏览器不支持 IndexedDB"));
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = () => {
			if (!req.result.objectStoreNames.contains(STORE))
				req.result.createObjectStore(STORE);
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error || new Error("IndexedDB 打开失败"));
	});
	return opening;
}

export async function cacheGet<T>(key: string): Promise<T | undefined> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
		req.onsuccess = () => resolve(req.result as T | undefined);
		req.onerror = () => reject(req.error);
	});
}

export async function cachePut<T>(key: string, value: T): Promise<void> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE, "readwrite");
		tx.objectStore(STORE).put(value, key);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error);
	});
}

export async function cachePutMany<T>(
	entries: Array<{ key: string; value: T }>,
): Promise<void> {
	if (entries.length === 0) return;
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE, "readwrite");
		const store = tx.objectStore(STORE);
		for (const entry of entries) store.put(entry.value, entry.key);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error);
	});
}

export async function cacheEntriesPrefix<T>(
	prefix: string,
): Promise<Array<{ key: string; value: T }>> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const entries: Array<{ key: string; value: T }> = [];
		const tx = db.transaction(STORE, "readonly");
		const request = tx
			.objectStore(STORE)
			.openCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
		request.onsuccess = () => {
			const cursor = request.result;
			if (cursor) {
				entries.push({ key: String(cursor.key), value: cursor.value as T });
				cursor.continue();
			}
		};
		tx.oncomplete = () => resolve(entries);
		tx.onerror = () => reject(tx.error);
	});
}

export async function cacheDeletePrefix(prefix: string): Promise<number> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		let count = 0;
		const tx = db.transaction(STORE, "readwrite");
		const store = tx.objectStore(STORE);
		const req = store.openCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
		req.onsuccess = () => {
			const cursor = req.result;
			if (cursor) {
				cursor.delete();
				count++;
				cursor.continue();
			}
		};
		tx.oncomplete = () => resolve(count);
		tx.onerror = () => reject(tx.error);
	});
}
