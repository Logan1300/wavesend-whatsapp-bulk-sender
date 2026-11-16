// WaveSend – shared logic used by the background worker and the dashboard.

export const DEFAULT_SETTINGS = {
  countryCode: '91',        // added to numbers that have no country code
  localLength: 10,          // length of a local number without country code

  // pacing (per campaign, editable in step 4)
  preset: 'balanced',
  delayMin: 25,             // seconds between messages (random in range)
  delayMax: 50,
  batchSize: 25,            // take a longer break after about this many messages (±30% random)
  batchPauseMin: 4,         // minutes
  batchPauseMax: 9,
  dailyLimit: 200,          // max messages per calendar day (0 = no limit)
  useWorkHours: true,       // only send within the window below (your time)
  workStart: '09:00',
  workEnd: '21:00',
  skipPreviouslySent: false,// skip numbers messaged in an earlier campaign…
  skipDays: 30,             // …within this many days (0 = ever)
  captionMode: false,       // send the text as the caption of the first attachment
  retries: 1,               // failed numbers are retried at the end of the queue
  addOptOut: false,
  optOutText: 'Reply STOP to stop receiving these messages.',
  shuffle: true,            // randomise contact order
  repeat: 'none',           // none | daily | weekly | monthly

  // Safety Shield (global)
  hourlyLimit: 40,          // max messages in any clock hour (0 = no limit)
  humanTyping: true,        // type the message in chunks instead of pasting it
  naturalPauses: true,      // occasional random 1–4 min "human" breaks
  warmupEnabled: false,     // ramp up the daily limit for a new number
  warmupStart: '',          // yyyy-mm-dd the number started sending
  respectLocalTime: false,  // only message people during their own daytime (by country code)
  localStart: '09:00',
  localEnd: '21:00',
  skipKnownInvalid: true,   // never retry numbers already found to be not on WhatsApp
  autoOptOut: true,         // skip & blocklist people who replied STOP (checked in their chat before sending)
  optOutKeywords: 'stop, unsubscribe, stop messaging, remove me, remove my number, don\'t message, dont message, do not message, no more messages, don\'t send, dont send, band karo, mat bhejo, message mat karo',
  guardFailures: 3,         // auto-pause after this many failures in a row
  guardInvalidRate: 40,     // auto-pause if more than this % of numbers are not on WhatsApp (after 10)
  blur: false,              // privacy blur on WhatsApp Web
  openMethod: 'fast',       // fast = open chats inside WhatsApp Web (no reload) | reload = classic, reloads per message
};

export const PRESETS = {
  ultra: { label: 'Ultra-safe', delayMin: 45, delayMax: 90, batchSize: 15, batchPauseMin: 8, batchPauseMax: 15, dailyLimit: 80, hourlyLimit: 20 },
  balanced: { label: 'Balanced', delayMin: 25, delayMax: 50, batchSize: 25, batchPauseMin: 4, batchPauseMax: 9, dailyLimit: 200, hourlyLimit: 40 },
  fast: { label: 'Fast (known contacts only)', delayMin: 12, delayMax: 25, batchSize: 40, batchPauseMin: 2, batchPauseMax: 5, dailyLimit: 400, hourlyLimit: 80 },
};

// ---------- phone numbers ----------
export function normalizePhone(raw, countryCode = '91', localLength = 10) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s) return null;
  // Excel sometimes hands numbers over as 9.19876543210E+11
  if (/^\d+(\.\d+)?e\+?\d+$/i.test(s)) s = Number(s).toFixed(0);
  s = s.replace(/\.0+$/, '');
  const hadPlus = s.startsWith('+');
  let d = s.replace(/\D/g, '');
  if (!d) return null;
  const cc = String(countryCode || '').replace(/\D/g, '');
  const len = Number(localLength) || 10;
  if (!hadPlus) {
    if (d.startsWith('00')) d = d.slice(2);
    else if (cc) {
      if (d.length === len + 1 && d.startsWith('0')) d = cc + d.slice(1);
      else if (d.length === len) d = cc + d;
    }
  }
  if (d.length < 8 || d.length > 15) return null;
  return d;
}

export function formatPhone(d) {
  return d ? '+' + d : '';
}

