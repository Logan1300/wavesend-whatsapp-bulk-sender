import {
  DEFAULT_SETTINGS, PRESETS, normalizePhone, formatPhone, parseCSV, toCSV, analyseRows, rowsToContacts,
  renderTemplate, buildMessage, keyify, uid, todayKey, hourKey, sheetCsvUrl, analyzeMessages, effectiveDailyLimit, warmupDay, warmupCap,
} from './lib/core.js';
import { readXlsx } from './lib/xlsx.js';

// ---------- helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get: async (k, d) => (await chrome.storage.local.get(k))[k] ?? d,
  set: (o) => chrome.storage.local.set(o),
};
const send = (msg) => chrome.runtime.sendMessage(msg).catch(e => ({ ok: false, error: e.message }));
const fmtBytes = (n) => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
const fmtDur = (sec) => {
  sec = Math.max(0, Math.round(sec));
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : m ? `${m} min${m < 10 && s ? ' ' + s + ' s' : ''}` : `${s} s`;
};
const pct = (a, b) => b ? Math.round(a / b * 100) : 0;
let toastTimer;
function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms);
}
function download(name, content, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function modal(title, html, extra) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = html;
  $('#modalExtra').hidden = !extra;
  if (extra) { $('#modalExtra').textContent = extra.label; $('#modalExtra').onclick = extra.onClick; }
  $('#modal').hidden = false;
}
$('#modalClose').addEventListener('click', () => ($('#modal').hidden = true));
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('#modal').hidden = true; });

// ---------- state ----------
let settings = { ...DEFAULT_SETTINGS };
let blocklist = [];
let templates = [];
let campaign = null;
let history = [];
let invalidLog = {};
let autoReply = { enabled: false, rules: [], defaultReply: '', optOutReply: '', cooldownHours: 12, idleSeconds: 45, skipGroups: true };
let contacts = [];
let stats = null;
let previewIdx = 0;
let attachments = []; // {name, type, size, dataUrl, asDocument, caption}
let groupMembers = null, chatList = null;

const OPTION_KEYS = ['preset', 'delayMin', 'delayMax', 'dailyLimit', 'batchSize', 'batchPauseMin', 'batchPauseMax', 'useWorkHours',
  'workStart', 'workEnd', 'skipPreviouslySent', 'skipDays', 'captionMode', 'retries', 'addOptOut', 'optOutText', 'shuffle', 'repeat'];
const pickOptions = (s) => Object.fromEntries(OPTION_KEYS.map(k => [k, s[k] ?? DEFAULT_SETTINGS[k]]));
const freshDraft = () => ({ source: null, messages: [''], active: 0, name: '', mode: 'send', when: 'now', schedAt: '', options: pickOptions(settings) });
let draft = freshDraft();
const campaignSettings = () => ({ ...settings, ...draft.options });

let saveTimer;
function saveDraft() { clearTimeout(saveTimer); saveTimer = setTimeout(() => store.set({ draft }), 300); }
const saveAttachments = () => store.set({ att_draft: attachments });

// ---------- navigation ----------
const VIEWS = ['compose', 'live', 'history', 'safety', 'automation', 'templates', 'settings', 'help'];
function show(view) {
  $$('nav button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach(v => (v.hidden = v.id !== 'view-' + view));
  ({ history: renderHistory, templates: renderTemplates, settings: renderSettings, live: renderLive, safety: renderSafety, automation: renderAutomation }[view] || (() => {}))();
  if (location.hash !== '#' + view) history_replace(view);
}
function history_replace(view) { window.history.replaceState(null, '', '#' + view); }
$$('nav button').forEach(b => b.addEventListener('click', () => show(b.dataset.view)));
window.addEventListener('hashchange', () => {
  const v = location.hash.replace('#', '');
  if (VIEWS.includes(v) && $('#view-' + v).hidden) show(v);
});
document.addEventListener('click', (e) => {
  const g = e.target.closest('[data-goto]');
  if (g) { e.preventDefault(); show(g.dataset.goto); }
  const t = e.target.closest('[data-goto-tab]');
  if (t) { e.preventDefault(); show('compose'); $(`[data-tabs="src"] [data-tab="${t.dataset.gotoTab}"]`).click(); }
});
$$('.tabs').forEach(tabs => {
  const group = tabs.dataset.tabs;
  tabs.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    $$('button', tabs).forEach(x => x.classList.toggle('active', x === b));
    $$(`[data-body^="${group}:"]`).forEach(body => (body.hidden = body.dataset.body !== `${group}:${b.dataset.tab}`));
  });
});

// ---------- contacts ----------
function setSource(rows, fileName, forced = {}) {
  if (!rows.length) { toast('No rows found.'); return; }
  const a = analyseRows(rows);
  draft.source = {
    rows, fileName,
    hasHeader: forced.hasHeader ?? a.hasHeader,
    phoneCol: forced.phoneCol ?? a.phoneCol,
    nameCol: forced.nameCol ?? a.nameCol,
    countryCode: draft.source?.countryCode ?? settings.countryCode,
  };
  previewIdx = 0;
  renderMapping();
  recompute();
}
function headersFor(src) {
  const width = Math.max(...src.rows.map(r => r.length));
  return [...Array(width).keys()].map(i => (src.hasHeader ? String(src.rows[0][i] || '').trim() : '') || `Column ${i + 1}`);
}
function renderMapping() {
  const src = draft.source;
  $('#mapping').hidden = !src;
  if (!src) return;
  const headers = headersFor(src);
  $('#mapPhone').innerHTML = headers.map((h, i) => `<option value="${i}">${esc(h)}</option>`).join('');
  $('#mapName').innerHTML = `<option value="-1">— none —</option>` + headers.map((h, i) => `<option value="${i}">${esc(h)}</option>`).join('');
  $('#mapPhone').value = src.phoneCol;
  $('#mapName').value = src.nameCol;
  $('#mapCC').value = src.countryCode;
  $('#mapHeader').value = src.hasHeader ? '1' : '0';
  $('#fileName').textContent = src.fileName ? `Loaded: ${src.fileName}` : '';
}
['#mapPhone', '#mapName', '#mapCC', '#mapHeader'].forEach(id => $(id).addEventListener('change', () => {
  const src = draft.source; if (!src) return;
  src.phoneCol = Number($('#mapPhone').value);
  src.nameCol = Number($('#mapName').value);
  src.countryCode = $('#mapCC').value.replace(/\D/g, '');
  const hh = $('#mapHeader').value === '1';
  if (hh !== src.hasHeader) { src.hasHeader = hh; renderMapping(); }
  recompute();
}));

function recompute() {
  const src = draft.source;
  if (!src) {
    contacts = []; stats = null;
    $('#contactSummary').textContent = 'No contacts yet';
  } else {
    const r = rowsToContacts(src.rows, {
      hasHeader: src.hasHeader, headers: headersFor(src), phoneCol: src.phoneCol, nameCol: src.nameCol,
      countryCode: src.countryCode, localLength: settings.localLength, blocklist,
      knownInvalid: settings.skipKnownInvalid && draft.mode === 'send' ? Object.keys(invalidLog) : [],
    });
    contacts = r.contacts; stats = r.stats;
    $('#contactSummary').innerHTML = `<b>${contacts.length}</b> contacts ready`;
    $('#contactStats').innerHTML = [
      `<span class="chip ok">${stats.valid} valid</span>`,
      stats.invalid ? `<span class="chip bad">${stats.invalid} invalid numbers skipped</span>` : '',
      stats.duplicate ? `<span class="chip warn">${stats.duplicate} duplicates removed</span>` : '',
      stats.blocked ? `<span class="chip warn">${stats.blocked} on blocklist / opted out</span>` : '',
      stats.knownInvalid ? `<span class="chip warn">${stats.knownInvalid} known not on WhatsApp</span>` : '',
      `<span class="chip">${stats.total} rows</span>`,
    ].join('');
    const headers = headersFor(src);
    const extra = headers.map((h, i) => ({ h, k: keyify(h) || `column_${i + 1}`, i })).filter(x => x.i !== src.phoneCol && x.i !== src.nameCol);
    const head = `<tr><th>#</th><th>WhatsApp number</th><th>Name</th>${extra.map(x => `<th>${esc(x.h)} <code>{{${esc(x.k)}}}</code></th>`).join('')}</tr>`;
    const body = contacts.slice(0, 100).map((c, n) => `<tr><td>${n + 1}</td><td>${formatPhone(c.phone)}</td><td>${esc(c.name)}</td>${extra.map(x => `<td>${esc(c.fields[x.k])}</td>`).join('')}</tr>`).join('');
    const more = contacts.length > 100 ? `<tr><td colspan="${3 + extra.length}" class="hint">…and ${contacts.length - 100} more</td></tr>` : '';
    $('#previewTable').innerHTML = head + body + more;
  }
  renderVarChips(); updatePreview(); updateEstimate(); renderRisk(); saveDraft();
}

async function handleContactFile(file) {
  if (!file) return;
  try {
    let rows;
    if (/\.xlsx$/i.test(file.name)) rows = await readXlsx(await file.arrayBuffer());
    else if (/\.xls$/i.test(file.name)) throw new Error('Old .xls files are not supported. In Excel choose File → Save As → .xlsx or .csv.');
    else rows = parseCSV(await file.text());
    setSource(rows, file.name);
    toast(`Imported ${contacts.length} contacts from ${file.name}`);
  } catch (e) { toast('Could not read file: ' + e.message, 6000); }
}
$('#fileContacts').addEventListener('change', (e) => { handleContactFile(e.target.files[0]); e.target.value = ''; });
setupDrop($('#dropContacts'), (files) => handleContactFile(files[0]));

