/* Durable per-account offline state for the Ataya web app.
   Firebase Realtime Database's web SDK does not persist its database cache across reloads. */
(function () {
    'use strict';
    const COLLECTIONS = ['beneficiaries', 'grants', 'distributionLogs'];
    const blank = () => ({ beneficiaries: {}, grants: {}, distributionLogs: {} });
    const storagePrefix = 'ataya_offline_v2_';
    const keyOf = id => String(id).replace(/[.#$\[\]\/]/g, '_');
    const read = (key, fallback) => {
        try {
            const raw = localStorage.getItem(key);
            return raw === null ? fallback : JSON.parse(raw);
        } catch (e) {
            console.warn('Offline data could not be read:', key, e);
            return fallback;
        }
    };
    const clean = item => {
        const copy = { ...item };
        delete copy._fbKey;
        return copy;
    };
    const asMap = value => {
        if (!value) return {};
        if (Array.isArray(value)) {
            return Object.fromEntries(value.map((v, i) => [String(i), v]).filter(([, v]) => !!v));
        }
        return { ...value };
    };
    const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    const store = {
        account: null,
        baseline: blank(),
        pending: blank(),
        accountKey(suffix) {
            if (!this.account) throw new Error('Offline account has not been initialized');
            return storagePrefix + this.account + '_' + suffix;
        },
        initialize(uid) {
            if (!uid) throw new Error('A verified Firebase user is required');
            if (this.account === uid) return;
            this.account = uid;
            this.baseline = read(this.accountKey('baseline'), blank());
            this.pending = read(this.accountKey('pending'), blank());
            for (const col of COLLECTIONS) {
                this.baseline[col] = asMap(this.baseline[col]);
                this.pending[col] = asMap(this.pending[col]);
            }
        },
        localData() {
            return read(this.accountKey('data'), {
                beneficiaries: [], grants: [], distributionLogs: []
            });
        },
        saveLocal(data) {
            // One atomic localStorage entry, so the three related collections stay together.
            const snapshot = {};
            for (const col of COLLECTIONS) snapshot[col] = data[col] || [];
            localStorage.setItem(this.accountKey('data'), JSON.stringify(snapshot));
        },
        stage(data) {
            // Compare against the last server snapshot, not a possibly stale onValue callback.
            for (const col of COLLECTIONS) {
                const server = this.baseline[col] || {};
                const queue = this.pending[col] || (this.pending[col] = {});
                const current = {};
                for (const item of data[col] || []) {
                    const id = item._fbKey || keyOf(item.id);
                    current[id] = clean(item);
                }
                for (const [id, item] of Object.entries(current)) {
                    if (equal(server[id], item)) delete queue[id];
                    else queue[id] = item;
                }
                for (const id of new Set([...Object.keys(server), ...Object.keys(queue)])) {
                    if (Object.prototype.hasOwnProperty.call(current, id)) continue;
                    if (Object.prototype.hasOwnProperty.call(server, id)) queue[id] = null;
                    else delete queue[id]; // A newly added record was deleted before upload.
                }
            }
            localStorage.setItem(this.accountKey('pending'), JSON.stringify(this.pending));
        },
        applyServer(root) {
            const merged = {};
            for (const col of COLLECTIONS) {
                const server = asMap(root[col]);
                this.baseline[col] = server;
                merged[col] = { ...server };
                for (const [id, item] of Object.entries(this.pending[col] || {})) {
                    if (item === null) delete merged[col][id];
                    else merged[col][id] = item;
                }
            }
            localStorage.setItem(this.accountKey('baseline'), JSON.stringify(this.baseline));
            return merged;
        },
        savePermissions(records) {
            localStorage.setItem(this.accountKey('permissions'), JSON.stringify({
                verified: true, records: records || {}
            }));
        },
        cachedPermissions() {
            return read(this.accountKey('permissions'), { verified: false, records: {} });
        },
        pendingCount() {
            return COLLECTIONS.reduce((n, col) => n + Object.keys(this.pending[col] || {}).length, 0);
        },
        nextBatch(maxEntries = 100, maxBytes = 220000) {
            // Bound each Firebase update. Large Excel imports must not be sent as
            // a single multi-megabyte patch; successful records are acknowledged per batch.
            const patch = {};
            const entries = blank();
            let count = 0, bytes = 0;
            for (const col of COLLECTIONS) {
                for (const [id, item] of Object.entries(this.pending[col] || {})) {
                    const path = col + '/' + id;
                    const size = path.length * 2 + JSON.stringify(item).length * 2;
                    if (count && (count >= maxEntries || bytes + size > maxBytes)) {
                        return {patch, entries, count};
                    }
                    entries[col][id] = item;
                    patch[path] = item;
                    count++;
                    bytes += size;
                }
            }
            return {patch, entries, count};
        },
        acknowledge(batch) {
            // Never erase a newer local edit made while this batch was being uploaded.
            for (const col of COLLECTIONS) {
                for (const [id, item] of Object.entries(batch.entries[col] || {})) {
                    if (Object.prototype.hasOwnProperty.call(this.pending[col], id) &&
                        equal(this.pending[col][id], item)) delete this.pending[col][id];
                }
            }
            localStorage.setItem(this.accountKey('pending'), JSON.stringify(this.pending));
        }
    };
    window.AtayaOffline = store;
})();