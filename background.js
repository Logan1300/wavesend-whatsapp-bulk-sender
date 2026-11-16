// WaveSend – background service worker: runs the sending queue with the Safety Shield.
import {
  DEFAULT_SETTINGS, buildMessage, renderTemplate, randBetween, humanDelay, nextAllowedTime, todayKey, hourKey,
  effectiveDailyLimit, isWithinLocal, nextLocalAllowed, classifyReply, shuffle, uid,
} from './lib/core.js';

const WA = 'https://web.whatsapp.com/';
const ALARM = 'ws_tick';
const HISTORY_LIMIT = 30;
const STALE_INFLIGHT_MS = 5 * 60 * 1000;
const ACTIVE = ['running', 'paused', 'scheduled'];

let busy = false;
let timer = null;

// ---------- storage helpers ----------
const get = async (k, d) => (await chrome.storage.local.get(k))[k] ?? d;
const set = (obj) => chrome.storage.local.set(obj);
const getCampaign = () => get('campaign', null);
const saveCampaign = (c) => set({ campaign: c });

async function counter(key, period) {
  const d = await get(key, null);
  return d && d.key === period ? d : { key: period, count: 0 };
}
async function addToBlocklist(phone) {
  const list = await get('blocklist', []);
  if (!list.includes(phone)) { list.push(phone); await set({ blocklist: list }); }
}
async function bumpLog(key, phone, value = Date.now()) {
  const log = await get(key, {});
  log[phone] = value;
  await set({ [key]: log });
}

// ---------- badge & notifications ----------
async function updateBadge(c) {
  try {
    if (!c || !ACTIVE.includes(c.status)) { await chrome.action.setBadgeText({ text: '' }); return; }
    const text = c.status === 'scheduled' ? '⏰' : c.status === 'paused' ? '❚❚' : String(c.index || 0);
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color: c.status === 'running' ? '#0f9d58' : '#e0a100' });
  } catch (e) { /* ignore */ }
}
function notify(title, message, urgent = false) {
  try {
    chrome.notifications.create('', { type: 'basic', iconUrl: 'icons/icon128.png', title, message, priority: urgent ? 2 : 1, requireInteraction: urgent });
  } catch (e) { /* ignore */ }
}

// ---------- scheduling ----------
function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(() => { timer = null; tick(); }, Math.max(250, Math.min(ms, 2 ** 31 - 1)));
}
async function ensureAlarm(on) {
  if (on) { if (!(await chrome.alarms.get(ALARM))) chrome.alarms.create(ALARM, { periodInMinutes: 0.5 }); }
  else chrome.alarms.clear(ALARM);
}

// ---------- WhatsApp tab ----------
async function ensureWaTab(c, focus = false) {
  let tab = null;
  if (c && c.tabId) {
    try { tab = await chrome.tabs.get(c.tabId); if (!tab.url || !tab.url.startsWith(WA)) tab = null; } catch (e) { tab = null; }
  }
  if (!tab) tab = (await chrome.tabs.query({ url: WA + '*' }))[0] || null;
  if (!tab) {
    tab = await chrome.tabs.create({ url: WA, active: true });
    await waitTabComplete(tab.id, 90000);
  }
  if (focus) {
    try { await chrome.tabs.update(tab.id, { active: true }); await chrome.windows.update(tab.windowId, { focused: true }); } catch (e) { /* */ }
  }
  if (c) c.tabId = tab.id;
  return tab.id;
}
function waitTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const t = setTimeout(done, timeoutMs);
    function listener(id, info) { if (id === tabId && info.status === 'complete') done(); }
    function done() { clearTimeout(t); chrome.tabs.onUpdated.removeListener(listener); resolve(); }
    chrome.tabs.onUpdated.addListener(listener);
  });
}
function navigate(tabId, url) {
  return new Promise((resolve, reject) => {
    let sawLoading = false;
    const t = setTimeout(done, 60000);
    function listener(id, info) {
      if (id !== tabId) return;
      if (info.status === 'loading') sawLoading = true;
      if (info.status === 'complete' && sawLoading) done();
    }
    function done() { clearTimeout(t); chrome.tabs.onUpdated.removeListener(listener); resolve(); }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url }).catch((e) => { done(); reject(e); });
  });
}
async function sendToTab(tabId, msg, attempts = 40) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { const res = await chrome.tabs.sendMessage(tabId, msg); if (res !== undefined) return res; } catch (e) { lastErr = e; }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('WhatsApp tab did not respond' + (lastErr ? ': ' + lastErr.message : ''));
}

