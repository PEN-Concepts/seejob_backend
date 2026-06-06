const admin = require('firebase-admin');
if (!admin.apps.length) {
  try {
    const p = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
    if (!p) throw new Error('FIREBASE_SERVICE_ACCOUNT_PATH not set');
    admin.initializeApp({ credential: admin.credential.cert(require(p)) });
    console.log('Firebase Admin initialized');
  } catch (e) {
    console.error('Firebase Admin DISABLED (push notifications off):', e.message);
  }
}
module.exports = admin;