$('#loadSheet').addEventListener('click', async () => {
  const url = sheetCsvUrl($('#sheetUrl').value.trim());
  if (!url) return toast('Paste a Google Sheets link (docs.google.com/spreadsheets/…).');
  $('#loadSheet').disabled = true; $('#loadSheet').textContent = 'Importing…';
  try {
    const res = await fetch(url, { credentials: 'omit' });
    const text = await res.text();
    if (!res.ok || /^\s*<(!doctype|html)/i.test(text)) throw new Error('the sheet isn\'t shared as “Anyone with the link”.');
    setSource(parseCSV(text), 'Google Sheet');
    toast(`Imported ${contacts.length} contacts from Google Sheets`);
  } catch (e) { toast('Could not import: ' + e.message, 6000); }
  $('#loadSheet').disabled = false; $('#loadSheet').textContent = 'Import sheet';
});

$('#usePasted').addEventListener('click', () => {
  const text = $('#pasteNumbers').value.trim();
  if (!text) return toast('Paste at least one number.');
  const rows = text.split(/\r?\n/).map(line => {
    const m = line.match(/^\s*([+\d][\d\s\-().]*\d)\s*[,;\t]?\s*(.*)$/);
    return m ? [m[1], m[2] || ''] : [line, ''];
  }).filter(r => r[0].trim());
  setSource([['Phone', 'Name'], ...rows], 'Pasted list', { hasHeader: true, phoneCol: 0, nameCol: 1 });
  toast(`${contacts.length} contacts ready`);
});

$('#grabGroup').addEventListener('click', async () => {
  $('#groupResult').textContent = 'Reading the open group…';
  const r = await send({ type: 'ws_extract_group' });
  if (!r || !r.ok) { $('#groupResult').textContent = (r && r.error) || 'Could not read the group.'; return; }
  groupMembers = r;
  $('#groupCsv').hidden = false;
  const withPhone = r.members.filter(m => m.phone);
  const named = r.members.length - withPhone.length;
  if (!withPhone.length) { $('#groupResult').textContent = `Found ${r.members.length} members in “${r.group}”, but all are saved contacts so their numbers aren't shown.`; return; }
  setSource([['Phone', 'Name', 'Group'], ...withPhone.map(m => [m.phone, '', r.group])], `Group: ${r.group}`, { hasHeader: true, phoneCol: 0, nameCol: 1 });
  $('#groupResult').textContent = `Took ${withPhone.length} numbers from “${r.group}”${named ? ` (${named} saved contacts shown by name were skipped)` : ''}.`;
});
$('#groupCsv').addEventListener('click', () => groupMembers && download(`group_${keyify(groupMembers.group) || 'members'}.csv`,
  toCSV([['Member', 'Phone'], ...groupMembers.members.map(m => [m.label, m.phone ? '+' + m.phone : ''])])));

$('#grabChats').addEventListener('click', async () => {
  $('#chatsResult').textContent = 'Scrolling through your chat list… keep the WhatsApp tab open.';
  $('#grabChats').disabled = true;
  const r = await send({ type: 'ws_export_chats' });
  $('#grabChats').disabled = false;
  if (!r || !r.ok) { $('#chatsResult').textContent = (r && r.error) || 'Could not read the chat list.'; return; }
  chatList = r.chats;
  $('#chatsCsv').hidden = false;
  const nums = r.chats.filter(c => c.phone);
  $('#chatsResult').textContent = `Found ${r.chats.length} chats – ${nums.length} unsaved numbers${nums.length ? ' loaded as contacts' : ''}.`;
  if (nums.length) setSource([['Phone', 'Name', 'Source'], ...nums.map(c => [c.phone, '', 'Chat list'])], 'Chat list', { hasHeader: true, phoneCol: 0, nameCol: 1 });
});
$('#chatsCsv').addEventListener('click', () => chatList && download('whatsapp_chat_list.csv',
  toCSV([['Chat', 'Phone'], ...chatList.map(c => [c.label, c.phone ? '+' + c.phone : ''])])));

$('#dlSample').addEventListener('click', (e) => {
  e.preventDefault();
  download('wavesend-sample.csv', toCSV([
    ['Name', 'Phone', 'City', 'Offer'],
    ['Rahul Sharma', '9876543210', 'Delhi', '10% off'],
    ['Priya Singh', '+91 98123 45678', 'Mumbai', 'Free delivery'],
    ['Emma Watson', '+44 7700 900123', 'London', '15% off'],
  ]));
});
function setupDrop(zone, onFiles) {
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('over'); if (e.dataTransfer.files.length) onFiles([...e.dataTransfer.files]); });
}

// ---------- message editor ----------
const ta = $('#msgText');
function renderVariants() {
  const tabs = draft.messages.map((m, i) =>
    `<button data-i="${i}" class="${i === draft.active ? 'active' : ''}">Message ${i + 1}${draft.messages.length > 1 ? '<span class="x" data-del="' + i + '">×</span>' : ''}</button>`).join('');
  $('#variantTabs').innerHTML = tabs + (draft.messages.length < 5 ? '<button class="add" data-add="1">+ Add variation</button>' : '');
  ta.value = draft.messages[draft.active] || '';
  $('#charCount').textContent = `${ta.value.length} characters`;
}
$('#variantTabs').addEventListener('click', (e) => {
  const del = e.target.closest('[data-del]');
  if (del) { draft.messages.splice(Number(del.dataset.del), 1); draft.active = Math.min(draft.active, draft.messages.length - 1); }
  else if (e.target.closest('[data-add]')) { draft.messages.push(''); draft.active = draft.messages.length - 1; }
  else { const b = e.target.closest('[data-i]'); if (!b) return; draft.active = Number(b.dataset.i); }
  renderVariants(); updatePreview(); renderRisk(); saveDraft(); ta.focus();
});
ta.addEventListener('input', () => {
  draft.messages[draft.active] = ta.value;
  $('#charCount').textContent = `${ta.value.length} characters`;
  updatePreview(); updateEstimate(); renderRisk(); saveDraft();
});
function insertAtCursor(text, selectInner) {
  const s = ta.selectionStart, e = ta.selectionEnd;
  ta.setRangeText(text, s, e, 'end');
  if (selectInner) ta.setSelectionRange(s + selectInner[0], s + selectInner[1]);
  ta.focus();
  ta.dispatchEvent(new Event('input'));
}
$$('.toolbar [data-wrap]').forEach(b => b.addEventListener('click', () => {
  const w = b.dataset.wrap;
  const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd) || 'text';
  insertAtCursor(w + sel + w, [w.length, w.length + sel.length]);
}));
$('#spinBtn').addEventListener('click', () => {
  const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
  insertAtCursor(sel ? `{${sel}|}` : '{Hi|Hello|Hey}');
});
const EMOJIS = '😀 😃 😊 🙂 😍 🤩 😎 🥳 😇 🤗 👋 🙏 👍 👏 💪 🤝 ✌️ 👉 👇 ✅ ❤️ 💚 💯 ✨ 🎉 🎊 🎁 🛍️ 🛒 💰 🔥 ⭐ 🌟 📢 📣 📌 📍 📅 ⏰ 📞 📱 💬 📦 🚚 🏷️ 💸 🆕 ⚡ 🌸 🪔 🎆 🍬 ☕ 🌞 🌙 ➡️ 🔔 ℹ️ 😉'.split(' ');
$('#emojiPop').innerHTML = EMOJIS.map(e => `<button>${e}</button>`).join('');
$('#emojiBtn').addEventListener('click', (e) => {
  const pop = $('#emojiPop');
  pop.hidden = !pop.hidden;
  const r = e.target.getBoundingClientRect(), p = $('.msg-edit').getBoundingClientRect();
  pop.style.left = (r.left - p.left) + 'px'; pop.style.top = (r.bottom - p.top + 4) + 'px';
});
$('#emojiPop').addEventListener('click', (e) => { if (e.target.tagName === 'BUTTON') { insertAtCursor(e.target.textContent); $('#emojiPop').hidden = true; } });
document.addEventListener('click', (e) => { if (!e.target.closest('#emojiPop, #emojiBtn')) $('#emojiPop').hidden = true; });

function renderVarChips() {
  const keys = ['name', 'first_name', 'greeting'];
  if (draft.source) headersFor(draft.source).forEach((h, i) => {
    const k = keyify(h) || `column_${i + 1}`;
    if (!keys.includes(k) && i !== draft.source.phoneCol) keys.push(k);
  });
  $('#varChips').innerHTML = keys.slice(0, 14).map(k => `<button data-var="${esc(k)}" title="Insert {{${esc(k)}}}">{{${esc(k)}}}</button>`).join('');
}
$('#varChips').addEventListener('click', (e) => { const b = e.target.closest('[data-var]'); if (b) insertAtCursor(`{{${b.dataset.var}}}`); });

