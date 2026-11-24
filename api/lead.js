// Website lead capture for The District by Navilu -> TeleCRM (Sync API v2).
// New phone: creates the lead with Lead Source = Website plus a "Website Enquiry" timeline entry.
// Existing phone: leaves the lead's fields alone and only adds the timeline entry.
// Env: TELECRM_SYNC_TOKEN (required), TELECRM_ENTERPRISE_ID, TELECRM_WEB_ACTION (numeric code of "Website Enquiry").

const BASE = (process.env.TELECRM_BASE_URL || 'https://next.telecrm.in/autoupdate/v2').replace(/\/$/, '');
const ENT = process.env.TELECRM_ENTERPRISE_ID || '68cd52806250edb0e55d94b1';
const TOKEN = process.env.TELECRM_SYNC_TOKEN;
const ACTION = String(process.env.TELECRM_WEB_ACTION || '1001').replace(/^ACTION_/, '');
const FORMS = { brochure: 'Brochure download', enquiry: 'Enquiry form', whatsapp: 'WhatsApp form', availability: 'Plot availability', cost: 'Prices and EMI' };
const ALLOWED = /^https:\/\/((new|www)\.)?thedistrictbynavilu\.com$|^https:\/\/the-district-site[a-z0-9-]*\.vercel\.app$/;

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
const clip = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n) : '');

async function tc(path, body, method = 'POST') {
  const r = await fetch(`${BASE}/enterprise/${ENT}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(12000),
  });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, json: j };
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
  if (b.website) return res.status(200).json({ ok: true }); // honeypot: bots fill hidden fields

  const name = clip(b.name, 80);
  const phone = normalisePhone(b.phone);
  const form = FORMS[b.form] ? b.form : 'enquiry';
  if (!name || name.length < 2) return res.status(400).json({ ok: false, error: 'Please enter your name.' });
  if (!phone) return res.status(400).json({ ok: false, error: 'Please enter a valid mobile number.' });
  if (!b.consent) return res.status(400).json({ ok: false, error: 'Please tick the consent box.' });
  if (!TOKEN) { console.error('TELECRM_SYNC_TOKEN not set'); return res.status(503).json({ ok: false, error: 'not configured' }); }

  const need = clip(b.need, 120) || ((form === 'availability' || form === 'cost') ? 'to see ' + FORMS[form].toLowerCase() : ''), plot = clip(b.plot, 40), msg = clip(b.msg, 1000), camp = clip(b.campaign, 300);
  let date = '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(b.date || '')) date = b.date.split('-').reverse().join('/') + ' 10:00:00';

  const noteParts = [`${FORMS[form]} on the website.`];
  if (msg) noteParts.push(`Message: ${msg}`);
  if (b.page) noteParts.push(`Page: ${clip(b.page, 200)}`);
  const af = { notes: noteParts.join(' ') };
  af['form'] = FORMS[form];
  if (need) af['interested_in'] = need;
  if (plot) af['plot_of_interest'] = plot;
  if (date) af['preferred_visit_date'] = date;
  if (camp) af['campaign'] = camp;
  const actions = ACTION ? [{ type: ACTION, fields: af }] : [];

  const variants = [phone, '+' + phone];
  if (phone.length === 12 && phone.startsWith('91')) variants.push(phone.slice(2), '0' + phone.slice(2));
  try {
    // Existing lead (any stored format): add the timeline entry only, never touch its fields.
    const s = await tc('/lead/search?limit=1', { fields: { phone: variants } });
    let id = s.json && s.json.data && s.json.data[0] && s.json.data[0].id;
    if (!id) {
      const r = await tc('/lead', { fields: { name, phone, lead_source_1: 'Website' }, actions });
      if (r.status === 201 || r.status === 200) return res.status(200).json({ ok: true, created: true });
      if (r.status !== 409) { console.error('telecrm create', r.status, JSON.stringify(r.json)); return res.status(502).json({ ok: false, error: 'crm' }); }
      const s2 = await tc('/lead/search?limit=1', { fields: { phone } });
      id = s2.json && s2.json.data && s2.json.data[0] && s2.json.data[0].id;
    }
    if (id && actions.length) {
      const a = await tc(`/lead/${id}/action`, { actions });
      if (a.status >= 300) console.error('telecrm action', a.status, JSON.stringify(a.json));
    }
    return res.status(200).json({ ok: true, created: false });
  } catch (e) {
    console.error('telecrm error', e && e.message);
    return res.status(502).json({ ok: false, error: 'crm' });
  }
};