// ---------- CSV ----------
export function parseCSV(text) {
  text = String(text || '').replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let q = false;
  for (const ch of firstLine) {
    if (ch === '"') q = !q;
    else if (!q && ch in counts) counts[ch]++;
  }
  let delim = ',';
  if (counts[';'] > counts[delim]) delim = ';';
  if (counts['\t'] > counts[delim] && counts['\t'] > 0) delim = '\t';

  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}

export function toCSV(rows) {
  return '﻿' + rows.map(r => r.map(v => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\r\n');
}

// Google Sheets share link → CSV export link
export function sheetCsvUrl(link) {
  const m = String(link || '').match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (!m) return null;
  const gid = (String(link).match(/[#&?]gid=(\d+)/) || [])[1];
  return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv${gid ? '&gid=' + gid : ''}`;
}

// ---------- turning rows into contacts ----------
const PHONE_HEADER = /(phone|mobile|number|whats\s*app|contact|cell|tel|no\.?$|msisdn)/i;
const NAME_HEADER = /^(full\s*)?name$|customer|client|first\s*name/i;

export function keyify(h) {
  return String(h || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function looksLikePhone(v) {
  const d = String(v || '').replace(/\D/g, '');
  return d.length >= 7 && d.length <= 15 && /^[\d\s+()\-.eE]+$/.test(String(v).trim());
}

// Decide whether row 0 is a header row and which column holds phone numbers.
export function analyseRows(rows) {
  if (!rows.length) return { hasHeader: false, headers: [], phoneCol: 0, nameCol: -1 };
  const width = Math.max(...rows.map(r => r.length));
  const first = rows[0];
  const firstHasPhone = first.some(looksLikePhone);
  const hasHeader = !firstHasPhone && first.some(c => /[a-z]/i.test(String(c)));
  const headers = [];
  for (let i = 0; i < width; i++) {
    const h = hasHeader ? String(first[i] || '').trim() : '';
    headers.push(h || `Column ${i + 1}`);
  }
  let phoneCol = headers.findIndex(h => PHONE_HEADER.test(h));
  const body = rows.slice(hasHeader ? 1 : 0, (hasHeader ? 1 : 0) + 50);
  if (phoneCol < 0) {
    let best = -1, bestScore = 0;
    for (let i = 0; i < width; i++) {
      const score = body.filter(r => looksLikePhone(r[i])).length;
      if (score > bestScore) { best = i; bestScore = score; }
    }
    phoneCol = best < 0 ? 0 : best;
  }
  let nameCol = headers.findIndex((h, i) => i !== phoneCol && NAME_HEADER.test(h));
  if (nameCol < 0 && !hasHeader) {
    nameCol = [...Array(width).keys()].find(i => i !== phoneCol &&
      body.some(r => /[a-z]/i.test(String(r[i] || '')))) ?? -1;
  }
  return { hasHeader, headers, phoneCol, nameCol };
}

export function rowsToContacts(rows, opts) {
  const { hasHeader, headers, phoneCol, nameCol, countryCode, localLength, blocklist = [], knownInvalid = [] } = opts;
  const block = new Set(blocklist);
  const bad = new Set(knownInvalid);
  const seen = new Set();
  const contacts = [];
  const stats = { total: 0, valid: 0, invalid: 0, duplicate: 0, blocked: 0, knownInvalid: 0 };
  rows.slice(hasHeader ? 1 : 0).forEach((r, idx) => {
    stats.total++;
    const phone = normalizePhone(r[phoneCol], countryCode, localLength);
    if (!phone) { stats.invalid++; return; }
    if (seen.has(phone)) { stats.duplicate++; return; }
    if (block.has(phone)) { stats.blocked++; return; }
    if (bad.has(phone)) { stats.knownInvalid++; return; }
    seen.add(phone);
    const fields = {};
    headers.forEach((h, i) => { fields[keyify(h) || `column_${i + 1}`] = r[i] === undefined ? '' : String(r[i]).trim(); });
    if (nameCol >= 0) fields.name = String(r[nameCol] || '').trim();
    fields.phone = phone;
    contacts.push({ phone, name: fields.name || '', fields, row: idx + 1 });
    stats.valid++;
  });
  return { contacts, stats };
}

// ---------- templates ----------
function buildVars(contact, now = new Date()) {
  const vars = {};
  const f = (contact && contact.fields) || {};
  for (const [k, v] of Object.entries(f)) vars[keyify(k)] = v;
  const name = (contact && (contact.name || f.name)) || '';
  vars.name = name;
  vars.first_name = vars.first_name || name.split(/\s+/)[0] || '';
  vars.phone = contact ? contact.phone : '';
  vars.date = now.toLocaleDateString('en-GB');
  vars.time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  vars.day = now.toLocaleDateString('en-GB', { weekday: 'long' });
  const h = now.getHours();
  vars.greeting = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  return vars;
}

// Spintax: {Hi|Hello|Hey} picks one at random. Nested groups are supported.
export function spin(text, rnd = Math.random) {
  let prev;
  let out = text;
  let guard = 0;
  do {
    prev = out;
    out = out.replace(/\{([^{}]*\|[^{}]*)\}/g, (m, body) => {
      const opts = body.split('|');
      return opts[Math.floor(rnd() * opts.length)];
    });
  } while (out !== prev && ++guard < 50);
  return out;
}

// Variables: {{name}}, {{city}}, {{name|Customer}} (fallback after the bar)
export function renderTemplate(tpl, contact, rnd = Math.random, now = new Date()) {
  const vars = buildVars(contact, now);
  const withVars = String(tpl || '').replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (m, inner) => {
    const bar = inner.indexOf('|');
    const key = keyify(bar >= 0 ? inner.slice(0, bar) : inner);
    const fallback = bar >= 0 ? inner.slice(bar + 1).trim() : '';
    const v = vars[key];
    return v !== undefined && String(v).trim() !== '' ? String(v) : fallback;
  });
  return spin(withVars, rnd).replace(/[ \t]+\n/g, '\n').trim();
}

export function templateVariables(tpl) {
  const out = new Set();
  String(tpl || '').replace(/\{\{\s*([^{}|]+?)\s*(\|[^{}]*)?\}\}/g, (m, k) => { out.add(keyify(k)); return m; });
  return [...out];
}

// Returns { text, variant } – variant is the index of the message variation used.
export function buildMessage(campaign, contact, rnd = Math.random) {
  const variants = (campaign.messages || []).map((m, i) => ({ m, i })).filter(x => x.m && x.m.trim());
  if (!variants.length) return { text: '', variant: null };
  const pick = variants[Math.floor(rnd() * variants.length)];
  let text = renderTemplate(pick.m, contact, rnd);
  const s = campaign.settings || {};
  if (s.addOptOut && s.optOutText) text += '\n\n' + s.optOutText;
  return { text, variant: pick.i };
}

// ---------- timing ----------
export function randBetween(a, b, rnd = Math.random) {
  const lo = Math.min(Number(a) || 0, Number(b) || 0);
  const hi = Math.max(Number(a) || 0, Number(b) || 0);
  return lo + rnd() * (hi - lo);
}

// Human-ish delay: mostly around the middle of the range, sometimes near the edges.
export function humanDelay(a, b, rnd = Math.random) {
  const u = (rnd() + rnd() + rnd()) / 3; // bell-shaped 0..1
  return randBetween(a, b, () => u);
}

function parseHM(hm) {
  const [h, m] = String(hm || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function inWindow(mins, start, end) {
  return start <= end ? (mins >= start && mins < end) : (mins >= start || mins < end);
}

// If `ts` falls outside the working window, return the next allowed moment.
export function nextAllowedTime(ts, settings) {
  if (!settings.useWorkHours) return ts;
  const start = parseHM(settings.workStart);
  const end = parseHM(settings.workEnd);
  const d = new Date(ts);
  if (inWindow(d.getHours() * 60 + d.getMinutes(), start, end)) return ts;
  const next = new Date(d);
  next.setSeconds(0, 0);
  next.setHours(Math.floor(start / 60), start % 60);
  if (next.getTime() <= ts) next.setDate(next.getDate() + 1);
  return next.getTime();
}

export function todayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function hourKey(ts = Date.now()) {
  return todayKey(ts) + 'T' + String(new Date(ts).getHours()).padStart(2, '0');
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function shuffle(arr, rnd = Math.random) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- warm-up ----------
const WARMUP = [[3, 20], [7, 35], [14, 60], [21, 100], [30, 150]];
export function warmupDay(settings, now = Date.now()) {
  if (!settings.warmupEnabled || !settings.warmupStart) return null;
  const start = new Date(settings.warmupStart + 'T00:00:00').getTime();
  if (!start) return null;
  return Math.max(1, Math.floor((now - start) / 86400000) + 1);
}
export function warmupCap(settings, now = Date.now()) {
  const day = warmupDay(settings, now);
  if (!day) return null;
  for (const [d, cap] of WARMUP) if (day <= d) return cap;
  return null; // warm-up finished
}
export function effectiveDailyLimit(settings, now = Date.now()) {
  const user = Number(settings.dailyLimit) || 0;
  const cap = warmupCap(settings, now);
  if (cap === null) return user;
  return user ? Math.min(user, cap) : cap;
}

// ---------- recipients' local time (approximate, by country calling code) ----------
const TZ = { // minutes from UTC (standard time)
  1: -300, 7: 180, 20: 120, 27: 120, 30: 120, 31: 60, 32: 60, 33: 60, 34: 60, 36: 60, 39: 60, 40: 120, 41: 60, 43: 60,
  44: 0, 45: 60, 46: 60, 47: 60, 48: 60, 49: 60, 51: -300, 52: -360, 54: -180, 55: -180, 56: -240, 57: -300, 58: -240,
  60: 480, 61: 600, 62: 420, 63: 480, 64: 720, 65: 480, 66: 420, 81: 540, 82: 540, 84: 420, 86: 480, 90: 180,
  91: 330, 92: 300, 93: 270, 94: 330, 95: 390, 98: 210, 212: 0, 213: 60, 216: 60, 233: 0, 234: 60, 251: 180,
  254: 180, 255: 180, 256: 180, 351: 0, 352: 60, 353: 0, 358: 120, 380: 120, 852: 480, 880: 360, 886: 480,
  960: 300, 961: 120, 962: 180, 963: 180, 964: 180, 965: 180, 966: 180, 967: 180, 968: 240, 971: 240, 972: 120,
  973: 180, 974: 180, 975: 360, 977: 345,
};
export function phoneUtcOffset(phone) {
  const d = String(phone || '');
  for (const len of [3, 2, 1]) {
    const code = Number(d.slice(0, len));
    if (TZ[code] !== undefined) return TZ[code];
  }
  return null;
}
function localMinutes(phone, ts) {
  const off = phoneUtcOffset(phone);
  if (off === null) return null;
  const d = new Date(ts);
  return ((d.getUTCHours() * 60 + d.getUTCMinutes() + off) % 1440 + 1440) % 1440;
}
export function isWithinLocal(phone, settings, ts = Date.now()) {
  if (!settings.respectLocalTime) return true;
  const m = localMinutes(phone, ts);
  if (m === null) return true;
  return inWindow(m, parseHM(settings.localStart), parseHM(settings.localEnd));
}
export function nextLocalAllowed(phone, settings, ts = Date.now()) {
  if (isWithinLocal(phone, settings, ts)) return ts;
  const m = localMinutes(phone, ts);
  const start = parseHM(settings.localStart);
  const wait = ((start - m) % 1440 + 1440) % 1440;
  return ts + wait * 60000 - (new Date(ts).getSeconds() * 1000);
}

// ---------- replies ----------
function kwList(s) {
  return String(s || '').split(/[,\n]/).map(x => x.trim().toLowerCase()).filter(Boolean);
}
function hasKeyword(text, kw) {
  const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${esc}($|[^\\p{L}\\p{N}])`, 'iu').test(text);
}
export function matchesOptOut(text, keywords) {
  const t = String(text || '').toLowerCase();
  return kwList(keywords).some(k => hasKeyword(t, k));
}
const NOT_INTERESTED = 'not interested, no thanks, no thank you, not now, not required, nahi chahiye, nahin chahiye, nahi, nahin, no';
const INTERESTED = 'interested, yes, yes please, price, prices, rate, rates, cost, how much, details, more info, info, catalog, catalogue, available, order, buy, want, need, call me, kitna, kitne, kya rate, haan, haa, ha ji, ji haan, send, share, location, address, ok, okay';
export function classifyReply(text, optOutKeywords = DEFAULT_SETTINGS.optOutKeywords) {
  const t = String(text || '').toLowerCase().trim();
  if (!t) return null;
  if (matchesOptOut(t, optOutKeywords)) return 'unsubscribe';
  if (kwList(NOT_INTERESTED).some(k => hasKeyword(t, k))) return 'not_interested';
  if (kwList(INTERESTED).some(k => hasKeyword(t, k))) return 'interested';
  return 'replied';
}

// ---------- spam-risk checker ----------
const SPAM_WORDS = ['free', 'offer', 'discount', '% off', 'limited time', 'hurry', 'click here', 'click', 'buy now', 'guaranteed',
  'winner', 'won', 'cash', 'earn', 'urgent', 'lottery', 'act now', 'deal', 'cheapest', 'last chance', 'risk free', '100%', 'investment', 'loan'];

export function analyzeMessages(messages, opts = {}) {
  const msgs = (messages || []).filter(m => m && m.trim());
  const issues = [];
  let risk = 0;
  const add = (pts, level, text) => { risk += pts; issues.push({ level, text }); };
  if (!msgs.length) return { risk: 0, level: 'none', issues: [], combos: 0 };
  const all = msgs.join('\n');
  const lower = all.toLowerCase();

  const links = (all.match(/https?:\/\/\S+|www\.\S+|\b\S+\.(com|in|net|org|shop|store|link|co)(\/\S*)?\b/gi) || []).length / msgs.length;
  if (/bit\.ly|tinyurl|goo\.gl|t\.co\/|cutt\.ly|rb\.gy|is\.gd/i.test(all)) add(20, 'bad', 'Link shorteners (bit.ly etc.) are a strong spam signal. Use your full website link.');
  if (links >= 1) add(links >= 2 ? 25 : 15, 'warn', 'Links in a first message raise spam scores. Consider sending the link only after they reply.');
  const words = SPAM_WORDS.filter(w => lower.includes(w));
  if (words.length) add(Math.min(25, words.length * 5), words.length > 2 ? 'bad' : 'warn', `Salesy words: ${words.slice(0, 6).join(', ')}. Sound like a person, not an ad.`);
  const caps = (all.match(/\b[A-Z]{4,}\b/g) || []).length;
  if (caps > 2) add(10, 'warn', `${caps} words in ALL CAPS – it reads as shouting/advertising.`);
  const emojis = (all.match(/\p{Extended_Pictographic}/gu) || []).length / msgs.length;
  if (emojis > 6) add(10, 'warn', 'Lots of emoji. 1–3 per message looks more natural.');
  if ((all.match(/!/g) || []).length / msgs.length > 3) add(5, 'warn', 'Many exclamation marks.');
  const avgLen = all.length / msgs.length;
  if (avgLen > 700) add(10, 'warn', 'Long message. Short, conversational first messages get more replies and fewer reports.');
  const personalised = msgs.every(m => /\{\{\s*[^}]+\}\}/.test(m));
  if (!personalised) add(15, 'bad', 'Add personalisation like {{name}} to every variation so each message is different.');
  // uniqueness: variations × spintax combinations
  let combos = 0;
  for (const m of msgs) {
    let c = 1;
    (m.match(/\{([^{}]*\|[^{}]*)\}/g) || []).forEach(g => { c *= g.split('|').length; });
    combos += c;
  }
  if (combos < 3) add(15, 'bad', 'Every message looks the same. Add 2–3 variations or {Hi|Hello|Hey} style random words.');
  else if (combos < 10 && (opts.contacts || 0) > 50) add(5, 'warn', `Only ${combos} different wordings for ${opts.contacts} contacts. Add more variety.`);
  if ((opts.contacts || 0) > 30 && !opts.optOut && !/stop|unsubscribe/i.test(all)) add(10, 'warn', 'No opt-out line. Letting people say STOP prevents them from reporting you.');
  if (opts.attachments > 2) add(5, 'warn', 'Several attachments per person adds volume. One file is usually enough.');
  risk = Math.min(100, risk);
  const level = risk >= 50 ? 'high' : risk >= 25 ? 'medium' : 'low';
  if (!issues.length) issues.push({ level: 'ok', text: 'Looks natural and personal. Nice.' });
  return { risk, level, issues, combos };
}