function waFormat(text) {
  let h = esc(text);
  h = h.replace(/```([\s\S]+?)```/g, '<code>$1</code>');
  h = h.replace(/(^|[\s(])\*(\S(?:[^*\n]*\S)?)\*(?=$|[\s.,!?)])/g, '$1<b>$2</b>');
  h = h.replace(/(^|[\s(])_(\S(?:[^_\n]*\S)?)_(?=$|[\s.,!?)])/g, '$1<i>$2</i>');
  h = h.replace(/(^|[\s(])~(\S(?:[^~\n]*\S)?)~(?=$|[\s.,!?)])/g, '$1<s>$2</s>');
  return h;
}
const SAMPLE = { phone: '919876543210', name: 'Rahul Sharma', fields: { name: 'Rahul Sharma', city: 'Delhi' } };
function updatePreview() {
  const c = contacts[previewIdx] || SAMPLE;
  $('#pvName').textContent = c.name || formatPhone(c.phone);
  $('#pvPhone').textContent = formatPhone(c.phone);
  $('#pvAvatar').textContent = (c.name || '#').trim().charAt(0).toUpperCase() || '#';
  let text = renderTemplate(draft.messages[draft.active] || '', c);
  if (draft.options.addOptOut && draft.options.optOutText && text) text += '\n\n' + draft.options.optOutText;
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const meta = `<span class="meta">${time} ✓✓</span>`;
  const parts = [];
  const caption = draft.options.captionMode && attachments.length;
  if (text && !caption) parts.push(`<div class="bubble">${waFormat(text)}${meta}</div>`);
  attachments.forEach((a, i) => {
    let capText = a.caption ? renderTemplate(a.caption, c) : '';
    if (caption && i === 0 && text) capText = text + (capText ? '\n\n' + capText : '');
    const cap = capText ? `<div>${waFormat(capText)}</div>` : '';
    if (/^image\//.test(a.type) && !a.asDocument) parts.push(`<div class="bubble"><img src="${a.dataUrl}" alt="">${cap}${meta}</div>`);
    else parts.push(`<div class="bubble"><div class="file"><span class="ic">${/vcard/.test(a.type) ? '👤' : /^video/.test(a.type) ? '🎬' : /^audio/.test(a.type) ? '🎵' : /pdf/.test(a.type) ? '📕' : '📄'}</span><span>${esc(a.name)}<br><small>${fmtBytes(a.size)}</small></span></div>${cap}${meta}</div>`);
  });
  $('#pvBody').innerHTML = parts.join('') || '<div class="pv-empty">Your message preview appears here.</div>';
}
$('#pvShuffle').addEventListener('click', () => { if (contacts.length) previewIdx = (previewIdx + 1) % contacts.length; updatePreview(); });

function renderRisk() {
  const r = analyzeMessages(draft.messages, { contacts: contacts.length, optOut: draft.options.addOptOut, attachments: attachments.length });
  const box = $('#riskBox');
  if (draft.mode === 'validate' || r.level === 'none') { box.hidden = true; return; }
  box.hidden = false;
  const color = r.level === 'high' ? '#c0392b' : r.level === 'medium' ? '#b7791f' : '#128c4b';
  box.innerHTML = `<div class="risk-head"><b>Spam-risk check: ${r.level === 'high' ? 'High' : r.level === 'medium' ? 'Medium' : 'Low'}</b>
    <span class="risk-bar"><i style="width:${Math.max(6, r.risk)}%;background:${color}"></i></span>
    <span class="hint">${r.combos >= 1000 ? '1000+' : r.combos} wording combinations${contacts.length ? ` for ${contacts.length} contacts` : ''}</span></div>
    <ul>${r.issues.map(i => `<li class="${i.level}">${esc(i.text)}</li>`).join('')}</ul>`;
}

$('#previewAll').addEventListener('click', () => {
  if (!contacts.length) return toast('Add contacts first.');
  const fake = { messages: draft.messages, settings: draft.options };
  const rows = contacts.slice(0, 500).map((c, i) => { const m = buildMessage(fake, c); return [i + 1, c, m]; });
  modal(`Preview of ${Math.min(500, contacts.length)} of ${contacts.length} messages`,
    `<table><tr><th>#</th><th>Number</th><th>Name</th><th>Var.</th><th>Message</th></tr>${rows.map(([i, c, m]) =>
      `<tr><td>${i}</td><td>${formatPhone(c.phone)}</td><td>${esc(c.name)}</td><td>${m.variant === null ? '' : m.variant + 1}</td><td>${waFormat(m.text)}</td></tr>`).join('')}</table>`,
    { label: 'Export CSV', onClick: () => download('wavesend_preview.csv', toCSV([['phone', 'name', 'variation', 'message'], ...rows.map(([i, c, m]) => ['+' + c.phone, c.name, m.variant === null ? '' : m.variant + 1, m.text])])) });
});

// templates in composer
$('#saveTemplate').addEventListener('click', async () => {
  const msgs = draft.messages.filter(m => m.trim());
  if (!msgs.length) return toast('Write a message first.');
  const name = prompt('Template name:', draft.name || `Template ${templates.length + 1}`);
  if (!name) return;
  templates.unshift({ id: uid(), name, messages: msgs, createdAt: Date.now() });
  await store.set({ templates });
  renderTemplateSelect();
  toast('Template saved – also available as ⚡ Quick reply in WhatsApp Web');
});
function renderTemplateSelect() {
  $('#loadTemplate').innerHTML = '<option value="">Load template…</option>' + templates.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
}
$('#loadTemplate').addEventListener('change', (e) => { const t = templates.find(x => x.id === e.target.value); e.target.value = ''; if (t) useTemplate(t); });
function useTemplate(t) {
  draft.messages = [...t.messages]; draft.active = 0;
  renderVariants(); updatePreview(); renderRisk(); saveDraft();
  toast(`Loaded “${t.name}”`);
}

// ---------- attachments ----------
const readAsDataURL = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
async function addFiles(files) {
  for (const f of files) {
    const total = attachments.reduce((s, a) => s + a.size, 0) + f.size;
    if (total > 60 * 1048576) { toast('Attachments are limited to 60 MB in total.'); break; }
    if (attachments.length >= 10) { toast('Up to 10 attachments.'); break; }
    attachments.push({ name: f.name, type: f.type || 'application/octet-stream', size: f.size, dataUrl: await readAsDataURL(f), asDocument: false, caption: '' });
  }
  await saveAttachments();
  renderFiles(); updatePreview(); updateEstimate(); renderRisk();
}
$('#fileAttach').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });
setupDrop($('#dropFiles'), addFiles);
$('#addVcard').addEventListener('click', async () => {
  const name = prompt('Contact card – name to show:', 'Customer Care');
  if (!name) return;
  const raw = prompt('Phone number for the card:', '');
  const phone = normalizePhone(raw, settings.countryCode, settings.localLength);
  if (!phone) return toast('That phone number is not valid.');
  const org = prompt('Business name (optional):', '') || '';
  const vcf = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${name}`, `N:${name};;;;`, org ? `ORG:${org}` : '', `TEL;type=CELL;type=VOICE;waid=${phone}:+${phone}`, 'END:VCARD'].filter(Boolean).join('\r\n');
  const bytes = new TextEncoder().encode(vcf);
  const b64 = btoa(String.fromCharCode(...bytes));
  attachments.push({ name: `${name.replace(/[^\w\- ]+/g, '').trim() || 'contact'}.vcf`, type: 'text/vcard', size: bytes.length, dataUrl: 'data:text/vcard;base64,' + b64, asDocument: true, caption: '' });
  await saveAttachments(); renderFiles(); updatePreview();
});
function renderFiles() {
  $('#fileList').innerHTML = attachments.map((a, i) => {
    const media = /^(image|video)\//.test(a.type);
    const thumb = /^image\//.test(a.type) ? `<img class="thumb" src="${a.dataUrl}" alt="">` : `<span class="thumb">${/vcard/.test(a.type) ? '👤' : /^video/.test(a.type) ? '🎬' : /^audio/.test(a.type) ? '🎵' : '📄'}</span>`;
    return `<li>${thumb}<div><div class="name">${esc(a.name)}</div><div class="meta">${fmtBytes(a.size)} · ${esc(a.type)}</div></div>
      <input class="cap" data-cap="${i}" placeholder="Caption (optional, {{name}} works)" value="${esc(a.caption || '')}">
      ${media ? `<label class="check"><input type="checkbox" data-doc="${i}" ${a.asDocument ? 'checked' : ''}> as document</label>` : ''}
      <button data-rm="${i}" title="Remove">✕</button></li>`;
  }).join('');
}
$('#fileList').addEventListener('click', async (e) => {
  const rm = e.target.closest('[data-rm]');
  if (rm) { attachments.splice(Number(rm.dataset.rm), 1); await saveAttachments(); renderFiles(); updatePreview(); renderRisk(); }
});
$('#fileList').addEventListener('change', async (e) => {
  const d = e.target.closest('[data-doc]');
  if (d) { attachments[Number(d.dataset.doc)].asDocument = d.checked; await saveAttachments(); updatePreview(); }
});
$('#fileList').addEventListener('input', (e) => {
  const c = e.target.closest('[data-cap]');
  if (c) { attachments[Number(c.dataset.cap)].caption = c.value; clearTimeout(c._t); c._t = setTimeout(saveAttachments, 400); updatePreview(); }
});

// ---------- sending options ----------
const optMap = {
  dMin: 'delayMin', dMax: 'delayMax', dLimit: 'dailyLimit', bSize: 'batchSize', bMin: 'batchPauseMin', bMax: 'batchPauseMax',
  hStart: 'workStart', hEnd: 'workEnd', optOutText: 'optOutText', optRetries: 'retries', optSkipDays: 'skipDays', optRepeat: 'repeat',
};
const checkMap = { optHours: 'useWorkHours', optSkip: 'skipPreviouslySent', optOut: 'addOptOut', optCaption: 'captionMode', optShuffle: 'shuffle' };
const PACING = ['delayMin', 'delayMax', 'dailyLimit', 'batchSize', 'batchPauseMin', 'batchPauseMax'];

function renderOptions() {
  const o = draft.options;
  for (const [id, k] of Object.entries(optMap)) $('#' + id).value = o[k] ?? '';
  for (const [id, k] of Object.entries(checkMap)) $('#' + id).checked = !!o[k];
  $$('#presetSeg button').forEach(b => b.classList.toggle('active', b.dataset.preset === (o.preset || 'custom')));
  $('#campName').value = draft.name || '';
  $$('#modeSeg button').forEach(b => b.classList.toggle('active', b.dataset.mode === draft.mode));
  $$('input[name="when"]').forEach(r => (r.checked = r.value === draft.when));
  $('#schedAt').value = draft.schedAt || '';
  updateEstimate(); renderShieldNote();
}
for (const [id, k] of Object.entries(optMap)) {
  $('#' + id).addEventListener('input', (e) => {
    const v = e.target.value;
    draft.options[k] = e.target.type === 'number' ? (v === '' ? '' : Number(v)) : v;
    if (PACING.includes(k)) { draft.options.preset = 'custom'; $$('#presetSeg button').forEach(b => b.classList.toggle('active', b.dataset.preset === 'custom')); }
    updateEstimate(); updatePreview(); renderShieldNote(); saveDraft();
  });
}
for (const [id, k] of Object.entries(checkMap)) {
  $('#' + id).addEventListener('change', (e) => { draft.options[k] = e.target.checked; updatePreview(); updateEstimate(); renderRisk(); saveDraft(); });
}
$('#presetSeg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-preset]'); if (!b) return;
  const p = b.dataset.preset;
  draft.options.preset = p;
  if (PRESETS[p]) PACING.forEach(k => (draft.options[k] = PRESETS[p][k]));
  renderOptions(); saveDraft();
});
$('#campName').addEventListener('input', (e) => { draft.name = e.target.value; saveDraft(); });
$('#modeSeg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mode]'); if (!b) return;
  draft.mode = b.dataset.mode; renderOptions(); recompute();
});
$$('input[name="when"]').forEach(r => r.addEventListener('change', () => { draft.when = r.value; saveDraft(); }));
$('#schedAt').addEventListener('input', (e) => { draft.schedAt = e.target.value; draft.when = 'later'; $$('input[name="when"]').forEach(r => (r.checked = r.value === 'later')); saveDraft(); });

function renderShieldNote() {
  const s = campaignSettings();
  const parts = [];
  if (s.humanTyping) parts.push('human-like typing');
  if (s.naturalPauses) parts.push('natural breaks');
  if (Number(s.hourlyLimit)) parts.push(`max ${s.hourlyLimit}/hour`);
  if (s.autoOptOut) parts.push('opt-out detection');
  if (s.skipKnownInvalid) parts.push('skips known invalid numbers');
  if (s.respectLocalTime) parts.push("recipients' local time");
  const day = warmupDay(s), cap = warmupCap(s);
  if (cap) parts.push(`warm-up day ${day} (max ${effectiveDailyLimit(s)}/day)`);
  $('#shieldNote').innerHTML = `🛡 <b>Safety Shield:</b> ${parts.join(' · ') || 'off'} <a href="#" data-goto="safety">change</a>`;
}

let healthTimer;
function refreshHealthBadge() { clearTimeout(healthTimer); healthTimer = setTimeout(() => computeHealth().then(h => updateHealthBadge(h.score)), 300); }
function updateEstimate() {
  refreshHealthBadge();
  const o = campaignSettings();
  const n = contacts.length;
  const lo = Number(o.delayMin) || 0, hi = Number(o.delayMax) || 0, avg = (lo + hi) / 2;
  let level, color, text;
  if (draft.mode === 'validate') { level = 90; color = '#128c4b'; text = 'Checking numbers sends nothing – low risk.'; }
  else if (avg < 12) { level = 20; color = '#c0392b'; text = 'Risky: delays this short look automated.'; }
  else if (avg < 25 || !Number(o.dailyLimit) || Number(o.dailyLimit) > 300) { level = 55; color = '#b7791f'; text = 'Moderate: fine for people who already know you.'; }
  else { level = 92; color = '#128c4b'; text = 'Safe pace.'; }
  $('.meter i').style.width = level + '%'; $('.meter i').style.background = color;
  $('#safetyText').textContent = text;
  const nFiles = attachments.length;
  if (!n) { $('#estimate').textContent = ''; $('#startSummary').textContent = ''; return; }
  const typing = o.humanTyping ? 8 : 0;
  const perMsg = draft.mode === 'validate' ? 14 : avg + 10 + typing + nFiles * 8;
  const batches = Number(o.batchSize) > 0 && draft.mode === 'send' ? Math.floor((n - 1) / Number(o.batchSize)) : 0;
  const active = n * perMsg + batches * ((Number(o.batchPauseMin) + Number(o.batchPauseMax)) / 2) * 60;
  const limit = effectiveDailyLimit(o);
  const days = draft.mode === 'send' && limit > 0 ? Math.ceil(n / limit) : 1;
  $('#estimate').textContent = `About ${fmtDur(active)} of sending for ${n} contacts${days > 1 ? `, spread over ${days} days (limit ${limit}/day)` : ''}`;
  const variants = draft.messages.filter(m => m.trim()).length;
  $('#startSummary').innerHTML = draft.mode === 'validate' ? `<b>${n}</b> numbers to check`
    : `<b>${n}</b> contacts · ${variants} variation${variants === 1 ? '' : 's'}${nFiles ? ` · ${nFiles} file${nFiles === 1 ? '' : 's'}` : ''}`;
}

// ---------- test & start ----------
$('#sendTest').addEventListener('click', async () => {
  const phone = normalizePhone($('#testPhone').value, draft.source?.countryCode || settings.countryCode, settings.localLength);
  if (!phone) return toast('Enter a valid number for the test.');
  const fake = { messages: draft.messages, settings: draft.options };
  const c = { ...(contacts[previewIdx] || SAMPLE), phone };
  const { text } = buildMessage(fake, c);
  if (!text && !attachments.length) return toast('Write a message first.');
  await store.set({ att_test: attachments });
  $('#sendTest').disabled = true; $('#sendTest').textContent = 'Sending…';
  const r = await send({ type: 'ws_test', phone, text, captionMode: draft.options.captionMode, attachmentCount: attachments.length,
    captions: attachments.map(a => a.caption ? renderTemplate(a.caption, c) : '') });
  $('#sendTest').disabled = false; $('#sendTest').textContent = 'Send test';
  if (r && r.ok) toast('Test sent ✓ – check WhatsApp');
  else toast('Test failed: ' + ((r && (r.error || r.status)) || 'unknown error'), 7000);
});

$('#startBtn').addEventListener('click', async () => {
  const err = (m) => { $('#startError').textContent = m; $('#startError').hidden = false; };
  $('#startError').hidden = true;
  const o = draft.options;
  const msgs = draft.messages.filter(m => m.trim());
  if (!contacts.length) return err('Add contacts first (step 1).');
  if (draft.mode === 'send' && !msgs.length && !attachments.length) return err('Write a message or add a file (steps 2–3).');
  if (!(Number(o.delayMin) >= 5) || !(Number(o.delayMax) >= Number(o.delayMin))) return err('Delays must be at least 5 seconds, and max must be ≥ min.');
  let scheduledAt = null;
  if (draft.when === 'later') {
    scheduledAt = new Date(draft.schedAt).getTime();
    if (!scheduledAt || scheduledAt < Date.now() + 30000) return err('Pick a schedule time in the future.');
  }
  if (campaign && ['running', 'paused', 'scheduled'].includes(campaign.status)) return err('A campaign is already active. Stop it in Live progress first.');
  if (draft.mode === 'send') {
    const r = analyzeMessages(draft.messages, { contacts: contacts.length, optOut: o.addOptOut, attachments: attachments.length });
    if (r.level === 'high' && !confirm('The spam-risk check says HIGH. Messages like this get reported more often, which is the main cause of bans.\n\nStart anyway?')) return;
  }
  const what = draft.mode === 'validate' ? `Check ${contacts.length} numbers` : `Send to ${contacts.length} contacts`;
  if (!confirm(`${what}${scheduledAt ? ' at ' + new Date(scheduledAt).toLocaleString() : ' now'}?\n\nKeep WhatsApp Web open while it runs.`)) return;

  const id = uid();
  await store.set({ ['att_' + id]: draft.mode === 'send' ? attachments : [] });
  const c = {
    id, name: draft.name || `Campaign ${new Date().toLocaleDateString()}`, mode: draft.mode,
    contacts: contacts.map(x => ({ phone: x.phone, name: x.name, fields: x.fields })),
    messages: msgs,
    attachments: draft.mode === 'send' ? attachments.map(a => ({ name: a.name, type: a.type, size: a.size, caption: a.caption || '' })) : [],
    settings: campaignSettings(), scheduledAt,
  };
  const r = await send({ type: 'ws_start', campaign: c });
  if (!r || !r.ok) return err((r && r.error) || 'Could not start the campaign.');
  toast(scheduledAt ? 'Campaign scheduled ⏰' : 'Campaign started 🚀');
  show('live');
});

$('#resetDraft').addEventListener('click', async () => {
  if (!confirm('Clear contacts, message and files from this draft?')) return;
  draft = freshDraft(); attachments = []; contacts = [];
  await store.set({ draft, att_draft: [] });
  renderComposer();
});

// ---------- live ----------
const STATUS_LABEL = { sent: 'Sent', valid: 'On WhatsApp', failed: 'Failed', invalid: 'Not on WhatsApp', skipped: 'Skipped', not_sent: 'Not sent', pending: 'Pending', current: 'In progress', replied: 'Replied', no_reply: 'No reply' };
const CAT_LABEL = { interested: 'Interested', unsubscribe: 'Unsubscribed', not_interested: 'Not interested', replied: 'Replied' };
const FILTERS = {
  send: [['', 'All'], ['sent', 'Sent'], ['failed', 'Failed'], ['invalid', 'Not on WhatsApp'], ['skipped', 'Skipped'], ['pending', 'Pending']],
  validate: [['', 'All'], ['valid', 'On WhatsApp'], ['invalid', 'Not on WhatsApp'], ['failed', 'Failed'], ['pending', 'Pending']],
  track: [['', 'All'], ['replied', 'Replied'], ['no_reply', 'No reply'], ['failed', 'Failed'], ['pending', 'Pending']],
};
function statusOf(c, i) {
  const r = c.results && c.results[i];
  if (r) return r.status;
  if (c.inFlight && c.inFlight.index === i) return 'current';
  return 'pending';
}
let liveMode = null;
function renderLive() {
  const c = campaign;
  const active = c && ['running', 'paused', 'scheduled'].includes(c.status);
  $('#navLiveBadge').hidden = !active;
  if (active) $('#navLiveBadge').textContent = c.status === 'running' ? `${c.index}/${c.contacts.length}` : c.status;
  if ($('#view-live').hidden) return;
  $('#liveEmpty').hidden = !!c; $('#liveBody').hidden = !c;
  $('#btnPause').hidden = !c || !['running', 'scheduled'].includes(c.status);
  $('#btnResume').hidden = !c || c.status !== 'paused';
  $('#btnStop').hidden = !active;
  $('#liveClear').hidden = !c || active;
  $('#btnTrack').hidden = !c || active || c.mode !== 'send' || !(c.counts && c.counts.sent);
  if (!c) { $('#liveTitle').textContent = 'Live progress'; $('#liveSub').textContent = 'No campaign running.'; return; }
  if (liveMode !== c.mode) {
    liveMode = c.mode;
    $('#liveFilter').innerHTML = FILTERS[c.mode].map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  }
  $('#liveTitle').textContent = c.name;
  $('#liveSub').textContent = `${c.mode === 'validate' ? 'Number check' : c.mode === 'track' ? 'Reply & read-status check' : 'Message campaign'} · ${c.contacts.length} contacts · created ${new Date(c.createdAt).toLocaleString()}`;
  const pill = $('#liveStatus');
  pill.textContent = c.status; pill.className = 'status-pill ' + c.status;
  $('#liveNote').textContent = c.note || '';
  const total = c.contacts.length, done = Math.min(c.index, total);
  $('#liveFill').style.width = (total ? done / total * 100 : 0) + '%';
  const n = c.counts || {};
  const tiles = c.mode === 'validate'
    ? [['On WhatsApp', n.valid], ['Not on WhatsApp', n.invalid], ['Failed', n.failed], ['Done', done], ['Remaining', total - done]]
    : c.mode === 'track'
      ? [['Replied', n.replied], ['Interested', n.cat_interested], ['Unsubscribed', n.cat_unsubscribe], ['Read', n.rcpt_read], ['Remaining', total - done]]
      : [['Sent', n.sent], ['Failed', n.failed], ['Not on WhatsApp', n.invalid], ['Skipped', n.skipped], ['Remaining', total - done]];
  $('#liveTiles').innerHTML = tiles.map(([l, v]) => `<div class="tile"><b>${v || 0}</b><span>${l}</span></div>`).join('');
  updateCountdown();

  const filter = $('#liveFilter').value;
  const rows = [];
  for (let i = 0; i < c.contacts.length && rows.length < 3000; i++) {
    const st = statusOf(c, i);
    if (filter && st !== filter && !(filter === 'pending' && st === 'current')) continue;
    const r = (c.results && c.results[i]) || {};
    const k = c.contacts[i];
    const detail = c.mode === 'track'
      ? `${r.receipt ? '<span class="hint">' + esc(r.receipt) + '</span> ' : ''}${r.category ? `<span class="cat ${r.category}">${CAT_LABEL[r.category]}</span> ` : ''}${esc(r.reply || '')}`
      : esc(r.error || '');
    rows.push(`<tr><td>${i + 1}</td><td>${formatPhone(k.phone)}</td><td>${esc(k.name)}</td><td><span class="st ${st}">${STATUS_LABEL[st] || st}</span></td><td>${r.time ? new Date(r.time).toLocaleTimeString() : ''}</td><td class="wrap">${detail}</td></tr>`);
  }
  $('#liveTable').innerHTML = `<tr><th>#</th><th>Number</th><th>Name</th><th>Status</th><th>Time</th><th>${c.mode === 'track' ? 'Read status · reply' : 'Details'}</th></tr>` + rows.join('');
}
function updateCountdown() {
  const c = campaign;
  let t = '';
  if (c && c.status === 'running' && c.nextAt && !c.inFlight) { const s = Math.ceil((c.nextAt - Date.now()) / 1000); if (s > 0) t = `Next in ${fmtDur(s)}`; }
  else if (c && c.status === 'running' && c.inFlight) t = c.mode === 'send' ? 'Sending…' : 'Working…';
  else if (c && c.status === 'scheduled') t = `Starts ${new Date(c.scheduledAt).toLocaleString()}`;
  $('#liveNext').textContent = t;
}
setInterval(() => { if (!$('#view-live').hidden) updateCountdown(); }, 1000);

$('#liveFilter').addEventListener('change', renderLive);
$('#btnPause').addEventListener('click', () => send({ type: 'ws_pause' }));
$('#btnResume').addEventListener('click', async () => { const r = await send({ type: 'ws_resume' }); if (!r.ok) toast(r.error || 'Could not resume'); });
$('#btnStop').addEventListener('click', () => { if (confirm('Stop this campaign? Remaining contacts will not be messaged.')) send({ type: 'ws_stop' }); });
$('#liveClear').addEventListener('click', async () => { await send({ type: 'ws_clear' }); campaign = null; renderLive(); });
$('#liveExport').addEventListener('click', () => campaign && exportReport(historyEntry(campaign.id) || campaign));
$('#btnTrack').addEventListener('click', () => campaign && startTracking(campaign.id));
$('#liveRetry').addEventListener('click', () => {
  if (!campaign) return;
  const failed = campaign.contacts.filter((k, i) => ['failed', 'not_sent', 'pending'].includes(statusOf(campaign, i)));
  if (!failed.length) return toast('Nothing to retry.');
  followUp(failed, `Retry of ${campaign.name}`, campaign.messages);
});

async function startTracking(sourceId) {
  const src = historyEntry(sourceId);
  const n = src ? (src.counts && src.counts.sent) || 0 : 0;
  if (!confirm(`Open the ${n} chats from this campaign (nothing is sent) to read their ticks and replies?\n\nPeople who replied STOP are blocklisted automatically. Takes about ${fmtDur(n * 20)}.`)) return;
  const r = await send({ type: 'ws_track', sourceId });
  if (!r || !r.ok) return toast((r && r.error) || 'Could not start.', 6000);
  toast(`Checking replies for ${r.count} contacts…`);
  show('live');
}
function followUp(list, label, messages) {
  const keys = [...new Set(list.flatMap(k => Object.keys(k.fields || {})))].filter(k => k !== 'phone' && k !== 'name');
  const rows = [['phone', 'name', ...keys], ...list.map(k => ['+' + k.phone, k.name || '', ...keys.map(x => (k.fields || {})[x] ?? '')])];
  draft.source = { rows, fileName: label, hasHeader: true, phoneCol: 0, nameCol: 1, countryCode: settings.countryCode };
  draft.name = label;
  if (messages && messages.length) { draft.messages = [...messages]; draft.active = 0; }
  draft.mode = 'send';
  renderComposer(); show('compose');
  toast(`${list.length} contacts loaded – edit the message and start`);
}

function exportReport(c) {
  const keys = [...new Set(c.contacts.flatMap(k => Object.keys(k.fields || {})))].filter(k => k !== 'phone' && k !== 'name');
  const tr = c.tracking || {};
  const rows = [['#', 'phone', 'name', 'status', 'time', 'details', 'variation', 'message', 'read status', 'reply', 'reply type', ...keys]];
  c.contacts.forEach((k, i) => {
    const r = (c.results && c.results[i]) || {};
    const t = tr[k.phone] || (c.mode === 'track' ? r : {});
    rows.push([i + 1, '+' + k.phone, k.name || '', STATUS_LABEL[statusOf(c, i)] || statusOf(c, i), r.time ? new Date(r.time).toLocaleString() : '',
      r.error || '', r.variant === null || r.variant === undefined ? '' : r.variant + 1, r.text || '', t.receipt || '', t.reply || '', CAT_LABEL[t.category] || '',
      ...keys.map(x => (k.fields || {})[x] ?? '')]);
  });
  const safe = c.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'campaign';
  download(`wavesend_${safe}_${todayKey(c.createdAt)}.csv`, toCSV(rows));
}

// ---------- reports & insights ----------
const historyEntry = (id) => history.find(h => h.id === id) || (campaign && campaign.id === id ? campaign : null);
function trackSummary(h) {
  const t = h.tracking || {};
  const vals = Object.values(t);
  const sent = (h.counts && h.counts.sent) || 0;
  return {
    tracked: vals.length, sent,
    replied: vals.filter(v => v.status === 'replied').length,
    interested: vals.filter(v => v.category === 'interested').length,
    unsub: vals.filter(v => v.category === 'unsubscribe').length,
    read: vals.filter(v => v.receipt === 'read').length,
  };
}
function renderHistory() {
  const head = '<tr><th>Date</th><th>Campaign</th><th>Type</th><th>Contacts</th><th>Sent / OK</th><th>Failed</th><th>Not on WA</th><th>Read</th><th>Replied</th><th>Interested</th><th>Status</th><th></th></tr>';
  const rows = history.map((c, i) => {
    const n = c.counts || {};
    const t = trackSummary(c);
    const tr = c.mode === 'send' && t.tracked;
    return `<tr><td>${new Date(c.createdAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</td><td class="wrap">${esc(c.name)}</td><td>${c.mode === 'validate' ? 'Check' : c.mode === 'track' ? 'Replies' : 'Send'}</td>
      <td>${c.contacts.length}</td><td>${(c.mode === 'validate' ? n.valid : c.mode === 'track' ? n.replied : n.sent) || 0}</td><td>${n.failed || 0}</td><td>${n.invalid || 0}</td>
      <td>${tr ? pct(t.read, t.tracked) + '%' : '–'}</td><td>${tr ? `${t.replied} (${pct(t.replied, t.tracked)}%)` : '–'}</td><td>${tr ? t.interested : '–'}</td>
      <td><span class="st ${c.status === 'completed' ? 'sent' : 'failed'}">${c.status}</span></td>
      <td class="actions"><button class="btn small ghost" data-exp="${i}">CSV</button>
        ${c.mode === 'send' ? `<button class="btn small ghost" data-ins="${i}">Insights</button> <button class="btn small ghost" data-track="${i}">${tr ? 'Re-check' : 'Check'} replies</button>` : ''}
        <button class="btn small ghost" data-reuse="${i}">Reuse</button></td></tr>`;
  }).join('');
  $('#histTable').innerHTML = head + (rows || '<tr><td colspan="12" class="hint">No campaigns yet.</td></tr>');
}
$('#histTable').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const h = history[Number(b.dataset.exp ?? b.dataset.ins ?? b.dataset.track ?? b.dataset.reuse)];
  if (!h) return;
  if (b.dataset.exp !== undefined) exportReport(h);
  if (b.dataset.ins !== undefined) renderInsights(h);
  if (b.dataset.track !== undefined) startTracking(h.id);
  if (b.dataset.reuse !== undefined) {
    const pick = h.mode === 'validate' ? h.contacts.filter((k, i) => statusOf(h, i) === 'valid') : h.contacts;
    followUp(pick, `Copy of ${h.name}`, h.messages);
  }
});

