const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const pool = require("../config/connection");
const auth = require("../services/authentication");
const logger = require("../common/logger");

// Brand name that must NEVER be translated. We swap it for a token DeepL leaves
// alone, then restore it after translation.
const BRAND = "See Job Run";
const BRAND_TOKEN = "SJRBRAND";

// DeepL target codes. Reader's app language ('en'|'es') -> DeepL target.
const TARGET_MAP = { en: "EN-US", es: "ES" };

let columnsEnsured = false;
async function ensureTable(connection) {
  if (columnsEnsured) return;
  await connection.query(
    `CREATE TABLE IF NOT EXISTS translations (
       id INT AUTO_INCREMENT PRIMARY KEY,
       source_hash CHAR(64) NOT NULL,
       target_lang VARCHAR(8) NOT NULL,
       source_text MEDIUMTEXT,
       translated_text MEDIUMTEXT,
       created_at DATETIME NOT NULL,
       UNIQUE KEY uq_src_lang (source_hash, target_lang)
     )`
  );
  columnsEnsured = true;
}

const hash = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const protectBrand = (s) => s.split(BRAND).join(BRAND_TOKEN);
const restoreBrand = (s) => s.split(BRAND_TOKEN).join(BRAND);

function deeplEndpoint(key) {
  // Free-tier keys end with ":fx".
  return key.trim().endsWith(":fx")
    ? "https://api-free.deepl.com/v2/translate"
    : "https://api.deepl.com/v2/translate";
}

/** Call DeepL for a batch of texts -> one target language. Returns string[]. */
async function deeplTranslate(texts, targetLang) {
  const key = process.env.DEEPL_API_KEY;
  if (!key) throw new Error("DEEPL_API_KEY not configured");

  const params = new URLSearchParams();
  texts.forEach((t) => params.append("text", protectBrand(t)));
  params.append("target_lang", targetLang);
  params.append("preserve_formatting", "1");

  const res = await fetch(deeplEndpoint(key), {
    method: "POST",
    headers: {
      Authorization: `DeepL-Auth-Key ${key.trim()}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`DeepL ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data.translations || []).map((t) => restoreBrand(t.text || ""));
}

/**
 * POST /translate  { texts: string[], target: 'en'|'es' }
 * Returns { translations: string[] } in the same order. Cached per (text,lang)
 * so each unique phrase is only sent to DeepL once. Fails soft: on any error a
 * text falls back to its original (so the app never shows blanks).
 */
router.post("/", auth.authenticateToken, async (req, res) => {
  const target = String(req.body?.target || "").toLowerCase();
  const texts = Array.isArray(req.body?.texts) ? req.body.texts : [];
  const targetLang = TARGET_MAP[target];

  if (!targetLang) return res.json({ translations: texts });
  if (!texts.length) return res.json({ translations: [] });

  let connection;
  try {
    connection = await pool.getConnection();
    await ensureTable(connection);

    const result = new Array(texts.length);
    const missIdx = [];
    const missTexts = [];

    // 1) Cache lookup
    for (let i = 0; i < texts.length; i++) {
      const text = String(texts[i] ?? "");
      if (!text.trim()) { result[i] = text; continue; }
      const [rows] = await connection.query(
        "SELECT translated_text FROM translations WHERE source_hash = ? AND target_lang = ? LIMIT 1",
        [hash(text), targetLang]
      );
      if (rows.length) result[i] = rows[0].translated_text;
      else { missIdx.push(i); missTexts.push(text); }
    }

    // 2) Translate the misses (one DeepL batch) + cache them
    if (missTexts.length) {
      let translated;
      try {
        translated = await deeplTranslate(missTexts, targetLang);
      } catch (e) {
        logger.error("DeepL translate error: " + e.message);
        translated = missTexts; // fail soft -> originals
      }
      const now = new Date().toISOString().slice(0, 19).replace("T", " ");
      for (let j = 0; j < missIdx.length; j++) {
        const src = missTexts[j];
        const out = translated[j] ?? src;
        result[missIdx[j]] = out;
        if (out !== src) {
          try {
            await connection.query(
              "INSERT IGNORE INTO translations (source_hash, target_lang, source_text, translated_text, created_at) VALUES (?, ?, ?, ?, ?)",
              [hash(src), targetLang, src, out, now]
            );
          } catch (_) { /* ignore cache write races */ }
        }
      }
    }

    res.json({ translations: result });
  } catch (err) {
    logger.error("translate route error: " + err.message);
    res.json({ translations: texts }); // never break the UI
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;
