/* Ataya account provisioning helper (Spark plan).
   This file does not grant administrator privileges by itself.
   Realtime Database security rules MUST authorize permission writes server-side.
   No passwords are written to the database.
*/
import { initializeApp, getApp, getApps } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
    getAuth, setPersistence, inMemoryPersistence, signOut,
    createUserWithEmailAndPassword, deleteUser
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { ref, update } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js';

const name = 'ataya-provisioning-isolated';

function secondaryAuth(firebaseConfig) {
    const app = getApps().some(app => app.name === name)
        ? getApp(name)
        : initializeApp(firebaseConfig, name);
    return getAuth(app);
}

/**
 * Called only from an admin-verified UI with a current primary Firebase Auth session.
 * Firebase RTDB rules must independently enforce that only existing administrators
 * can write atp_v2/permissions.
 *
 * @param {object} options {firebaseConfig, auth, db, email, password, record,
 *                           key, root='atp_v2', otherUpdates={}}
 * @returns {Promise<string>} Firebase Auth UID of the new account.
 */
export async function createAtayaUser(options) {
    const { firebaseConfig, auth, db, email, password, record, key,
            root = 'atp_v2', otherUpdates = {} } = options;
    if (!auth?.currentUser) throw new Error('سجّل الدخول بحساب المدير أولًا.');
    if (!email || !key || !record || record.email !== email)
        throw new Error('بيانات حساب المستخدم غير مكتملة.');
    if (typeof password !== 'string' || password.length < 8)
        throw new Error('كلمة المرور يجب ألا تقل عن ثمانية أحرف.');
    const adminUid = auth.currentUser.uid;
    const other = secondaryAuth(firebaseConfig);
    let created = null;
    try {
        await setPersistence(other, inMemoryPersistence);
        if (other.currentUser) await signOut(other);
        created = await createUserWithEmailAndPassword(other, email, password);
        // Confirm account creation did not replace the main administrator session.
        if (auth.currentUser?.uid !== adminUid)
            throw new Error('تغيرت جلسة المدير أثناء إنشاء الحساب. أُلغيت العملية.');
        const updateData = { ...otherUpdates };
        updateData['permissions/' + key] = { ...record, email, uid: created.user.uid };
        // These rules must be protected by Firebase, not just by frontend checks.
        await update(ref(db, root), updateData);
        return created.user.uid;
    } catch (error) {
        if (created?.user) {
            try {
                await deleteUser(created.user);
            } catch (rollbackError) {
                error.accountMayExistWithoutPermissions = true;
                console.error('Unable to roll back unlinked Firebase Auth user', rollbackError);
            }
        }
        throw error;
    } finally {
        if (other.currentUser) {
            try { await signOut(other); }
            catch (error) { console.warn('Secondary auth session cleanup failed', error); }
        }
    }
}