function renderInsights(h) {
  const box = $('#insights');
  box.hidden = false;
  const t = trackSummary(h);
  const tr = h.tracking || {};
  const results = h.results || [];
  const sentList = h.contacts.filter((k, i) => results[i] && results[i].status === 'sent');
  // per-variation stats
  const vars = (h.messages || []).map((m, vi) => {
    const idx = h.contacts.map((k, i) => i).filter(i => results[i] && results[i].status === 'sent' && results[i].variant === vi);
    const tracked = idx.filter(i => tr[h.contacts[i].phone]);
    const replied = tracked.filter(i => tr[h.contacts[i].phone].status === 'replied').length;
    const interested = tracked.filter(i => tr[h.contacts[i].phone].category === 'interested').length;
    const unsub = tracked.filter(i => tr[h.contacts[i].phone].category === 'unsubscribe').length;
    return { vi, m, sent: idx.length, tracked: tracked.length, replied, interested, unsub, rate: pct(replied, tracked.length) };
  });
  const best = t.tracked ? vars.reduce((a, b) => (b.tracked >= 5 && b.rate > (a ? a.rate : -1) ? b : a), null) : null;
  const seg = (fn) => h.contacts.filter(k => fn(tr[k.phone], k));
  const segments = [
    ['Didn\'t reply', seg((x) => x && x.status === 'no_reply')],
    ['Replied', seg((x) => x && x.status === 'replied' && x.category !== 'unsubscribe')],
    ['Interested', seg((x) => x && x.category === 'interested')],
    ['Not read yet', seg((x) => x && x.receipt !== 'read' && x.status !== 'replied')],
    ['Failed / not sent', h.contacts.filter((k, i) => ['failed', 'not_sent'].includes(statusOf(h, i)))],
  ];
  box.innerHTML = `<div class="card-head"><h2>Insights – ${esc(h.name)}</h2><span class="spacer"></span><button class="btn small ghost" id="insClose">Close</button></div>
    ${t.tracked ? `<div class="tiles">
      <div class="tile"><b>${t.sent}</b><span>Sent</span></div>
      <div class="tile"><b>${pct(t.read, t.tracked)}%</b><span>Read</span></div>
      <div class="tile"><b>${pct(t.replied, t.tracked)}%</b><span>Reply rate</span></div>
      <div class="tile"><b>${t.interested}</b><span>Interested</span></div>
      <div class="tile"><b>${t.unsub}</b><span>Unsubscribed</span></div></div>`
      : `<p class="hint">Click <b>Check replies</b> (a few hours after sending) to see read status, replies and which variation works best.</p>`}
    <h3>Message variations (A/B test)</h3>
    <table class="var-table"><tr><th>#</th><th>Message</th><th>Sent</th><th>Replied</th><th>Reply rate</th><th>Interested</th><th>Unsub.</th></tr>
    ${vars.map(v => `<tr><td>${v.vi + 1}${best && best.vi === v.vi ? ' 🏆' : ''}</td><td>${esc(v.m.slice(0, 140))}${v.m.length > 140 ? '…' : ''}</td><td>${v.sent}</td><td>${v.tracked ? v.replied : '–'}</td><td>${v.tracked ? v.rate + '%' : '–'}</td><td>${v.tracked ? v.interested : '–'}</td><td>${v.tracked ? v.unsub : '–'}</td></tr>`).join('')}
    </table>
    ${best ? `<p class="hint">🏆 Variation ${best.vi + 1} gets the most replies – use it (or its style) next time.</p>` : ''}
    <h3>Follow up with a segment</h3>
    <div class="seg-row">${segments.map(([l, list], i) => `<button class="btn small ${list.length ? '' : 'ghost'}" data-seg="${i}" ${list.length ? '' : 'disabled'}>${l} (${list.length})</button>`).join('')}
      <button class="btn small ghost" id="insReplies" ${t.replied ? '' : 'disabled'}>Download replies CSV</button></div>`;
  $('#insClose').onclick = () => (box.hidden = true);
  $$('[data-seg]', box).forEach(b => b.addEventListener('click', () => {
    const [label, list] = segments[Number(b.dataset.seg)];
    followUp(list, `Follow-up (${label.toLowerCase()}) – ${h.name}`, []);
  }));
  $('#insReplies').onclick = () => download(`replies_${keyify(h.name)}.csv`, toCSV([['phone', 'name', 'reply type', 'reply', 'read status'],
    ...h.contacts.filter(k => tr[k.phone] && tr[k.phone].status === 'replied').map(k => ['+' + k.phone, k.name, CAT_LABEL[tr[k.phone].category] || '', tr[k.phone].reply, tr[k.phone].receipt])]));
  box.scrollIntoView({ behavior: 'smooth' });
  void sentList;
}