// Opens the chat for `job.phone` and asks the content script to do the work.
// Fast path: open the chat inside the already-loaded WhatsApp Web (no reload).
// Fallback: load web.whatsapp.com/send?phone=… (reloads the page) – used only if the fast path fails.
let linkFails = 0;
async function contentReady(tabId, attempts = 30) {
  for (let i = 0; i < attempts; i++) {
    try { const r = await chrome.tabs.sendMessage(tabId, { type: 'ws_ping' }); if (r && r.ok) return true; } catch (e) { /* not yet */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}
async function performOnWhatsApp(c, job) {
  const tabId = await ensureWaTab(c);
  const s = { ...DEFAULT_SETTINGS, ...(await get('settings', {})) };
  const tryLink = s.openMethod !== 'reload' && linkFails < 3;
  if (tryLink) {
    if (!(await contentReady(tabId, 45))) {
      await chrome.tabs.reload(tabId);
      await waitTabComplete(tabId, 60000);
    }
    const res = await sendToTab(tabId, { type: 'ws_perform', job: { ...job, open: 'link' } });
    if (res.status !== 'open_failed') { linkFails = 0; return res; }
    linkFails++;
  }
  const prefill = job.mode === 'send' && job.text && !job.humanTyping && !(job.captionMode && job.attachmentCount > 0);
  const url = `${WA}send?phone=${job.phone}` + (prefill ? `&text=${encodeURIComponent(job.text)}` : '');
  await navigate(tabId, url);
  return sendToTab(tabId, { type: 'ws_perform', job: { ...job, open: 'url', prefilled: prefill } });
}

// ---------- results ----------
function record(c, i, status, extra = {}) {
  c.results = c.results || [];
  c.results[i] = { status, time: Date.now(), error: '', text: '', ...extra };
  c.counts = c.counts || {};
  c.counts[status] = (c.counts[status] || 0) + 1;
  if (extra.category) c.counts['cat_' + extra.category] = (c.counts['cat_' + extra.category] || 0) + 1;
  if (extra.receipt) c.counts['rcpt_' + extra.receipt] = (c.counts['rcpt_' + extra.receipt] || 0) + 1;
}
function moveToEnd(c, i) {
  const [k] = c.contacts.splice(i, 1);
  c.contacts.push(k);
}

async function archive(c) {
  const history = await get('history', []);
  const entry = { ...c };
  delete entry.inFlight;
  const at = history.findIndex(h => h.id === c.id);
  if (at >= 0) history[at] = entry; else history.unshift(entry);
  await set({ history: history.slice(0, HISTORY_LIMIT) });
}

async function mergeTracking(c) {
  const history = await get('history', []);
  const src = history.find(h => h.id === c.sourceId);
  if (!src) return;
  src.tracking = src.tracking || {};
  c.contacts.forEach((k, i) => {
    const r = c.results[i];
    if (r && (r.status === 'replied' || r.status === 'no_reply')) {
      src.tracking[k.phone] = { status: r.status, receipt: r.receipt, reply: r.reply, category: r.category, time: r.time };
    }
  });
  src.trackedAt = Date.now();
  await set({ history });
}

async function scheduleRepeat(c) {
  const step = { daily: 1, weekly: 7, monthly: 30 }[c.settings.repeat];
  if (!step) return;
  const base = c.scheduledAt || c.startedAt || Date.now();
  let next = base;
  while (next <= Date.now() + 60000) next += step * 86400000;
  const id = uid();
  const att = await get('att_' + c.id, []);
  await set({ ['att_' + id]: att });
  const copy = {
    id, name: c.name.replace(/ \(repeat.*\)$/, '') + ` (repeat ${new Date(next).toLocaleDateString()})`,
    mode: 'send', contacts: c.contacts, messages: c.messages, attachments: c.attachments, settings: c.settings,
    scheduledAt: next,
  };
  await startCampaign(copy);
  notify('WaveSend', `Next repeat of "${c.name}" scheduled for ${new Date(next).toLocaleString()}.`);
}

async function finish(c, status = 'completed') {
  c.status = status;
  c.finishedAt = Date.now();
  c.inFlight = null;
  c.nextAt = null;
  c.note = status === 'completed' ? 'Campaign finished.' : 'Campaign stopped.';
  await saveCampaign(c);
  await archive(c);
  if (c.mode === 'track') await mergeTracking(c);
  await ensureAlarm(false);
  await updateBadge(c);
  const n = c.counts || {};
  if (status === 'completed') {
    const msg = c.mode === 'validate' ? `${n.valid || 0} on WhatsApp, ${n.invalid || 0} not on WhatsApp.`
      : c.mode === 'track' ? `${n.replied || 0} replied (${n.cat_interested || 0} interested, ${n.cat_unsubscribe || 0} unsubscribed).`
      : `${n.sent || 0} sent, ${n.failed || 0} failed, ${n.invalid || 0} not on WhatsApp, ${n.skipped || 0} skipped.`;
    notify('WaveSend – finished: ' + c.name, msg);
    if (c.mode === 'send' && c.settings && c.settings.repeat && c.settings.repeat !== 'none') await scheduleRepeat(c);
  } else {
    await chrome.storage.local.remove('att_' + c.id);
  }
}

async function pauseWith(c, note, urgent = false) {
  c.status = 'paused';
  c.inFlight = null;
  c.note = note;
  clearTimeout(timer); timer = null;
  await saveCampaign(c);
  await updateBadge(c);
  notify(urgent ? '⚠️ WaveSend stopped sending' : 'WaveSend paused', note, urgent);
}

// ---------- the queue ----------
async function tick() {
  if (busy) return;
  busy = true;
  try { await step(); }
  catch (e) { console.error('[WaveSend] tick error', e); schedule(5000); }
  finally { busy = false; }
}

const settingsOf = (c) => ({ ...DEFAULT_SETTINGS, ...(c.settings || {}) });

async function step() {
  const c = await getCampaign();
  await updateBadge(c);
  if (!c) return ensureAlarm(false);
  const now = Date.now();

  if (c.status === 'scheduled') {
    await ensureAlarm(true);
    if (now < c.scheduledAt) return schedule(c.scheduledAt - now);
    c.status = 'running'; c.startedAt = now; c.nextAt = now; c.note = 'Scheduled campaign started.';
    await saveCampaign(c);
    notify('WaveSend', `Scheduled campaign "${c.name}" has started.`);
  }
  if (c.status !== 'running') return ensureAlarm(false);
  await ensureAlarm(true);

  if (c.inFlight) {
    if (now - c.inFlight.startedAt < STALE_INFLIGHT_MS) return schedule(15000);
    record(c, c.inFlight.index, 'failed', { error: 'Interrupted (browser or extension restarted)' });
    c.index = c.inFlight.index + 1;
    c.inFlight = null;
    await saveCampaign(c);
  }
  if (c.index >= c.contacts.length) return finish(c);
  if (c.nextAt && now < c.nextAt) return schedule(c.nextAt - now);

  const s = settingsOf(c);
  const wait = async (until, note) => { c.nextAt = until; c.note = note; await saveCampaign(c); schedule(until - now); };

  const allowed = nextAllowedTime(now, s);
  if (allowed > now) return wait(allowed, `Outside your sending hours – resumes ${new Date(allowed).toLocaleString()}`);

  if (c.mode === 'send') {
    const daily = await counter('daily', todayKey());
    const limit = effectiveDailyLimit(s);
    if (limit > 0 && daily.count >= limit) {
      const t = new Date(); t.setHours(24, 0, 0, 0);
      const resume = nextAllowedTime(t.getTime() + 9 * 3600000 + randBetween(0, 40) * 60000, s);
      return wait(resume, `Daily limit of ${limit}${s.warmupEnabled ? ' (warm-up)' : ''} reached – resumes ${new Date(resume).toLocaleString()}`);
    }
    const hourly = await counter('hourly', hourKey());
    if (Number(s.hourlyLimit) > 0 && hourly.count >= Number(s.hourlyLimit)) {
      const t = new Date(); t.setMinutes(60, 0, 0);
      const resume = t.getTime() + randBetween(1, 6) * 60000;
      return wait(resume, `Hourly limit of ${s.hourlyLimit} reached – resumes ${new Date(resume).toLocaleTimeString()}`);
    }
    if (s.respectLocalTime) {
      const k = c.contacts[c.index];
      if (!isWithinLocal(k.phone, s, now)) {
        const remaining = c.contacts.length - c.index;
        if ((c.deferrals || 0) < remaining) {
          moveToEnd(c, c.index);
          c.deferrals = (c.deferrals || 0) + 1;
          await saveCampaign(c);
          return schedule(150);
        }
        c.deferrals = 0;
        const t = Math.min(...c.contacts.slice(c.index).map(x => nextLocalAllowed(x.phone, s, now)));
        return wait(t + randBetween(1, 10) * 60000, `Waiting for recipients' local daytime – resumes ${new Date(t).toLocaleString()}`);
      }
    }
  }
  await processOne(c, s);
}

async function processOne(c, s) {
  const i = c.index;
  const contact = c.contacts[i];
  const skip = async (error) => {
    record(c, i, 'skipped', { error });
    c.index++; c.nextAt = Date.now() + 300;
    await saveCampaign(c);
    schedule(300);
  };

  if (c.mode === 'send') {
    if ((await get('blocklist', [])).includes(contact.phone)) return skip('On your blocklist');
    if (s.skipPreviouslySent) {
      const last = (await get('sentLog', {}))[contact.phone];
      if (last && (!Number(s.skipDays) || Date.now() - last < Number(s.skipDays) * 86400000)) return skip('Already messaged recently');
    }
    if (s.skipKnownInvalid && (await get('invalidLog', {}))[contact.phone]) return skip('Known: not on WhatsApp');
  }

  const built = c.mode === 'send' ? buildMessage(c, contact) : { text: '', variant: null };
  const captions = (c.attachments || []).map(a => a.caption ? renderTemplate(a.caption, contact) : '');
  c.inFlight = { index: i, startedAt: Date.now() };
  c.note = `${c.mode === 'validate' ? 'Checking' : c.mode === 'track' ? 'Reading replies from' : 'Sending to'} +${contact.phone}${contact.name ? ' (' + contact.name + ')' : ''}`;
  await saveCampaign(c);

  let res;
  try {
    res = await performOnWhatsApp(c, {
      phone: contact.phone, text: built.text, mode: c.mode,
      captionMode: !!s.captionMode, captions,
      attachmentKey: (c.attachments || []).length ? 'att_' + c.id : null,
      attachmentCount: (c.attachments || []).length,
      humanTyping: !!s.humanTyping,
      checkOptOut: c.mode === 'send' && !!s.autoOptOut, optOutKeywords: s.optOutKeywords,
      matchText: c.mode === 'track' ? (c.sentTexts || {})[contact.phone] || '' : '',
    });
  } catch (e) {
    res = { status: 'failed', error: e.message };
  }

  const latest = await getCampaign();
  if (latest && latest.id === c.id) c.status = latest.status; // user may have paused/stopped meanwhile
  c.inFlight = null;

  // ----- hard stops -----
  if (res.status === 'not_logged_in') return pauseWith(c, 'WhatsApp Web is not logged in. Scan the QR code, then press Resume.');
  if (res.status === 'warning') return pauseWith(c, `WhatsApp showed a warning: “${res.error}”. Sending stopped to protect your number. Wait at least 24–48 h before sending again.`, true);
  if (res.status === 'conflict') return pauseWith(c, 'WhatsApp is open in another window or the desktop app. Click “Use here” in this tab, then press Resume.');

  if (res.status === 'optout') {
    await addToBlocklist(contact.phone);
    return skip('Asked to stop earlier – added to blocklist');
  }

  // ----- failures: retry later at the end of the queue -----
  c.attempts = c.attempts || {};
  if (res.status === 'failed') {
    c.consecutiveFails = (c.consecutiveFails || 0) + 1;
    if (c.consecutiveFails >= Number(s.guardFailures || 3)) {
      if ((c.attempts[contact.phone] || 0) < Number(s.retries || 0)) { c.attempts[contact.phone] = (c.attempts[contact.phone] || 0) + 1; moveToEnd(c, i); }
      else { record(c, i, 'failed', { error: res.error, text: built.text, variant: built.variant }); c.index++; }
      c.consecutiveFails = 0;
      return pauseWith(c, `${s.guardFailures} failures in a row (last: ${res.error || 'unknown'}). Check that WhatsApp Web is open and working, then Resume.`);
    }
    if ((c.attempts[contact.phone] || 0) < Number(s.retries || 0)) {
      c.attempts[contact.phone] = (c.attempts[contact.phone] || 0) + 1;
      moveToEnd(c, i);
      c.nextAt = Date.now() + randBetween(6, 12) * 1000;
      c.note = `Will retry +${contact.phone} later (${res.error || 'failed'})`;
      await saveCampaign(c);
      return c.status === 'running' ? schedule(c.nextAt - Date.now()) : updateBadge(c);
    }
  } else c.consecutiveFails = 0;

  // ----- record -----
  if (c.mode === 'track' && res.status === 'tracked') {
    const category = res.reply ? classifyReply(res.reply, s.optOutKeywords) : null;
    record(c, i, res.reply ? 'replied' : 'no_reply', { receipt: res.receipt, reply: res.reply || '', category, error: '' });
    if (category === 'unsubscribe' && s.autoOptOut) await addToBlocklist(contact.phone);
  } else {
    record(c, i, res.status, { error: res.error || '', text: built.text, variant: built.variant });
  }
  c.index = i + 1;
  c.deferrals = 0;

  if (res.status === 'invalid') await bumpLog('invalidLog', contact.phone);
  if (res.status === 'valid') { const log = await get('invalidLog', {}); if (log[contact.phone]) { delete log[contact.phone]; await set({ invalidLog: log }); } }

  // ----- pacing -----
  let delay;
  if (res.status === 'sent') {
    const daily = await counter('daily', todayKey()); daily.count++;
    const hourly = await counter('hourly', hourKey()); hourly.count++;
    const dailyLog = await get('dailyLog', {}); dailyLog[todayKey()] = (dailyLog[todayKey()] || 0) + 1;
    await set({ daily, hourly, dailyLog });
    await bumpLog('sentLog', contact.phone);
    delay = humanDelay(s.delayMin, s.delayMax) * 1000;
    c.note = `Sent to +${contact.phone}`;
    c.batchCount = (c.batchCount || 0) + 1;
    if (!c.batchTarget) c.batchTarget = Math.max(1, Math.round(Number(s.batchSize) * randBetween(0.7, 1.3)));
    if (Number(s.batchSize) > 0 && c.batchCount >= c.batchTarget) {
      const pause = randBetween(s.batchPauseMin, s.batchPauseMax) * 60000;
      delay += pause;
      c.note = `Batch of ${c.batchCount} done – ${Math.round(pause / 60000)} min break`;
      c.batchCount = 0; c.batchTarget = 0;
    } else if (s.naturalPauses && Math.random() < 0.07) {
      const pause = randBetween(1, 4) * 60000;
      delay += pause;
      c.note = `Short human-like break (${Math.round(pause / 60000)} min)`;
    }
  } else {
    delay = (c.mode === 'send' ? randBetween(5, 10) : humanDelay(Math.max(5, s.delayMin / 3), Math.max(9, s.delayMax / 3))) * 1000;
    c.note = res.status === 'valid' ? `+${contact.phone} is on WhatsApp`
      : res.status === 'invalid' ? `+${contact.phone} is not on WhatsApp`
      : res.status === 'tracked' ? `Read +${contact.phone}${res.reply ? ' – replied' : ''}`
      : `Failed for +${contact.phone}: ${res.error || 'unknown error'}`;
  }

  // ----- invalid-rate guard (a high share of non-WhatsApp numbers is a classic ban trigger) -----
  if (c.mode === 'send' && !c.guardAck) {
    const n = c.counts || {};
    const processed = (n.sent || 0) + (n.invalid || 0) + (n.failed || 0);
    if (processed >= 10 && (n.invalid || 0) / processed * 100 > Number(s.guardInvalidRate || 40)) {
      await saveCampaign(c);
      return pauseWith(c, `${Math.round((n.invalid || 0) / processed * 100)}% of numbers so far are not on WhatsApp – that pattern can get you flagged. Clean the list with “Only check numbers” first, or Resume to continue anyway.`);
    }
  }

  c.nextAt = Date.now() + delay;
  await saveCampaign(c);
  await updateBadge(c);
  if (c.index >= c.contacts.length) return finish(c);
  if (c.status === 'running') schedule(delay);
}

// ---------- starting ----------
async function startCampaign(c) {
  const s = settingsOf(c);
  if (c.mode === 'send' && s.shuffle) c.contacts = shuffle(c.contacts);
  c.index = 0; c.results = []; c.counts = {}; c.attempts = {}; c.batchCount = 0; c.batchTarget = 0;
  c.consecutiveFails = 0; c.deferrals = 0; c.guardAck = false;
  c.createdAt = Date.now();
  c.status = c.scheduledAt && c.scheduledAt > Date.now() ? 'scheduled' : 'running';
  c.startedAt = c.status === 'running' ? Date.now() : null;
  c.nextAt = c.status === 'running' ? Date.now() + 1500 : null;
  c.note = c.status === 'scheduled' ? `Scheduled for ${new Date(c.scheduledAt).toLocaleString()}` : 'Starting…';
  await saveCampaign(c);
  if (c.status === 'running') { await ensureWaTab(c, true); await saveCampaign(c); }
  await ensureAlarm(true);
  tick();
}

function trackingCampaign(src) {
  const sentTexts = {};
  const contacts = [];
  src.contacts.forEach((k, i) => {
    const r = src.results && src.results[i];
    if (r && r.status === 'sent') {
      contacts.push(k);
      sentTexts[k.phone] = (r.text || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    }
  });
  return {
    id: uid(), name: `Replies: ${src.name}`, mode: 'track', sourceId: src.id, contacts, sentTexts,
    messages: [], attachments: [],
    variantsOf: Object.fromEntries(src.contacts.map((k, i) => [k.phone, src.results && src.results[i] ? src.results[i].variant : null])),
    settings: { ...src.settings, delayMin: 8, delayMax: 16, batchSize: 0, useWorkHours: false, respectLocalTime: false, shuffle: false },
  };
}

// ---------- commands from popup / dashboard / content ----------
async function handle(msg) {
  switch (msg.type) {
    case 'ws_keepalive':
      if (!busy && !timer) tick();
      return { ok: true };

    case 'ws_start': {
      const existing = await getCampaign();
      if (existing && ACTIVE.includes(existing.status)) return { ok: false, error: 'Another campaign is still active. Stop it first.' };
      await startCampaign(msg.campaign);
      return { ok: true };
    }

    case 'ws_track': {
      const existing = await getCampaign();
      if (existing && ACTIVE.includes(existing.status)) return { ok: false, error: 'Another campaign is active. Wait for it to finish first.' };
      const history = await get('history', []);
      const src = history.find(h => h.id === msg.sourceId) || (existing && existing.id === msg.sourceId ? existing : null);
      if (!src) return { ok: false, error: 'Campaign not found.' };
      const t = trackingCampaign(src);
      if (!t.contacts.length) return { ok: false, error: 'No sent messages to check.' };
      await startCampaign(t);
      return { ok: true, count: t.contacts.length };
    }

    case 'ws_pause': {
      const c = await getCampaign();
      if (!c || !['running', 'scheduled'].includes(c.status)) return { ok: false };
      c.status = 'paused'; c.note = 'Paused by you.';
      clearTimeout(timer); timer = null;
      await saveCampaign(c); await updateBadge(c);
      return { ok: true };
    }

    case 'ws_resume': {
      const c = await getCampaign();
      if (!c || c.status !== 'paused') return { ok: false };
      c.status = 'running'; c.nextAt = Date.now() + 1000; c.note = 'Resumed.';
      c.guardAck = true; c.consecutiveFails = 0;
      await saveCampaign(c);
      await ensureWaTab(c, true);
      await saveCampaign(c);
      await ensureAlarm(true);
      tick();
      return { ok: true };
    }

    case 'ws_stop': {
      const c = await getCampaign();
      if (!c || !ACTIVE.includes(c.status)) return { ok: false };
      clearTimeout(timer); timer = null;
      for (let i = c.index; i < c.contacts.length; i++) {
        if (!c.results[i]) c.results[i] = { status: 'not_sent', error: 'Campaign stopped', time: null, text: '' };
      }
      await finish(c, 'stopped');
      return { ok: true };
    }

    case 'ws_clear': {
      const c = await getCampaign();
      if (c && ACTIVE.includes(c.status)) return { ok: false, error: 'Stop the campaign first.' };
      await chrome.storage.local.remove('campaign');
      await updateBadge(null);
      return { ok: true };
    }

    case 'ws_test': {
      const c = await getCampaign();
      if (c && c.status === 'running') return { ok: false, error: 'Pause the running campaign before sending a test.' };
      if (busy) return { ok: false, error: 'Busy – try again in a moment.' };
      busy = true;
      try {
        const holder = { tabId: c && c.tabId };
        await ensureWaTab(holder, true);
        const s = { ...DEFAULT_SETTINGS, ...(await get('settings', {})) };
        const res = await performOnWhatsApp(holder, {
          phone: msg.phone, text: msg.text, mode: 'send', captionMode: !!msg.captionMode, captions: msg.captions || [],
          attachmentKey: msg.attachmentCount ? 'att_test' : null, attachmentCount: msg.attachmentCount || 0,
          humanTyping: !!s.humanTyping, checkOptOut: false,
        });
        return { ok: res.status === 'sent', ...res };
      } catch (e) {
        return { ok: false, status: 'failed', error: e.message };
      } finally { busy = false; }
    }

    case 'ws_extract_group':
    case 'ws_diagnose':
    case 'ws_export_chats': {
      const tabs = await chrome.tabs.query({ url: WA + '*' });
      if (!tabs.length) return { ok: false, error: 'Open WhatsApp Web first.' };
      const tab = tabs.find(t => t.active) || tabs[0];
      try { return await chrome.tabs.sendMessage(tab.id, { type: msg.type }); }
      catch (e) { return { ok: false, error: 'Reload the WhatsApp Web tab and try again.' }; }
    }

    case 'ws_add_blocklist':
      if (msg.phone) await addToBlocklist(String(msg.phone).replace(/\D/g, ''));
      return { ok: true };

    case 'ws_open_wa':
      await ensureWaTab({}, true);
      return { ok: true };

    case 'ws_open_dashboard':
      await openDashboard();
      return { ok: true };
  }
  return undefined;
}

async function openDashboard() {
  const url = chrome.runtime.getURL('dashboard.html');
  const tabs = await chrome.tabs.query({ url: url + '*' });
  if (tabs[0]) { await chrome.tabs.update(tabs[0].id, { active: true }); await chrome.windows.update(tabs[0].windowId, { focused: true }); }
  else await chrome.tabs.create({ url });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('ws_') || msg.type === 'ws_perform') return false;
  handle(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: e.message }));
  return true;
});

chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) tick(); });

chrome.runtime.onInstalled.addListener(async (details) => {
  const settings = await get('settings', null);
  await set({ settings: { ...DEFAULT_SETTINGS, ...(settings || {}) } });
  if (details.reason === 'install') openDashboard();
  tick();
});
chrome.runtime.onStartup.addListener(() => tick());
tick();
