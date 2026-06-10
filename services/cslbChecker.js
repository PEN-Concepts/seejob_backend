'use strict';
const https = require('https');
const http = require('http');

const CSLB_HOST = 'www.cslb.ca.gov';
const CSLB_PATH = '/OnlineServices/CheckLicenseII/checklicense.aspx';

// Fetches a URL following redirects, returns { statusCode, body }
function fetchWithRedirects(startUrl, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    function doRequest(url, redirectsLeft) {
      let parsed;
      try { parsed = new URL(url); } catch { return reject(new Error(`Invalid URL: ${url}`)); }

      const isHttp = parsed.protocol === 'http:';
      const client = isHttp ? http : https;
      const opts = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttp ? 80 : 443),
        path: parsed.pathname + (parsed.search || ''),
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Connection': 'close',
        },
      };

      const req = client.request(opts, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
          res.resume();
          try {
            const next = new URL(res.headers.location, url);
            doRequest(next.toString(), redirectsLeft - 1);
          } catch { reject(new Error('Bad redirect URL')); }
          return;
        }
        const chunks = [];
        res.setEncoding('utf8');
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ statusCode: res.statusCode, body: chunks.join('') }));
        res.on('error', reject);
      });

      req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timed out')); });
      req.on('error', reject);
      req.end();
    }
    doRequest(startUrl, maxRedirects);
  });
}

function normalizeStatus(s) {
  const l = (s || '').toLowerCase().trim();
  if (l === 'active') return 'Active';
  if (l.startsWith('expir')) return 'Expired';
  if (l.startsWith('suspend')) return 'Suspended';
  if (l.startsWith('revok')) return 'Revoked';
  if (l.startsWith('cancel')) return 'Cancelled';
  if (l.startsWith('delinqu')) return 'Delinquent';
  if (l.startsWith('pending') || l.startsWith('probat')) return 'Pending';
  return s ? (s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()) : 'Unknown';
}

function parseCSLBStatus(html) {
  if (!html || html.length < 100) return 'Unknown';
  const lower = html.toLowerCase();

  // Not found
  if (lower.includes('no contractor') || lower.includes('not found') ||
      lower.includes('no record') || lower.includes('enter a valid') ||
      lower.includes('invalid license')) return 'Not Found';

  // Try structured extraction first (more reliable)
  const patterns = [
    /status[:\s]*(?:<[^>]+>)+\s*([A-Za-z][A-Za-z\s]{1,30}?)(?:\s*<|\s*&)/i,
    />\s*(active|expir\w*|suspend\w*|revok\w*|cancel\w*|delinquent|pending|probat\w*)\s*</i,
    /class="[^"]*status[^"]*"[^>]*>\s*([^<]{2,30})<\//i,
  ];
  for (const pattern of patterns) {
    const m = html.match(pattern);
    if (m) {
      const norm = normalizeStatus(m[1].trim());
      if (norm !== 'Unknown') return norm;
    }
  }

  // Keyword scan fallback
  for (const kw of ['active', 'expired', 'suspended', 'revoked', 'cancelled', 'delinquent', 'pending']) {
    if (lower.includes(kw)) return normalizeStatus(kw);
  }

  return 'Unknown';
}

// Check a single CSLB license number
async function checkLicense(licenseNumber) {
  if (!licenseNumber) return { status: 'No License #' };
  const cleaned = String(licenseNumber).replace(/[^a-zA-Z0-9]/g, '').trim();
  if (!cleaned) return { status: 'Invalid #' };

  try {
    const url = `https://${CSLB_HOST}${CSLB_PATH}?LicNum=${encodeURIComponent(cleaned)}`;
    const { statusCode, body } = await fetchWithRedirects(url);
    if (statusCode !== 200) return { status: 'Error', error: `HTTP ${statusCode}` };
    return { status: parseCSLBStatus(body) };
  } catch (err) {
    return { status: 'Error', error: err.message };
  }
}

// Check an array of contractors: [{ id, name, business_name, license_number }]
// Returns each item augmented with { cslb_status }
async function checkAllLicenses(contractors) {
  const results = [];
  for (let i = 0; i < contractors.length; i++) {
    const c = contractors[i];
    const result = await checkLicense(c.license_number);
    results.push({ ...c, cslb_status: result.status });
    // Respectful delay between CSLB requests
    if (i < contractors.length - 1) await new Promise(r => setTimeout(r, 700));
  }
  return results;
}

module.exports = { checkLicense, checkAllLicenses, normalizeStatus };