// ---------- Safety Shield ----------
async function computeHealth() {
  const s = { ...settings, ...draft.options };
  const recs = [];
  let score = 100;
  const add = (pts, level, text, fix) => { score -= pts; recs.push({ level, text, fix }); };
  const recent = history.filter(h => h.mode === 'send').slice(0, 5);
  const tot = recent.reduce((a, h) => { const n = h.counts || {}; a.sent += n.sent || 0; a.inv += n.invalid || 0; a.fail += n.failed || 0; return a; }, { sent: 0, inv: 0, fail: 0 });
  const processed = tot.sent + tot.inv + tot.fail;
  const tr = recent.map(trackSummary).reduce((a, t) => ({ tracked: a.tracked + t.tracked, replied: a.replied + t.replied, unsub: a.unsub + t.unsub }), { tracked: 0, replied: 0, unsub: 0 });
  const warned = [...history, campaign].filter(Boolean).some(h => /WhatsApp showed a warning/.test(h.note || '') && Date.now() - (h.finishedAt || h.createdAt) < 7 * 86400000);
  if (warned) add(40, 'bad', 'WhatsApp showed a warning in the last 7 days. Pause bulk sending for a few days and only message people who know you.');
  const avg = (Number(s.delayMin) + Number(s.delayMax)) / 2;
  if (avg < 15) add(20, 'bad', `Average delay is ${Math.round(avg)} s – too fast.`, ['preset', 'Use Balanced']);
  else if (avg < 25) add(8, 'warn', `Average delay is ${Math.round(avg)} s. 25–50 s is safer for cold lists.`, ['preset', 'Use Balanced']);
  if (!s.humanTyping) add(10, 'warn', 'Human-like typing is off – instant pasting looks automated.', ['humanTyping', 'Turn on']);
  if (!s.naturalPauses) add(5, 'warn', 'Natural breaks are off.', ['naturalPauses', 'Turn on']);
  if (!Number(s.hourlyLimit)) add(10, 'warn', 'No hourly limit – bursts of messages are a red flag.', ['hourlyLimit', 'Set 40/hour']);
  if (!s.autoOptOut) add(10, 'bad', 'Opt-out detection is off – messaging people who said STOP leads to reports.', ['autoOptOut', 'Turn on']);
  if (!s.skipKnownInvalid) add(5, 'warn', 'Known non-WhatsApp numbers will be opened again.', ['skipKnownInvalid', 'Turn on']);
  if (!s.useWorkHours) add(5, 'warn', 'Sending at night looks unusual.', ['useWorkHours', 'Send 9 am–9 pm']);
  if (!Number(s.dailyLimit) || Number(s.dailyLimit) > 400) add(10, 'warn', 'Daily limit is very high or off.', ['dailyLimit', 'Set 200/day']);
  if (!s.warmupEnabled && history.filter(h => h.mode === 'send').length < 3) recs.push({ level: 'info', text: 'New number or first time sending in bulk? Turn on warm-up to ramp up slowly.', fix: ['warmup', 'Turn on warm-up'] });
  if (processed >= 20 && tot.inv / processed > 0.15) add(15, 'bad', `${pct(tot.inv, processed)}% of recent numbers weren't on WhatsApp. Run “Only check numbers” before sending.`);
  if (processed >= 20 && tot.fail / processed > 0.1) add(5, 'warn', `${pct(tot.fail, processed)}% of recent messages failed. Keep the WhatsApp tab visible while sending.`);
  if (tr.tracked >= 20 && tr.unsub / tr.tracked > 0.03) add(15, 'bad', `${pct(tr.unsub, tr.tracked)}% asked to stop. Your list or message isn't wanted by many people – that's what gets numbers reported.`);
  if (tr.tracked >= 30 && tr.replied / tr.tracked < 0.05) add(10, 'warn', `Only ${pct(tr.replied, tr.tracked)}% reply. Low engagement + high volume looks like spam. Make messages more personal and ask a question.`);
  if (!recs.filter(r => r.level !== 'info').length) recs.push({ level: 'ok', text: 'All protections are on. Keep messaging people who know you.' });
  return { score: Math.max(0, Math.min(100, score)), recs, processed, tot, tr };
}
async function applyFix(key) {
  if (key === 'preset') { draft.options.preset = 'balanced'; PACING.forEach(k => (draft.options[k] = PRESETS.balanced[k])); renderOptions(); saveDraft(); }
  else if (key === 'hourlyLimit') settings.hourlyLimit = 40;
  else if (key === 'useWorkHours') { draft.options.useWorkHours = true; draft.options.workStart = '09:00'; draft.options.workEnd = '21:00'; renderOptions(); saveDraft(); }
  else if (key === 'dailyLimit') { draft.options.dailyLimit = 200; renderOptions(); saveDraft(); }
  else if (key === 'warmup') { settings.warmupEnabled = true; settings.warmupStart = settings.warmupStart || todayKey(); }
  else settings[key] = true;
  await store.set({ settings });
  renderSafety(); renderShieldNote(); updateEstimate();
  toast('Fixed ✓');
}
async function renderSafety() {
  const s = settings;
  $('#shTyping').checked = !!s.humanTyping; $('#shPauses').checked = !!s.naturalPauses; $('#shHourly').value = s.hourlyLimit;
  $('#shWarm').checked = !!s.warmupEnabled; $('#shWarmStart').value = s.warmupStart || '';
  $('#shLocal').checked = !!s.respectLocalTime; $('#shLocalStart').value = s.localStart; $('#shLocalEnd').value = s.localEnd;
  $('#shOptOut').checked = !!s.autoOptOut; $('#shOptWords').value = s.optOutKeywords;
  $('#shInvalid').checked = !!s.skipKnownInvalid; $('#invalidCount').textContent = Object.keys(invalidLog).length;
  $('#shFails').value = s.guardFailures; $('#shInvRate').value = s.guardInvalidRate;
  const day = warmupDay(s), cap = warmupCap(s);
  $('#warmInfo').textContent = s.warmupEnabled ? (cap ? `Today is day ${day}: max ${cap}/day.` : day ? 'Warm-up complete.' : '') : '';
  const h = await computeHealth();
  updateHealthBadge(h.score);
  const color = h.score >= 80 ? '#128c4b' : h.score >= 55 ? '#b7791f' : '#c0392b';
  $('#healthGauge').style.setProperty('--p', h.score); $('#healthGauge').style.setProperty('--g', color);
  $('#healthScore').textContent = h.score;
  $('#healthTitle').textContent = h.score >= 80 ? 'Healthy – low risk' : h.score >= 55 ? 'Some risk – review below' : 'High risk – fix before sending';
  $('#healthSub').textContent = h.processed ? `Based on your settings and your last ${Math.min(5, history.filter(x => x.mode === 'send').length)} campaigns.` : 'Based on your current settings.';
  const daily = await store.get('daily', {}), hourly = await store.get('hourly', {});
  const limit = effectiveDailyLimit({ ...s, ...draft.options });
  $('#healthTiles').innerHTML = `
    <div><b>${daily.key === todayKey() ? daily.count : 0}/${limit || '∞'}</b><span>sent today</span></div>
    <div><b>${hourly.key === hourKey() ? hourly.count : 0}/${Number(s.hourlyLimit) || '∞'}</b><span>this hour</span></div>
    <div><b>${h.tr.tracked ? pct(h.tr.replied, h.tr.tracked) + '%' : '–'}</b><span>reply rate</span></div>`;
  $('#recs').innerHTML = h.recs.map((r, i) => `<li class="${r.level}"><span>${esc(r.text)}</span>${r.fix ? `<button class="btn small" data-fix="${r.fix[0]}">${esc(r.fix[1])}</button>` : ''}</li>`).join('');
  const log = await store.get('dailyLog', {});
  const days = [...Array(14).keys()].reverse().map(d => { const t = Date.now() - d * 86400000; return [todayKey(t), new Date(t)]; });
  const max = Math.max(1, ...days.map(([k]) => log[k] || 0));
  $('#spark').innerHTML = days.map(([k, d]) => `<div style="height:${Math.max(2, (log[k] || 0) / max * 100)}%" title="${k}: ${log[k] || 0}"><span>${d.getDate()}</span></div>`).join('');
}
function updateHealthBadge(score) {
  const b = $('#navHealth');
  b.textContent = score;
  b.className = 'health-badge ' + (score >= 80 ? 'good' : score >= 55 ? 'mid' : 'bad');
}
$('#recs').addEventListener('click', (e) => { const b = e.target.closest('[data-fix]'); if (b) applyFix(b.dataset.fix); });
$('#clearInvalid').addEventListener('click', async (e) => {
  e.preventDefault();
  if (!confirm('Forget all numbers remembered as not on WhatsApp?')) return;
  invalidLog = {}; await store.set({ invalidLog }); renderSafety(); recompute();
});
$('#saveShield').addEventListener('click', async () => {
  Object.assign(settings, {
    humanTyping: $('#shTyping').checked, naturalPauses: $('#shPauses').checked, hourlyLimit: Number($('#shHourly').value) || 0,
    warmupEnabled: $('#shWarm').checked, warmupStart: $('#shWarmStart').value || (settings.warmupStart || (($('#shWarm').checked) ? todayKey() : '')),
    respectLocalTime: $('#shLocal').checked, localStart: $('#shLocalStart').value || '09:00', localEnd: $('#shLocalEnd').value || '21:00',
    autoOptOut: $('#shOptOut').checked, optOutKeywords: $('#shOptWords').value,
    skipKnownInvalid: $('#shInvalid').checked, guardFailures: Math.max(1, Number($('#shFails').value) || 3), guardInvalidRate: Number($('#shInvRate').value) || 40,
  });
  await store.set({ settings });
  renderSafety(); renderShieldNote(); updateEstimate(); recompute();
  toast('Protection settings saved');
});

