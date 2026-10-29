/* Ataya durable offline store v3: IndexedDB is authoritative for large recipient lists.
   Never put beneficiary records in localStorage (small browser quotas cause silent loss).
   Old per-account v2 data and unsent edits are migrated without removing the originals. */
(function () {
    'use strict';
    const COLLECTIONS = ['beneficiaries', 'grants', 'distributionLogs'];
    const DB_NAME = 'ataya-offline-data-v3';
    const DB_VERSION = 1;
    const oldPrefix = 'ataya_offline_v2_';
    const blank = () => ({beneficiaries: {}, grants: {}, distributionLogs: {}});
    const emptyData = () => ({beneficiaries: [], grants: [], distributionLogs: []});
    const keyOf = id => String(id).replace(/[.#$\[\]\/]/g, '_');
    const clean = item => { const copy = {...item}; delete copy._fbKey; return copy; };
    const asMap = value => {
        if (!value) return {};
        if (Array.isArray(value)) return Object.fromEntries(value.map((v, i) => [String(i), v]).filter(([, v]) => !!v));
        return {...value};
    };
    const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const legacy = (key, fallback) => {
        try { const raw = localStorage.getItem(key); return raw == null ? fallback : JSON.parse(raw); }
        catch (error) { console.warn('Legacy offline data read failed:', error); return fallback; }
    };
    const requestDone = request => new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
    });
    const transactionDone = tx => new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
        tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
    function openDB() {
        if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB غير مدعوم في المتصفح'));
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains('snapshots')) db.createObjectStore('snapshots', {keyPath: 'account'});
                if (!db.objectStoreNames.contains('pending')) db.createObjectStore('pending', {keyPath: 'key'});
            };
            request.onsuccess = () => {
                const db = request.result;
                db.onversionchange = () => db.close();
                resolve(db);
            };
            request.onerror = () => reject(request.error || new Error('Could not open IndexedDB'));
            request.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
        });
    }
    const store = {
        account: null,
        db: null,
        baseline: blank(),
        pending: blank(),
        snapshot: emptyData(),
        writeChain: Promise.resolve(),
        accountKey(suffix) { return oldPrefix + this.account + '_' + suffix; },
        entryKey(col, id) { return this.account + ':' + col + ':' + id; },
        enqueue(operation) {
            const run = this.writeChain.then(operation);
            this.writeChain = run.catch(error => console.warn('Offline transaction error:', error));
            return run;
        },
        async initialize(uid) {
            if (!uid) throw new Error('Firebase user is required');
            if (this.account === uid && this.db) return;
            if (this.db) this.db.close();
            this.account = uid;
            this.db = await openDB();
            const tx = this.db.transaction(['snapshots', 'pending'], 'readonly');
            const snapReq = tx.objectStore('snapshots').get(uid);
            const pendingReq = tx.objectStore('pending').getAll(IDBKeyRange.bound(uid + ':', uid + ':\uffff'));
            const complete = transactionDone(tx);
            const [snapshotRow, pendingRows] = await Promise.all([requestDone(snapReq), requestDone(pendingReq), complete]).then(([a, b]) => [a, b]);
            if (!snapshotRow) {
                // Migration is atomic; retain v2 keys as an emergency backup.
                const oldData = legacy(this.accountKey('data'), emptyData());
                const oldPending = legacy(this.accountKey('pending'), blank());
                const oldBaseline = legacy(this.accountKey('baseline'), blank());
                this.baseline = Object.fromEntries(COLLECTIONS.map(c => [c, asMap(oldBaseline[c])]));
                const migration = this.db.transaction(['snapshots', 'pending'], 'readwrite');
                migration.objectStore('snapshots').put({account: uid, data: oldData});
                const pStore = migration.objectStore('pending');
                for (const col of COLLECTIONS) {
                    for (const [id, item] of Object.entries(asMap(oldPending[col]))) {
                        pStore.put({key: this.entryKey(col, id), col, id, item});
                    }
                }
                await transactionDone(migration);
                this.snapshot = oldData;
                this.pending = Object.fromEntries(COLLECTIONS.map(c => [c, asMap(oldPending[c])]));
            } else {
                this.snapshot = snapshotRow.data || emptyData();
                this.baseline = blank();
                this.pending = blank();
                for (const row of pendingRows) if (this.pending[row.col]) this.pending[row.col][row.id] = row.item;
            }
            // Ensure a previously interrupted migration cannot overwrite a valid v3 snapshot.
            if (!Array.isArray(this.snapshot.beneficiaries)) this.snapshot = emptyData();
        },
        localData() { return this.snapshot || emptyData(); },
        async saveLocal(data) {
            const account = this.account;
            return this.enqueue(async () => {
                if (!this.db || !account) throw new Error('Offline store has not been initialized');
                const snapshot = Object.fromEntries(COLLECTIONS.map(col => [col, data[col] || []]));
                const tx = this.db.transaction('snapshots', 'readwrite');
                tx.objectStore('snapshots').put({account, data: snapshot});
                await transactionDone(tx);
                this.snapshot = snapshot;
            });
        },
        async saveAndStage(data) {
            const account = this.account;
            // Prepare the complete diff without changing memory. A failed quota/transaction
            // leaves both the snapshot and the queued changes untouched.
            return this.enqueue(async () => {
                if (!this.db || !account) throw new Error('Offline store has not been initialized');
                const snapshot = Object.fromEntries(COLLECTIONS.map(col => [col, data[col] || []]));
                const nextPending = blank();
                for (const col of COLLECTIONS) {
                    const current = {};
                    for (const item of snapshot[col]) {
                        const id = String(item._fbKey || keyOf(item.id));
                        current[id] = clean(item);
                    }
                    const server = this.baseline[col] || {};
                    for (const [id, item] of Object.entries(current)) {
                        if (!equal(server[id], item)) nextPending[col][id] = item;
                    }
                    for (const id of new Set([...Object.keys(server), ...Object.keys(this.pending[col] || {})])) {
                        if (Object.prototype.hasOwnProperty.call(current, id)) continue;
                        if (Object.prototype.hasOwnProperty.call(server, id)) nextPending[col][id] = null;
                    }
                }
                const tx = this.db.transaction(['snapshots', 'pending'], 'readwrite');
                tx.objectStore('snapshots').put({account, data: snapshot});
                const pStore = tx.objectStore('pending');
                const wanted = new Set();
                for (const col of COLLECTIONS) {
                    for (const [id, item] of Object.entries(nextPending[col])) {
                        const key = this.entryKey(col, id);
                        wanted.add(key);
                        pStore.put({key, col, id, item});
                    }
                }
                // Both writes and acknowledgements use the same serialized queue.
                // No asynchronous request may make this transaction inactive mid-write.
                for (const col of COLLECTIONS) {
                    for (const id of Object.keys(this.pending[col] || {})) {
                        const key = this.entryKey(col, id);
                        if (!wanted.has(key)) pStore.delete(key);
                    }
                }
                await transactionDone(tx);
                this.snapshot = snapshot;
                this.pending = nextPending;
                return this.pendingCount();
            });
        },
        async stage(data) { return this.saveAndStage(data); },
        applyServer(root) {
            const merged = {};
            for (const col of COLLECTIONS) {
                const server = asMap(root[col]);
                this.baseline[col] = server;
                merged[col] = {...server};
                for (const [id, item] of Object.entries(this.pending[col] || {})) {
                    if (item === null) delete merged[col][id];
                    else merged[col][id] = item;
                }
            }
            return merged;
        },
        savePermissions(records) {
            try { localStorage.setItem(this.accountKey('permissions'), JSON.stringify({verified: true, records: records || {}})); }
            catch (error) { console.warn('Offline permission cache full:', error); }
        },
        cachedPermissions() { return legacy(this.accountKey('permissions'), {verified: false, records: {}}); },
        pendingCount() { return COLLECTIONS.reduce((n, col) => n + Object.keys(this.pending[col] || {}).length, 0); },
        nextBatch(maxEntries = 100, maxBytes = 220000) {
            const patch = {}, entries = blank();
            let count = 0, bytes = 0;
            for (const col of COLLECTIONS) {
                for (const [id, item] of Object.entries(this.pending[col] || {})) {
                    const path = col + '/' + id;
                    const size = path.length * 2 + JSON.stringify(item).length * 2;
                    if (count && (count >= maxEntries || bytes + size > maxBytes)) return {patch, entries, count};
                    entries[col][id] = item; patch[path] = item; count++; bytes += size;
                }
            }
            return {patch, entries, count};
        },
        async acknowledge(batch) {
            return this.enqueue(async () => {
                const tx = this.db.transaction('pending', 'readwrite');
                const pStore = tx.objectStore('pending');
                const removed = [];
                for (const col of COLLECTIONS) {
                    for (const [id, item] of Object.entries(batch.entries[col] || {})) {
                        // The write queue guarantees disk and memory cannot change
                        // concurrently. Only delete the exact version that was uploaded.
                        if (!Object.prototype.hasOwnProperty.call(this.pending[col], id) ||
                            !equal(this.pending[col][id], item)) continue;
                        pStore.delete(this.entryKey(col, id));
                        removed.push([col, id, item]);
                    }
                }
                await transactionDone(tx);
                for (const [col, id, item] of removed) {
                    if (Object.prototype.hasOwnProperty.call(this.pending[col], id) &&
                        equal(this.pending[col][id], item)) delete this.pending[col][id];
                }
            });
        }
    };
    window.AtayaOffline = store;
})();