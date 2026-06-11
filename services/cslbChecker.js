'use strict';
const https = require('https');

const CSLB_HOST = 'www.cslb.ca.gov';
const SEARCH_PATH = '/OnlineServices/CheckLicenseII/CheckLicense.aspx';
const DETAIL_PATH = '/OnlineServices/CheckLicenseII/LicenseDetail.aspx';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// CSLB's LicenseDetail page requires the session cookies handed out by the
// search page; without them it 302s back to the search form.
function cslbGet(path, cookies) {
  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Referer': `https://${CSLB_HOST}${SEARCH_PATH}`,
      'Connection': 'close',
    };
    if (cookies) headers['Cookie'] = cookies;

    const req = https.get({ hostname: CSLB_HOST, path, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        location: res.headers.location || null,
        setCookie: res.headers['set-cookie'] || [],
        body,
      }));
      res.on('error', reject);
    });
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Request timed out')); });
    req.on('error', reject);
  });
}

// Visit the search page once to obtain session cookies.
async function getSessionCookies() {
  const res = await cslbGet(SEARCH_PATH);
  return res.setCookie.map((c) => c.split(';')[0]).join('; ');
}

function normalizeStatus(s) {
  const l = (s || '').toLowerCase();
  // 'inactive' must be checked before 'active'
  if (l.includes('suspend')) return 'Suspended';
  if (l.includes('revok')) return 'Revoked';
  if (l.includes('cancel')) return 'Cancelled';
  if (l.includes('expir')) return 'Expired';
  if (l.includes('delinqu')) return 'Delinquent';
  if (l.includes('inactive')) return 'Inactive';
  if (l.includes('active')) return 'Active';
  if (l.includes('pending') || l.includes('probat')) return 'Pending';
  return 'Unknown';
}

function stripTags(s) {
  return (s || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseDetailPage(html) {
  const result = { status: 'Unknown', classification: null, address: null, phone: null };
  if (!html || html.length < 100) return result;

  // Invalid / nonexistent license number
  const errMatch = html.match(/id="MainContent_ErrMsg"[^>]*>([\s\S]*?)<\/span>/i);
  if (errMatch && /does not exist|invalid|no record|not found/i.test(errMatch[1])) {
    result.status = 'Not Found';
    return result;
  }

  // The status cell, e.g. "This license is current and active."
  const statusMatch = html.match(/id="MainContent_Status"[^>]*>([\s\S]*?)<\/td>/i);
  if (statusMatch) {
    const norm = normalizeStatus(stripTags(statusMatch[1]));
    if (norm !== 'Unknown') result.status = norm;
  }

  // Business info cell: name<br>address line(s)<br>City, ST ZIP<br>Business Phone Number:(xxx) xxx-xxxx
  const busMatch = html.match(/id="MainContent_BusInfo"[^>]*>([\s\S]*?)<\/td>/i);
  if (busMatch) {
    const lines = busMatch[1]
      .split(/<br\s*\/?>/i)
      .map(stripTags)
      .filter(Boolean);
    const addressLines = [];
    for (let i = 1; i < lines.length; i++) { // line 0 is the business name
      const phoneMatch = lines[i].match(/business phone number\s*:?\s*(.*)/i);
      if (phoneMatch) {
        result.phone = phoneMatch[1].trim() || null;
      } else {
        addressLines.push(lines[i]);
      }
    }
    if (addressLines.length) result.address = addressLines.join(', ');
  }

  // Classifications cell, e.g. "C10 - ELECTRICAL" (may contain several)
  const classMatch = html.match(/id="MainContent_ClassCellTable"[^>]*>([\s\S]*?)<\/td>/i);
  if (classMatch) {
    const links = classMatch[1].match(/<a[^>]*>([\s\S]*?)<\/a>/gi);
    const classes = links && links.length
      ? links.map(stripTags).filter(Boolean)
      : [stripTags(classMatch[1])].filter(Boolean);
    if (classes.length) result.classification = classes.join(', ');
  }

  return result;
}

// Check a single CSLB license number. Reuses session cookies if provided.
async function checkLicense(licenseNumber, cookies) {
  if (!licenseNumber) return { status: 'No License #' };
  const cleaned = String(licenseNumber).replace(/[^a-zA-Z0-9]/g, '').trim();
  if (!cleaned) return { status: 'Invalid #' };

  try {
    if (!cookies) cookies = await getSessionCookies();
    let res = await cslbGet(`${DETAIL_PATH}?LicNum=${encodeURIComponent(cleaned)}`, cookies);

    // Redirected back to the search form → session expired; retry once fresh
    if (res.statusCode === 302) {
      cookies = await getSessionCookies();
      res = await cslbGet(`${DETAIL_PATH}?LicNum=${encodeURIComponent(cleaned)}`, cookies);
    }

    if (res.statusCode !== 200) return { status: 'Error', error: `HTTP ${res.statusCode}` };
    return parseDetailPage(res.body);
  } catch (err) {
    return { status: 'Error', error: err.message };
  }
}

// Check an array of contractors: [{ id, name, business_name, license_number }]
// Returns each item augmented with { cslb_status, cslb_classification, cslb_address, cslb_phone }
async function checkAllLicenses(contractors) {
  const results = [];
  let cookies = null;
  try { cookies = await getSessionCookies(); } catch { /* checkLicense will retry per-item */ }

  for (let i = 0; i < contractors.length; i++) {
    const c = contractors[i];
    const result = await checkLicense(c.license_number, cookies);
    results.push({
      ...c,
      cslb_status: result.status,
      cslb_classification: result.classification || null,
      cslb_address: result.address || null,
      cslb_phone: result.phone || null,
    });
    // Respectful delay between CSLB requests
    if (i < contractors.length - 1) await new Promise((r) => setTimeout(r, 700));
  }
  return results;
}

// Ensure license-related columns exist on the user table (safe one-time migration).
// Runs the INFORMATION_SCHEMA check only once per process.
let columnsEnsured = false;
async function ensureCslbColumns(connection) {
  if (columnsEnsured) return;
  for (const [col, def] of [
    ['license_number', 'VARCHAR(100) DEFAULT NULL'],
    ['license_state', 'VARCHAR(30) DEFAULT NULL'],
    ['address', 'TEXT DEFAULT NULL'],
    ['cslb_status', 'VARCHAR(50) DEFAULT NULL'],
    ['cslb_checked_at', 'DATETIME DEFAULT NULL'],
    ['cslb_classification', 'VARCHAR(255) DEFAULT NULL'],
    ['cslb_address', 'VARCHAR(255) DEFAULT NULL'],
    ['cslb_phone', 'VARCHAR(50) DEFAULT NULL'],
    ['spouse_name', 'VARCHAR(150) DEFAULT NULL'],
    ['spouse_email', 'VARCHAR(150) DEFAULT NULL'],
    ['spouse_phone', 'VARCHAR(50) DEFAULT NULL'],
  ]) {
    const [[row]] = await connection.query(
      `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user' AND COLUMN_NAME = ?`,
      [col]
    );
    if (!row) await connection.query(`ALTER TABLE \`user\` ADD COLUMN \`${col}\` ${def}`);
  }
  columnsEnsured = true;
}

module.exports = { checkLicense, checkAllLicenses, normalizeStatus, ensureCslbColumns };