// ---------- Automation ----------
function renderAutomation() {
  const a = autoReply;
  $('#arOn').checked = !!a.enabled; $('#arIdle').value = a.idleSeconds || 45; $('#arCool').value = a.cooldownHours || 12;
  $('#arDefault').value = a.defaultReply || ''; $('#arOptReply').value = a.optOutReply || ''; $('#arGroups').checked = a.skipGroups !== false;
  const rules = a.rules && a.rules.length ? a.rules : [{ keywords: 'price, rate, how much, kitna', reply: 'Hi {{first_name|there}}! Here is our price list: …' }];
  $('#arRules').innerHTML = rules.map((r, i) => ruleRow(r, i)).join('');
  $('#toolBlur').checked = !!settings.blur;
  store.get('arStats', { replies: 0, optouts: 0 }).then(st => ($('#arStats').textContent = `${st.replies} auto-replies sent · ${st.optouts} opt-outs caught`));
}
const ruleRow = (r, i) => `<div class="ar-rule" data-rule="${i}"><textarea class="kw" placeholder="If message contains… (comma-separated)">${esc(r.keywords)}</textarea><textarea class="rp" placeholder="Reply with… ({{name}} works)">${esc(r.reply)}</textarea><button title="Remove">✕</button></div>`;
$('#arAdd').addEventListener('click', () => $('#arRules').insertAdjacentHTML('beforeend', ruleRow({ keywords: '', reply: '' }, $$('.ar-rule').length)));
$('#arRules').addEventListener('click', (e) => { if (e.target.tagName === 'BUTTON') e.target.closest('.ar-rule').remove(); });
$('#arSave').addEventListener('click', async () => {
  autoReply = {
    enabled: $('#arOn').checked, idleSeconds: Number($('#arIdle').value) || 45, cooldownHours: Number($('#arCool').value) || 12,
    defaultReply: $('#arDefault').value.trim(), optOutReply: $('#arOptReply').value.trim(), skipGroups: $('#arGroups').checked,
    rules: $$('.ar-rule').map(el => ({ keywords: $('.kw', el).value.trim(), reply: $('.rp', el).value.trim() })).filter(r => r.keywords && r.reply),
  };
  await store.set({ autoReply });
  toast(autoReply.enabled ? 'Auto-reply is on – keep WhatsApp Web open' : 'Auto-reply saved (off)');
});
$('#toolBlur').addEventListener('change', async (e) => { settings.blur = e.target.checked; await store.set({ settings }); });

