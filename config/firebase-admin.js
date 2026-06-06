const admin = require("firebase-admin");
const path = require("path");
if (!admin.apps.length) {
  try {
    const serviceAccount = require(path.resolve(__dirname, "./serviceAccountKey.json"));
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log("Firebase Admin initialized (config)");
  } catch (e) {
    console.error("Firebase Admin DISABLED (push notifications off):", e.message);
  }
}
module.exports = admin;
