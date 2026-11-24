// Sends a 6-digit WhatsApp OTP through an AiSensy API campaign (authentication template).
// Stateless: returns a signed token (expiry + HMAC of phone|code|expiry); /api/lead checks the code against it.
// Env: AISENSY_API_KEY, AISENSY_OTP_CAMPAIGN (API campaign name), OTP_SECRET (long random string).

const crypto = require('crypto');
const KEY = process.env.AISENSY_API_KEY;
const CAMPAIGN = process.env.AISENSY_OTP_CAMPAIGN || 'website_otp';
// Signing key: OTP_SECRET if set, otherwise derived from the TeleCRM token so no extra secret is needed.
const SECRET = process.env.OTP_SECRET || (process.env.TELECRM_SYNC_TOKEN && require('crypto').createHash('sha256').update('the-district-otp|' + process.env.TELECRM_SYNC_TOKEN).digest('hex'));
const ALLOWED = /^https:\/\/((new|www)\.)?thedistrictbynavilu\.com$|^https:\/\/the-district-site[a-z0-9-]*\.vercel\.app$/;
const TTL_MS = 10 * 60 * 1000;

function normalisePhone(input) {
  if (typeof input !== 'string') return null;
  const raw = input.trim(), plus = raw.startsWith('+');
  let d = raw.replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);
  else if (!plus && d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10) return /^[6-9]/.test(d) ? '91' + d : null;
  if (d.length === 12 && d.startsWith('91')) return /^91[6-9]/.test(d) ? d : null;
  if ((plus || raw.replace(/\D/g, '').startsWith('00')) && d.length >= 8 && d.length <= 15) return d;
  return null;
}

module.exports = async (req, res) => {
  const origin = req.headers.origin || '';
  if (ALLOWED.test(origin)) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  if (origin && !ALLOWED.test(origin)) return res.status(403).json({ ok: false, error: 'origin' });

  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  b = b || {};
  if (b.website) return res.status(200).json({ ok: true, token: '0.0' }); // honeypot
  const phone = normalisePhone(b.phone);
  if (!phone) return res.status(400).json({ ok: false, error: 'Please enter a valid mobile number.' });
  if (!KEY || !CAMPAIGN || !SECRET) return res.status(503).json({ ok: false, error: 'not configured' });

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const exp = Date.now() + TTL_MS;
  const sig = crypto.createHmac('sha256', SECRET).update(`${phone}|${code}|${exp}`).digest('hex');
  const userName = (typeof b.name === 'string' && b.name.trim().slice(0, 60)) || 'Website visitor';

  try {
    const r = await fetch('https://backend.aisensy.com/campaign/t1/api/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: KEY,
        campaignName: CAMPAIGN,
        destination: phone,
        userName,
        source: 'thedistrictbynavilu.com',
        templateParams: [code],
        buttons: [{ type: 'button', sub_type: 'url', index: 0, parameters: [{ type: 'text', text: code }] }],
      }),
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) {
      let t = ''; try { t = await r.text(); } catch (e) {}
      console.error('aisensy', r.status, t.slice(0, 300));
      return res.status(502).json({ ok: false, error: 'send failed' });
    }
    return res.status(200).json({ ok: true, token: `${exp}.${sig}` });
  } catch (e) {
    console.error('aisensy error', e && e.message);
    return res.status(502).json({ ok: false, error: 'send failed' });
  }
};