// ---------- templates page ----------
function renderTemplates() {
  $('#tplList').innerHTML = templates.length ? templates.map(t => `<div class="tpl"><b>${esc(t.name)}</b>
      <span class="hint">${t.messages.length} variation${t.messages.length === 1 ? '' : 's'} · ${new Date(t.createdAt).toLocaleDateString()}</span>
      <pre>${esc(t.messages[0])}</pre>
      <div class="actions"><button class="btn small primary" data-use="${t.id}">Use</button><button class="btn small danger" data-del="${t.id}">Delete</button></div></div>`).join('')
    : '<div class="empty">No templates yet. Write a message in New campaign and click “Save as template”.</div>';
}
$('#tplList').addEventListener('click', async (e) => {
  const use = e.target.closest('[data-use]'), del = e.target.closest('[data-del]');
  if (use) { useTemplate(templates.find(t => t.id === use.dataset.use)); show('compose'); }
  if (del && confirm('Delete this template?')) { templates = templates.filter(t => t.id !== del.dataset.del); await store.set({ templates }); renderTemplates(); renderTemplateSelect(); }
});

// ---------- settings page ----------
async function renderSettings() {
  $('#sCC').value = settings.countryCode; $('#sLen').value = settings.localLength; $('#sOpen').value = settings.openMethod || 'fast';
  $('#blocklist').value = blocklist.map(p => '+' + p).join('\n');
  $('#blockCount').textContent = `${blocklist.length} numbers`;
  $('#sentLogCount').textContent = Object.keys(await store.get('sentLog', {})).length;
}
$('#saveSettings').addEventListener('click', async () => {
  settings.countryCode = $('#sCC').value.replace(/\D/g, ''); settings.localLength = Number($('#sLen').value) || 10; settings.openMethod = $('#sOpen').value;
  await store.set({ settings });
  if (draft.source) draft.source.countryCode = settings.countryCode;
  renderMapping(); recompute();
  toast('Defaults saved');
});
$('#saveBlock').addEventListener('click', async () => {
  blocklist = [...new Set($('#blocklist').value.split(/[\n,;]+/).map(x => normalizePhone(x, settings.countryCode, settings.localLength)).filter(Boolean))];
  await store.set({ blocklist });
  renderSettings(); recompute();
  toast(`Blocklist saved (${blocklist.length} numbers)`);
});
$('#clearSentLog').addEventListener('click', async () => {
  if (!confirm('Forget which numbers you have messaged before?')) return;
  await store.set({ sentLog: {} }); renderSettings(); toast('Sent history cleared');
});
const BACKUP_KEYS = ['settings', 'templates', 'blocklist', 'history', 'autoReply', 'invalidLog', 'sentLog', 'dailyLog'];
$('#backupBtn').addEventListener('click', async () => {
  const data = await chrome.storage.local.get(BACKUP_KEYS);
  download(`wavesend_backup_${todayKey()}.json`, JSON.stringify({ app: 'WaveSend', version: 2, ...data }), 'application/json');
});
$('#restoreFile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (data.app !== 'WaveSend') throw new Error('not a WaveSend backup');
    const out = {}; BACKUP_KEYS.forEach(k => { if (data[k] !== undefined) out[k] = data[k]; });
    await store.set(out);
    toast('Backup restored – reloading'); setTimeout(() => location.reload(), 800);
  } catch (err) { toast('Could not restore: ' + err.message, 6000); }
});
$('#openWa').addEventListener('click', () => send({ type: 'ws_open_wa' }));
$('#diagBtn').addEventListener('click', async () => {
  $('#diagBtn').disabled = true; $('#diagBtn').textContent = 'Checking…';
  const r = await send({ type: 'ws_diagnose' });
  $('#diagBtn').disabled = false; $('#diagBtn').textContent = 'Diagnose WhatsApp Web';
  if (!r || !r.ok) return toast((r && r.error) || 'Open WhatsApp Web first, then try again.', 6000);
  const rep = r.report;
  const okRow = (label, ok, note = '') => `<tr><td>${ok ? '✅' : '❌'}</td><td>${label}</td><td class="hint">${esc(note)}</td></tr>`;
  const text = JSON.stringify(rep, null, 2);
  modal('WhatsApp Web diagnostics', `<table>
    ${okRow('Logged in to WhatsApp Web', rep.loggedIn, rep.qrVisible ? 'QR code visible – scan it' : '')}
    ${okRow('WaveSend page helper loaded (needed for attachments)', rep.pageHelper === 'ok', rep.pageHelper === 'ok' ? '' : 'Reload the WhatsApp tab')}
    ${okRow('A chat is open', rep.chatOpen, rep.chatOpen ? '' : 'Open any chat and run Diagnose again')}
    ${okRow('Message box found', rep.composeSelectors.length > 0)}
    ${okRow('Attach (+) button found', rep.attachSelectors.length > 0, rep.footerIcons.join(', '))}
    ${okRow('“Photos & videos” menu item found', rep.attachMenuMediaItem)}
    ${okRow('“Document” menu item found', rep.attachMenuDocItem)}
    ${okRow('Messages in the open chat can be read (needed for STOP detection, replies, auto-reply)', rep.messagesInChat && rep.messagesInChat.found > 0, rep.messagesInChat ? `${rep.messagesInChat.found} found` + (rep.messagesInChat.found ? '' : ' – open a chat that has messages') : '')}
    ${typeof rep.rehearsal === 'object' ? okRow('Attachment rehearsal: preview opened (test image, not sent)', rep.rehearsal.previewSendButton !== 'NOT FOUND', `step: ${rep.rehearsal.attachStep}; picker caught: ${rep.rehearsal.helperCaughtPicker}; button: ${rep.rehearsal.previewSendButton.label || ''}`) : okRow('Attachment rehearsal', false, rep.rehearsal || '')}
    ${typeof rep.rehearsal === 'object' && rep.rehearsal.previewSendButton !== 'NOT FOUND' ? okRow('Rehearsal preview closed again', rep.rehearsal.cancelled === true, rep.rehearsal.cancelled === true ? '' : 'Close the preview in WhatsApp manually (✕)') : ''}
    </table><p class="hint">WhatsApp Web ${esc(rep.waVersion)} · WaveSend ${esc(rep.extension)}. Copy the full report and share it if something shows ❌ or sending still fails.</p>
    <pre style="max-height:260px;overflow:auto;background:#f6f8f7;padding:10px;border-radius:8px;font-size:11.5px">${esc(text)}</pre>`,
    { label: 'Copy report', onClick: () => navigator.clipboard.writeText(text).then(() => toast('Report copied')) });
});

// ---------- live updates ----------
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.campaign) { campaign = changes.campaign.newValue || null; renderLive(); }
  if (changes.history) { history = changes.history.newValue || []; if (!$('#view-history').hidden) renderHistory(); refreshHealthBadge(); }
  if (changes.daily) renderToday(changes.daily.newValue);
  if (changes.blocklist) { blocklist = changes.blocklist.newValue || []; }
  if (changes.invalidLog) invalidLog = changes.invalidLog.newValue || {};
  if (changes.settings) { settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) }; refreshHealthBadge(); }
});
function renderToday(d) {
  $('#todayCount').textContent = d && d.key === todayKey() ? d.count : 0;
  $('#todayLimit').textContent = effectiveDailyLimit({ ...settings, ...draft.options }) || '∞';
}

// ---------- init ----------
function renderComposer() {
  renderMapping(); recompute(); renderVariants(); renderFiles(); renderOptions(); renderTemplateSelect(); updatePreview(); renderRisk();
}
(async function init() {
  const got = await chrome.storage.local.get(['settings', 'blocklist', 'templates', 'campaign', 'history', 'draft', 'att_draft', 'daily', 'invalidLog', 'autoReply']);
  settings = { ...DEFAULT_SETTINGS, ...(got.settings || {}) };
  blocklist = got.blocklist || [];
  templates = got.templates || [];
  campaign = got.campaign || null;
  history = got.history || [];
  invalidLog = got.invalidLog || {};
  if (got.autoReply) autoReply = { ...autoReply, ...got.autoReply };
  draft = got.draft ? { ...freshDraft(), ...got.draft, options: { ...pickOptions(settings), ...(got.draft.options || {}) } } : freshDraft();
  if (!draft.messages || !draft.messages.length) draft.messages = [''];
  attachments = got.att_draft || [];
  renderToday(got.daily);
  renderComposer();
  computeHealth().then(h => updateHealthBadge(h.score));
  const v = location.hash.replace('#', '');
  const active = campaign && ['running', 'paused', 'scheduled'].includes(campaign.status);
  show(VIEWS.includes(v) ? v : active ? 'live' : 'compose');
  renderLive();
})();
