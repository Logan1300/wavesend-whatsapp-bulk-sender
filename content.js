// WaveSend – content script for web.whatsapp.com
// On-page work: open chat checks, human-like typing, sending text & files, opt-out detection,
// ban-warning detection, reply/receipt reading, auto-reply, quick replies, privacy blur, exports.
(() => {
  if (window.__waveSendLoaded) return;
  window.__waveSendLoaded = true;

  // All WhatsApp selectors live here so they are easy to update if WhatsApp changes its layout.
  const SEL = {
    compose: [
      '#main footer div[contenteditable="true"][role="textbox"]',
      '#main footer div[contenteditable="true"]',
      '#main div[contenteditable="true"][data-tab="10"]',
      '#main div[contenteditable="true"][role="textbox"]',
    ],
    sendIcon: [
      'button[aria-label="Send"]', '[aria-label="Send"]', '[data-icon="wds-ic-send-filled"]', '[data-icon="send"]',
      '[data-testid="send"]', '[data-icon="send-light"]', 'div[role="button"][aria-label="Send"]',
    ],
    attach: [
      '#main footer button[title="Attach"]', '#main footer [aria-label="Attach"]', '#main footer [data-icon="plus-rounded"]',
      '#main footer [data-icon="plus"]', '#main footer [data-icon="attach-menu-plus"]', '#main footer [data-icon="clip"]',
      '#main footer [data-testid="clip"]',
    ],
    modal: ['[data-animate-modal-popup="true"]', 'div[role="dialog"]', '[data-testid="popup-contents"]'],
    qr: ['canvas[aria-label*="scan" i]', 'canvas[aria-label*="QR" i]', '[data-ref] canvas', '[data-testid="qrcode"]'],
    side: ['#pane-side', '#side'],
    chatRow: ['#pane-side [role="listitem"]', '#pane-side [role="row"]', '#pane-side [data-testid="cell-frame-container"]'],
    unread: ['[aria-label*="unread" i]', '[data-testid="icon-unread-count"]'],
    msgText: ['span.selectable-text', '[data-pre-plain-text] span[dir]', '.copyable-text span[dir]', '[data-testid="msg-text"]'],
  };
  const WARNING_RE = /(banned|not allowed to use whatsapp|account (has been |is )?(temporarily )?(restricted|suspended|locked|blocked)|unusual activity|violat(ed|ion|ing) (our|whatsapp))/i;
  const INVALID_RE = /(invalid|not on whatsapp|isn.t on whatsapp|não está no whatsapp|inválido|no válido|ungültig|अमान्य|मान्य नहीं)/i;
  const CONFLICT_RE = /(open in another window|whatsapp is open on another|use here)/i;

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const human = (a = 400, b = 1200) => sleep(a + Math.random() * (b - a));
  const q = (list, root = document) => {
    for (const s of list) { try { const el = root.querySelector(s); if (el) return el; } catch (e) { /* */ } }
    return null;
  };
  const qa = (list, root = document) => {
    const out = new Set();
    for (const s of list) { try { root.querySelectorAll(s).forEach(e => out.add(e)); } catch (e) { /* */ } }
    return [...out];
  };
  const visible = (el) => !!el && el.isConnected && (el.offsetParent !== null || el.getClientRects().length > 0);
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const sig = (s) => String(s || '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();

  async function waitFor(fn, timeout = 15000, interval = 250) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try { const v = fn(); if (v) return v; } catch (e) { /* keep waiting */ }
      await sleep(interval);
    }
    return null;
  }
  function clickEl(el) {
    const target = el.closest('button, [role="button"]') || el;
    const opts = { bubbles: true, cancelable: true, view: window };
    target.dispatchEvent(new PointerEvent('pointerdown', opts));
    target.dispatchEvent(new MouseEvent('mousedown', opts));
    target.dispatchEvent(new PointerEvent('pointerup', opts));
    target.dispatchEvent(new MouseEvent('mouseup', opts));
    target.click();
  }
  function pressKey(el, key, extra = {}) {
    const code = key === 'Enter' ? 13 : key === 'Escape' ? 27 : 0;
    const opts = { key, code: key, keyCode: code, which: code, bubbles: true, cancelable: true, ...extra };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  }
  function hasKeyword(text, kw) {
    const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    return new RegExp(`(^|[^\\p{L}\\p{N}])${esc}($|[^\\p{L}\\p{N}])`, 'iu').test(text);
  }
  const kwList = (s) => String(s || '').split(/[,\n]/).map(x => x.trim().toLowerCase()).filter(Boolean);
  const anyKeyword = (text, kws) => kwList(kws).some(k => hasKeyword(String(text || '').toLowerCase(), k));

  const compose = () => { const el = q(SEL.compose); return visible(el) ? el : null; };

  // Text of an editor including emoji images and line breaks
  function editorText(root) {
    let out = '';
    const walk = (n) => {
      if (n.nodeType === 3) out += n.nodeValue;
      else if (n.nodeName === 'IMG') out += n.alt || '';
      else if (n.nodeName === 'BR') out += '\n';
      else if (n.nodeType === 1) {
        if (n !== root && /^(P|DIV)$/.test(n.nodeName) && out && !out.endsWith('\n')) out += '\n';
        n.childNodes.forEach(walk);
      }
    };
    walk(root);
    return out;
  }
  const lines = (s) => (String(s).trim().match(/\n/g) || []).length;
  function editorHas(el, text) {
    const got = editorText(el);
    const a = sig(got), b = sig(text);
    return a.length >= b.length * 0.9 && a.includes(b.slice(0, 30)) && lines(got) >= lines(text);
  }
  const editorEmpty = (el) => !sig(editorText(el));

  // ---------- app state ----------
  function modalInfo() {
    for (const m of qa(SEL.modal)) {
      if (!visible(m)) continue;
      const btns = [...m.querySelectorAll('button, [role="button"]')];
      let text = clean(m.innerText);
      btns.forEach(b => { const t = clean(b.innerText); if (t && text.endsWith(t)) text = clean(text.slice(0, -t.length)); });
      if (text) return { el: m, text, btn: btns[0] || null, btns };
    }
    return null;
  }
  function pageWarning() {
    const m = modalInfo();
    if (m && WARNING_RE.test(m.text)) return { kind: 'warning', text: m.text };
    if (m && CONFLICT_RE.test(m.text)) return { kind: 'conflict', text: m.text };
    if (!q(SEL.side) && document.body && WARNING_RE.test(document.body.innerText.slice(0, 3000))) {
      return { kind: 'warning', text: clean(document.body.innerText).slice(0, 200) };
    }
    return null;
  }

  // ---------- opening a chat without reloading WhatsApp ----------
  const headerText = () => clean((document.querySelector('#main header') || {}).innerText);
  const digitsOf = (s) => String(s || '').replace(/\D/g, '');
  // WhatsApp Web handles whatsapp://send links in-app (no page reload), like clicking a wa.me link in a chat.
  async function openChatByLink(phone) {
    if (!q(SEL.side)) return 'not_ready';
    const oldMain = document.querySelector('#main');
    if (oldMain) oldMain.setAttribute('data-ws-old', '1');
    const oldHeader = headerText();
    const a = document.createElement('a');
    a.href = `whatsapp://send?phone=${phone}`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    const res = await waitFor(() => {
      const m = modalInfo();
      if (m && m.btn && !/starting chat|loading/i.test(m.text)) return 'modal';
      const main = document.querySelector('#main');
      if (!main || !compose()) return null;
      if (!main.hasAttribute('data-ws-old')) return 'opened';                        // a new conversation panel
      const h = headerText();
      if (h && h !== oldHeader) return 'opened';                                       // header switched
      if (digitsOf(h).length >= 8 && digitsOf(h).endsWith(phone.slice(-9))) return 'opened'; // same number already open
      return null;
    }, 9000, 150);
    return res || 'failed';
  }

  // Resolves to 'chat' | 'invalid' | 'qr' | 'warning' | 'conflict' | 'timeout'
  async function waitForChat(timeout = 50000) {
    const end = Date.now() + timeout;
    let qrSince = 0;
    while (Date.now() < end) {
      const w = pageWarning();
      if (w) return { state: w.kind, text: w.text };
      if (compose()) return { state: 'chat' };
      const m = modalInfo();
      if (m && m.btn && !/starting chat|loading/i.test(m.text)) return { state: 'invalid', text: m.text, modal: m };
      const qr = q(SEL.qr);
      if (qr && !q(SEL.side)) {
        qrSince = qrSince || Date.now();
        if (Date.now() - qrSince > 6000) return { state: 'qr' };
      } else qrSince = 0;
      await sleep(300);
    }
    return { state: 'timeout' };
  }

  // ---------- reading the open chat ----------
  function msgTextOf(el) {
    const t = q(SEL.msgText, el);
    return clean(t ? editorText(t) : el.innerText);
  }
  // Every message has a data-id starting with "true_" (sent by you) or "false_" (received). Old class names as fallback.
  const MSG_ID = '[data-id^="true_"], [data-id^="false_"]';
  function messageEls() {
    const main = document.querySelector('#main');
    if (!main) return [];
    let els = [...main.querySelectorAll(MSG_ID)].filter(el => !(el.parentElement && el.parentElement.closest(MSG_ID)));
    if (!els.length) els = [...main.querySelectorAll('.message-in, .message-out')];
    return els;
  }
  const isOut = (el) => (el.getAttribute('data-id') || '').startsWith('true_') || el.classList.contains('message-out') || !!el.querySelector('.message-out');
  function chatMessages() {
    return messageEls().map(el => ({ el, out: isOut(el), text: msgTextOf(el) }));
  }
  const labelsIn = (el) => [...el.querySelectorAll('[aria-label]')].map(e => (e.getAttribute('aria-label') || '').trim().toLowerCase());
  function receiptOf(el) {
    const labels = labelsIn(el);
    const icons = [...el.querySelectorAll('[data-icon]')].map(e => e.getAttribute('data-icon')).join(' ');
    if (labels.includes('read') || labels.includes('played') || /dblcheck-ack/i.test(icons)) return 'read';
    if (labels.includes('delivered') || /dblcheck/i.test(icons)) return 'delivered';
    if (labels.includes('pending') || /msg-time/i.test(icons)) return 'pending';
    if (labels.includes('sent') || /msg-check/i.test(icons)) return 'sent';
    return 'unknown';
  }
  const isPending = (el) => !!el && el.isConnected && receiptOf(el) === 'pending';
  function lastOutgoing() {
    const list = messageEls().filter(isOut);
    return list[list.length - 1] || null;
  }

  // ---------- typing ----------
  function pasteText(el, text) {
    el.focus();
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }
  function caretToEnd(el) {
    el.focus();
    const s = window.getSelection();
    s.selectAllChildren(el);
    s.collapseToEnd();
  }
  async function clearEditor(el) {
    el.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    await sleep(200);
  }
  // Types in short word chunks with natural pauses (shows "typing…" to the recipient like a person).
  async function typeHuman(el, text) {
    caretToEnd(el);
    const tokens = String(text).match(/\n|[^\S\n]+|\S+/g) || [];
    const chunks = [];
    let buf = '', words = 0, target = 1 + Math.floor(Math.random() * 3);
    for (const t of tokens) {
      if (t === '\n') { if (buf) chunks.push(buf); chunks.push('\n'); buf = ''; words = 0; continue; }
      buf += t;
      if (/\S/.test(t) && ++words >= target) { chunks.push(buf); buf = ''; words = 0; target = 1 + Math.floor(Math.random() * 3); }
    }
    if (buf) chunks.push(buf);
    const total = Math.min(6000, Math.max(900, text.length * 22)) * (0.8 + Math.random() * 0.4);
    const per = total / Math.max(1, chunks.length);
    for (const ch of chunks) {
      if (ch === '\n') pressKey(el, 'Enter', { shiftKey: true });
      else document.execCommand('insertText', false, ch);
      await sleep(per * (0.5 + Math.random()));
    }
  }
  async function setText(el, text, humanLike) {
    if (humanLike) {
      await typeHuman(el, text);
      if (await waitFor(() => editorHas(el, text), 1500)) return true;
      await clearEditor(el);
    }
    pasteText(el, text);
    if (await waitFor(() => editorHas(el, text), 2500)) return true;
    await clearEditor(el);
    el.focus();
    String(text).split('\n').forEach((line, i, arr) => {
      if (line) document.execCommand('insertText', false, line);
      if (i < arr.length - 1) pressKey(el, 'Enter', { shiftKey: true });
    });
    return !!(await waitFor(() => editorHas(el, text), 2000));
  }
  async function ensureComposeText(text, prefilled, humanLike) {
    const box = compose();
    if (!box) throw new Error('Message box not found');
    if (prefilled && await waitFor(() => editorHas(box, text), 6000)) return box;
    if (!editorEmpty(box)) await clearEditor(box);
    if (!(await setText(box, text, humanLike))) throw new Error('Could not type the message');
    return box;
  }
  function findSendButton(scope) {
    const els = qa(SEL.sendIcon, scope || document).filter(visible);
    return els.length ? els[els.length - 1] : null;
  }
  async function clickSendAndConfirm(box) {
    const footer = box.closest('footer') || document.querySelector('#main footer') || document;
    const before = lastOutgoing();
    const btn = await waitFor(() => findSendButton(footer) || findSendButton(), 5000);
    if (btn) clickEl(btn); else pressKey(box, 'Enter');
    let cleared = await waitFor(() => editorEmpty(box), 6000);
    if (!cleared) { pressKey(box, 'Enter'); cleared = await waitFor(() => editorEmpty(box), 4000); }
    if (!cleared) throw new Error('Send button did not work');
    const bubble = await waitFor(() => { const m = lastOutgoing(); return m && m !== before ? m : null; }, 8000);
    if (bubble) await waitFor(() => !isPending(bubble), 20000);
  }

  // ---------- attachments ----------
  function dataUrlToFile(att) {
    const [head, b64] = att.dataUrl.split(',');
    const mime = (head.match(/data:([^;]+)/) || [])[1] || att.type || 'application/octet-stream';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], att.name, { type: mime, lastModified: Date.now() });
  }
  async function loadAttachments(key) {
    const got = await chrome.storage.local.get(key);
    return (got[key] || []).map(a => ({ ...a, file: dataUrlToFile(a) }));
  }
  const closeMenus = () => pressKey(document.activeElement || document.body, 'Escape');

  // ---- talking to the in-page helper (main.js) ----
  const MAIN_TOKEN = 'wavesend-main-v2';
  let lastArmed = 0;
  async function armPicker(file) {
    const t0 = Date.now();
    window.postMessage({ __ws: MAIN_TOKEN, cmd: 'arm', files: [file] }, '*');
    return !!(await waitFor(() => lastArmed >= t0, 1500, 20));   // wait until the page helper holds the file
  }
  const disarmPicker = () => window.postMessage({ __ws: MAIN_TOKEN, cmd: 'disarm' }, '*');
  let lastPick = 0;
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__ws !== MAIN_TOKEN) return;
    if (e.data.cmd === 'picked') lastPick = Date.now();
    if (e.data.cmd === 'armed') lastArmed = Date.now();
  });

  const MEDIA_ITEM = /photos?\s*(&|and|y|e|et|und)?\s*videos?|photo|gallery|fotos|imagens|imágenes|फ़ोटो|फोटो/i;
  const DOC_ITEM = /document|documento|dokument|दस्तावेज़|दस्तावेज/i;
  const MEDIA_ICON = /media|gallery|image|photo/i;
  const DOC_ICON = /document|doc-/i;
  function attachMenuItems() {
    const roots = qa(['[role="application"] li', '[role="menu"] [role="menuitem"]', '[role="menu"] li', 'ul li[data-animate-dropdown-item]', '[data-animate-dropdown-item]', 'div[role="button"][aria-label]']);
    return roots.filter(visible).filter(el => !el.closest('#pane-side, #side, header'));
  }
  function findMenuItem(asMedia, exclude) {
    let items = attachMenuItems();
    if (exclude) { const fresh = items.filter(el => !exclude.has(el)); if (fresh.length) items = fresh; }
    const textRe = asMedia ? MEDIA_ITEM : DOC_ITEM;
    const iconRe = asMedia ? MEDIA_ICON : DOC_ICON;
    return items.find(el => textRe.test(clean(el.innerText) + ' ' + (el.getAttribute('aria-label') || '')))
      || items.find(el => [...el.querySelectorAll('[data-icon]')].some(i => iconRe.test(i.getAttribute('data-icon'))))
      || items.find(el => { const i = el.querySelector('input[type="file"]'); return i && (asMedia ? /image|video/ : /^\*$|application|\*\/\*/).test(i.getAttribute('accept') || ''); })
      || null;
  }
  // 1) open the attach menu, 2) click "Photos & videos" / "Document", 3) the armed picker receives the file
  async function attachViaMenu(file, asMedia) {
    const btn = q(SEL.attach);
    if (!btn) return 'no_attach_button';
    const inputsBefore = new Set(document.querySelectorAll('input[type="file"]'));
    const helper = await armPicker(file);
    const t0 = Date.now();
    const oldItems = new Set(attachMenuItems());
    clickEl(btn);
    const item = await waitFor(() => findMenuItem(asMedia, oldItems), 3000, 120);
    if (item && helper) {
      const input = item.querySelector('input[type="file"]');
      clickEl(item);
      if (await waitFor(() => lastPick > t0, 2500, 100)) return 'ok';
      if (input) input.click(); // some versions keep the input inside the item
      if (await waitFor(() => lastPick > t0, 1500, 100)) return 'ok';
    }
    disarmPicker();
    // Fallback: set the file on the matching <input type=file> directly
    const inputs = [...document.querySelectorAll('input[type="file"]')];
    const fresh = inputs.filter(i => !inputsBefore.has(i));
    const pool = fresh.length ? fresh : inputs;
    const isMediaInput = (i) => /image|video/.test(i.getAttribute('accept') || '');
    const input = (asMedia ? pool.find(isMediaInput) : pool.find(i => !isMediaInput(i))) || null;
    if (!input) { closeMenus(); return item ? 'picker_not_caught' : 'menu_item_not_found'; }
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  }
  function attachViaPaste(file) {
    const box = compose();
    if (!box) return false;
    box.focus();
    const dt = new DataTransfer();
    dt.items.add(file);
    box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return true;
  }
  async function cancelPreview(sendBtn) {
    const gone = () => !sendBtn || !sendBtn.isConnected || !visible(sendBtn);
    for (let i = 0; i < 4 && !gone(); i++) {
      pressKey(document.activeElement || document.body, 'Escape');
      await sleep(500);
      const m = modalInfo();
      const discard = m && m.btns.find(b => /discard|close|cancel|remove/i.test(clean(b.innerText) + ' ' + (b.getAttribute('aria-label') || '')));
      if (discard) { clickEl(discard); await sleep(400); }
      if (gone()) break;
      const close = qa(['[aria-label="Close" i]', '[aria-label^="Remove attachment" i]', '[aria-label="Cancel" i]', '[aria-label^="Discard" i]'])
        .filter(e => visible(e) && !e.closest('#pane-side, #side') && !/send/i.test(e.getAttribute('aria-label') || '')).pop();
      if (close) { clickEl(close); await sleep(500); }
    }
    return gone();
  }
  const SEND_ANY = [...SEL.sendIcon, '[aria-label^="Send" i]', '[data-icon*="send"]'];
  async function sendAttachment(att, caption, humanLike) {
    const file = att.file;
    const asMedia = /^(image|video)\//.test(file.type) && !att.asDocument && !/gif|svg/.test(file.type);
    const before = new Set(qa(SEND_ANY));
    const isNewSend = () => qa(SEND_ANY).filter(e => !before.has(e) && visible(e)).pop() || null;
    const composeBox = compose();
    const isNewEditable = () => [...document.querySelectorAll('div[contenteditable="true"]')]
      .filter(e => e !== composeBox && visible(e) && !e.closest('#side, #pane-side')).pop() || null;

    const how = await attachViaMenu(file, asMedia);
    let opened = how === 'ok' && !!(await waitFor(isNewSend, 12000, 150));
    if (!opened) {
      closeMenus(); await sleep(300);
      if (attachViaPaste(file)) opened = !!(await waitFor(isNewSend, 8000, 150));
    }
    if (!opened) {
      const stray = qa(SEND_ANY).filter(e => !before.has(e) && visible(e)).pop();
      if (stray) await cancelPreview(stray);
      throw new Error(`Could not attach "${att.name}" (${how}). Use Help › Diagnose and send me the report.`);
    }
    await human(400, 900);
    if (caption) {
      const cap = await waitFor(isNewEditable, 3000);
      if (cap) await setText(cap, caption, humanLike);
    }
    const sendBtn = isNewSend();
    clickEl(sendBtn);
    const closed = await waitFor(() => !sendBtn.isConnected || !visible(sendBtn), 120000, 300);
    if (!closed) throw new Error(`Timed out sending "${att.name}"`);
    if (await waitFor(() => lastOutgoing(), 4000)) await waitFor(() => !isPending(lastOutgoing()), 120000, 500);
    await human(300, 800);
  }

  // ---------- main job ----------
  async function perform(job) {
    let st;
    if (job.open === 'link') {
      const o = await openChatByLink(job.phone);
      if (o === 'failed' || o === 'not_ready') return { status: 'open_failed' };
      if (o === 'modal') {
        // A popup instead of the chat: invalid number, warning or conflict. Never fall through to the old chat.
        const w = pageWarning();
        const m = modalInfo();
        if (w) st = { state: w.kind, text: w.text };
        else if (m && INVALID_RE.test(m.text)) st = { state: 'invalid', text: m.text, modal: m };
        else return { status: 'failed', error: 'Unexpected WhatsApp popup: ' + ((m && m.text) || '').slice(0, 120) };
      } else st = { state: 'chat' };
    } else st = await waitForChat(50000);
    if (st.state === 'qr') return { status: 'not_logged_in' };
    if (st.state === 'warning') return { status: 'warning', error: st.text.slice(0, 200) };
    if (st.state === 'conflict') return { status: 'conflict', error: st.text.slice(0, 200) };
    if (st.state === 'invalid') {
      if (st.modal && st.modal.btn) { await human(300, 600); clickEl(st.modal.btn); }
      return { status: 'invalid', error: st.text.slice(0, 160) || 'Number is not on WhatsApp' };
    }
    if (st.state === 'timeout') return q(SEL.side) ? { status: 'failed', error: 'Chat did not open in time' } : { status: 'not_logged_in' };
    if (job.mode === 'validate') { await human(300, 800); return { status: 'valid' }; }

    // let the conversation render
    await waitFor(() => messageEls().length, 1200, 150);
    await human(job.humanTyping ? 700 : 300, job.humanTyping ? 1600 : 700);

    if (job.mode === 'track') {
      const msgs = chatMessages();
      let idx = -1;
      const want = sig(job.matchText).slice(0, 20);
      if (want) for (let k = msgs.length - 1; k >= 0; k--) if (msgs[k].out && sig(msgs[k].text).includes(want)) { idx = k; break; }
      if (idx < 0) for (let k = msgs.length - 1; k >= 0; k--) if (msgs[k].out) { idx = k; break; }
      if (idx < 0) return { status: 'tracked', receipt: 'unknown', reply: '' };
      const replies = msgs.slice(idx + 1).filter(m => !m.out).map(m => m.text).filter(Boolean);
      return { status: 'tracked', receipt: receiptOf(msgs[idx].el), reply: replies.join(' | ').slice(0, 500) };
    }

    if (job.checkOptOut) {
      const incoming = chatMessages().filter(m => !m.out).slice(-15);
      if (incoming.some(m => anyKeyword(m.text, job.optOutKeywords))) return { status: 'optout' };
    }

    const atts = job.attachmentKey ? await loadAttachments(job.attachmentKey) : [];
    const captions = job.captions || [];
    const useCaption = job.captionMode && atts.length > 0 && job.text;
    if (job.text && !useCaption) {
      const box = await ensureComposeText(job.text, job.prefilled, job.humanTyping);
      await human(500, 1300);
      await clickSendAndConfirm(box);
    }
    for (let k = 0; k < atts.length; k++) {
      let cap = captions[k] || '';
      if (useCaption && k === 0) cap = job.text + (cap ? '\n\n' + cap : '');
      await sendAttachment(atts[k], cap, job.humanTyping);
    }
    const w = pageWarning();
    if (w && w.kind === 'warning') return { status: 'warning', error: w.text.slice(0, 200) };
    return { status: 'sent' };
  }


  // ---------- diagnostics (Help › Diagnose) ----------
  async function diagnose() {
    const attrs = (els, a) => [...new Set(els.map(e => e.getAttribute(a)).filter(Boolean))];
    const r = {
      time: new Date().toISOString(), extension: chrome.runtime.getManifest().version,
      waVersion: document.documentElement.getAttribute('data-ws-wa-version') || 'unknown',
      language: document.documentElement.lang || navigator.language, browser: navigator.userAgent.replace(/.*(Chrome\/[\d.]+).*/, '$1'),
      loggedIn: !!q(SEL.side), qrVisible: !!q(SEL.qr), chatOpen: !!document.querySelector('#main'),
    };
    let pong = false;
    const onMsg = (e) => { if (e.source === window && e.data && e.data.__ws === MAIN_TOKEN && e.data.cmd === 'pong') pong = true; };
    window.addEventListener('message', onMsg);
    window.postMessage({ __ws: MAIN_TOKEN, cmd: 'ping' }, '*');
    await sleep(300);
    window.removeEventListener('message', onMsg);
    r.pageHelper = pong ? 'ok' : 'NOT LOADED';
    r.composeSelectors = SEL.compose.filter(s => document.querySelector(s));
    r.attachSelectors = SEL.attach.filter(s => document.querySelector(s));
    r.sendSelectors = SEL.sendIcon.filter(s => document.querySelector(s));
    r.footerIcons = attrs([...document.querySelectorAll('#main footer [data-icon]')], 'data-icon');
    r.footerLabels = [...new Set([...document.querySelectorAll('#main footer [aria-label], #main footer [title]')].map(e => e.getAttribute('aria-label') || e.getAttribute('title')))];
    r.fileInputs = [...document.querySelectorAll('input[type="file"]')].map(i => i.getAttribute('accept') || '(none)');
    const msgs = chatMessages();
    r.messagesInChat = { found: msgs.length, incoming: msgs.filter(m => !m.out).length, outgoing: msgs.filter(m => m.out).length,
      byDataId: document.querySelectorAll('#main [data-id^="true_"], #main [data-id^="false_"]').length, byOldClass: document.querySelectorAll('#main .message-in, #main .message-out').length };
    const lastOut = lastOutgoing();
    r.lastOutgoing = lastOut ? { receipt: receiptOf(lastOut), labels: [...new Set(labelsIn(lastOut))].slice(0, 8), textFound: !!msgTextOf(lastOut) } : null;
    r.chatRows = qa(SEL.chatRow).length;
    r.unreadRows = qa(SEL.chatRow).filter(x => q(SEL.unread, x)).length;
    const btn = q(SEL.attach);
    if (btn && !running) {
      clickEl(btn);
      await sleep(1200);
      r.attachMenu = attachMenuItems().slice(0, 15).map(el => ({
        text: clean(el.innerText).slice(0, 40), label: el.getAttribute('aria-label') || '',
        icons: attrs([...el.querySelectorAll('[data-icon]')], 'data-icon'), input: (el.querySelector('input[type="file"]') || {}).accept || '',
      }));
      r.attachMenuMediaItem = !!findMenuItem(true);
      r.attachMenuDocItem = !!findMenuItem(false);
      r.fileInputsWithMenuOpen = [...document.querySelectorAll('input[type="file"]')].map(i => i.getAttribute('accept') || '(none)');
      closeMenus();
      await sleep(600);
      // Safe rehearsal: attach a tiny test image, look at the preview, then cancel. Never clicks Send.
      const box = compose();
      if (box && editorEmpty(box)) {
        const canvas = document.createElement('canvas'); canvas.width = 8; canvas.height = 8;
        const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
        const file = new File([blob], 'wavesend-test.png', { type: 'image/png' });
        const before = new Set(qa(SEND_ANY));
        const t0 = Date.now();
        const how = await attachViaMenu(file, true);
        const btn2 = await waitFor(() => qa(SEND_ANY).filter(e => !before.has(e) && visible(e)).pop(), 8000, 150);
        const target = btn2 && (btn2.closest('button, [role="button"]') || btn2);
        r.rehearsal = {
          attachStep: how, helperCaughtPicker: lastPick > t0,
          previewSendButton: target ? { tag: target.tagName.toLowerCase(), role: target.getAttribute('role') || '', label: target.getAttribute('aria-label') || '', icon: (target.querySelector('[data-icon]') || {}).getAttribute?.('data-icon') || '' } : 'NOT FOUND',
          captionBox: !![...document.querySelectorAll('div[contenteditable="true"]')].find(e => e !== box && visible(e) && !e.closest('#side, #pane-side')),
          cancelled: btn2 ? await cancelPreview(btn2) : 'nothing to cancel',
        };
        if (!btn2) closeMenus();
      } else r.rehearsal = 'skipped – clear the message box in the open chat first';
    } else r.attachMenu = btn ? 'busy' : 'attach button not found – open any chat first';
    return r;
  }

  // ---------- exports ----------
  function extractGroup() {
    const header = document.querySelector('#main header');
    if (!header) return { ok: false, error: 'Open a group chat in WhatsApp Web first.' };
    const title = clean((header.querySelector('span[dir="auto"]') || {}).textContent);
    const candidates = [
      ...[...header.querySelectorAll('[title]')].map(e => e.getAttribute('title')),
      ...[...header.querySelectorAll('span, div')].map(e => e.textContent),
    ].filter(t => t && t.split(',').length >= 2);
    const list = candidates.sort((a, b) => b.split(',').length - a.split(',').length)[0];
    if (!list) return { ok: false, error: 'Member list not visible yet. Wait 2–3 seconds after opening the group, then try again.' };
    const members = list.split(',').map(clean).filter(Boolean).filter(x => !/^you$/i.test(x))
      .map(label => ({ label, phone: /^\+?[\d\s\-()]{7,}$/.test(label) ? label.replace(/\D/g, '') : '' }));
    return { ok: true, group: title, members };
  }

  async function exportChats() {
    const pane = document.querySelector('#pane-side');
    if (!pane) return { ok: false, error: 'Open WhatsApp Web and wait for your chats to load.' };
    const seen = new Map();
    const grab = () => qa(SEL.chatRow).forEach(r => {
      const t = r.querySelector('span[title]');
      const label = clean(t ? t.getAttribute('title') : '');
      if (label && !seen.has(label)) seen.set(label, /^\+?[\d\s\-()]{7,}$/.test(label) ? label.replace(/\D/g, '') : '');
    });
    const start = pane.scrollTop;
    pane.scrollTop = 0; await sleep(500);
    for (let i = 0; i < 400; i++) {
      grab();
      const before = pane.scrollTop;
      pane.scrollTop = before + pane.clientHeight * 0.8;
      await sleep(450);
      if (pane.scrollTop === before) break;
    }
    grab();
    pane.scrollTop = start;
    return { ok: true, chats: [...seen].map(([label, phone]) => ({ label, phone })) };
  }

  // ---------- messaging ----------
  let running = false;
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return false;
    if (msg.type === 'ws_ping') { sendResponse({ ok: true }); return false; }
    if (msg.type === 'ws_extract_group') { sendResponse(extractGroup()); return false; }
    if (msg.type === 'ws_export_chats') { exportChats().then(sendResponse); return true; }
    if (msg.type === 'ws_diagnose') { diagnose().then(r => sendResponse({ ok: true, report: r }), e => sendResponse({ ok: false, error: String(e) })); return true; }
    if (msg.type === 'ws_perform') {
      if (running) { sendResponse({ status: 'failed', error: 'Busy with another message' }); return false; }
      running = true;
      perform(msg.job)
        .then(r => sendResponse(r))
        .catch(e => sendResponse({ status: 'failed', error: e && e.message ? e.message : String(e) }))
        .finally(() => { running = false; });
      return true;
    }
    return false;
  });

  // ---------- state shared with storage ----------
  let campaign = null, settings = {}, templates = [], autoReply = null;
  let alive = true;
  const safe = (fn) => { try { return fn(); } catch (e) { alive = false; return null; } };
  const sendBg = (m) => safe(() => chrome.runtime.sendMessage(m).catch(() => {}));

  let lastUserAction = 0;
  ['keydown', 'mousedown', 'wheel', 'touchstart'].forEach(ev => window.addEventListener(ev, (e) => { if (e.isTrusted) lastUserAction = Date.now(); }, true));

  const keep = setInterval(() => {
    if (!alive || !chrome.runtime?.id) { clearInterval(keep); return; }
    if (campaign && ['running', 'scheduled'].includes(campaign.status)) sendBg({ type: 'ws_keepalive' });
  }, 20000);

  // ---------- privacy blur ----------
  const blurStyle = document.createElement('style');
  blurStyle.textContent = `
    #pane-side img, #pane-side span[title], #pane-side [role="gridcell"] span, #main header img, #main header span[dir="auto"],
    #main .message-in, #main .message-out, #main [data-id^="true_"], #main [data-id^="false_"] { filter: blur(6px); transition: filter .15s; }
    #pane-side [role="listitem"]:hover img, #pane-side [role="listitem"]:hover span, #pane-side [role="row"]:hover span,
    #pane-side [role="row"]:hover img, #main .message-in:hover, #main .message-out:hover, #main [data-id^="true_"]:hover, #main [data-id^="false_"]:hover, #main header:hover img,
    #main header:hover span { filter: none; }`;
  function applyBlur() {
    if (settings.blur) { if (!blurStyle.isConnected) document.documentElement.appendChild(blurStyle); }
    else blurStyle.remove();
  }

  // ---------- floating pill: progress, quick replies, blur toggle ----------
  const host = document.createElement('div');
  host.id = 'wavesend-pill';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .wrap { position: fixed; left: 16px; bottom: 16px; z-index: 2147483000; font: 500 12.5px/1.35 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: #e8f5ee; }
      .pill { background: #0d1f17; border: 1px solid #1f3d2e; border-radius: 12px; padding: 8px 10px; box-shadow: 0 8px 24px rgba(0,0,0,.25); min-width: 210px; max-width: 320px; }
      .row { display: flex; align-items: center; gap: 6px; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #7f9a8b; flex: none; }
      .dot.running { background: #25d366; } .dot.paused { background: #f5b400; } .dot.scheduled { background: #66a3ff; }
      b { font-weight: 650; }
      .bar { height: 4px; background: #1f3d2e; border-radius: 4px; margin: 7px 0 5px; overflow: hidden; }
      .fill { height: 100%; background: #25d366; width: 0; transition: width .4s; }
      .note { color: #9fbfae; font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      button { all: unset; cursor: pointer; font-size: 11.5px; padding: 3px 7px; border-radius: 6px; background: #1f3d2e; color: #e8f5ee; }
      button:hover { background: #2b5440; }
      .sp { flex: 1; }
      .menu { margin-bottom: 6px; background: #0d1f17; border: 1px solid #1f3d2e; border-radius: 10px; padding: 6px; max-height: 260px; overflow: auto; width: 280px; box-shadow: 0 8px 24px rgba(0,0,0,.25); }
      .menu .it { display: block; padding: 6px 8px; border-radius: 6px; cursor: pointer; }
      .menu .it:hover { background: #1f3d2e; }
      .menu .it small { display: block; color: #9fbfae; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .muted { color: #9fbfae; padding: 6px 8px; display: block; }
      [hidden] { display: none !important; }
    </style>
    <div class="wrap">
      <div class="menu" hidden></div>
      <div class="pill">
        <div class="row"><span class="dot"></span><b>WaveSend</b><span class="count"></span><span class="sp"></span>
          <button class="qr" title="Quick replies">⚡</button><button class="blur" title="Privacy blur">👁</button><button class="toggle" hidden></button><button class="min" title="Minimise">–</button></div>
        <div class="prog" hidden><div class="bar"><div class="fill"></div></div><div class="note"></div></div>
      </div>
    </div>`;
  const $ = (s) => shadow.querySelector(s);
  let minimised = false;
  $('.toggle').addEventListener('click', () => {
    if (campaign) sendBg({ type: campaign.status === 'paused' ? 'ws_resume' : 'ws_pause' });
  });
  $('.blur').addEventListener('click', () => {
    settings.blur = !settings.blur;
    safe(() => chrome.storage.local.get('settings').then(r => chrome.storage.local.set({ settings: { ...(r.settings || {}), blur: settings.blur } })));
    applyBlur();
  });
  $('.min').addEventListener('click', () => { minimised = !minimised; render(); });
  $('.qr').addEventListener('click', () => {
    const menu = $('.menu');
    if (!menu.hidden) { menu.hidden = true; return; }
    const name = currentChatName();
    menu.innerHTML = templates.length
      ? templates.map((t, i) => `<span class="it" data-i="${i}"><b></b><small></small></span>`).join('')
      : '<span class="muted">No templates yet. Save one in the WaveSend dashboard.</span>';
    menu.querySelectorAll('.it').forEach((el) => {
      const t = templates[Number(el.dataset.i)];
      el.querySelector('b').textContent = t.name;
      el.querySelector('small').textContent = t.messages[0];
      el.addEventListener('click', async () => {
        menu.hidden = true;
        const box = compose();
        if (!box) return;
        const text = fillQuick(t.messages[Math.floor(Math.random() * t.messages.length)], name);
        pasteText(box, text);
      });
    });
    menu.hidden = false;
  });
  function currentChatName() {
    const h = document.querySelector('#main header span[dir="auto"]');
    const n = clean(h && h.textContent);
    return /^\+?[\d\s\-()]+$/.test(n) ? '' : n;
  }
  function fillQuick(tpl, name) {
    const vars = { name, first_name: name.split(/\s+/)[0] || '' };
    return String(tpl).replace(/\{\{\s*([^{}|]+?)\s*(?:\|([^{}]*))?\}\}/g, (m, k, fb) => vars[k.trim().toLowerCase()] || (fb || '').trim())
      .replace(/\{([^{}]*\|[^{}]*)\}/g, (m, b) => { const o = b.split('|'); return o[Math.floor(Math.random() * o.length)]; });
  }

  function render() {
    if (!document.querySelector(SEL.side[0]) && !document.querySelector('#main')) { host.remove(); return; }
    if (!host.isConnected) document.documentElement.appendChild(host);
    const active = campaign && ['running', 'paused', 'scheduled'].includes(campaign.status);
    $('.dot').className = 'dot ' + (active ? campaign.status : '');
    $('.toggle').hidden = !active || campaign.status === 'scheduled';
    $('.toggle').textContent = active && campaign.status === 'paused' ? 'Resume' : 'Pause';
    $('.prog').hidden = !active || minimised;
    $('.min').textContent = minimised ? '+' : '–';
    $('.blur').style.background = settings.blur ? '#2b5440' : '';
    if (!active) { $('.count').textContent = autoReply && autoReply.enabled ? '· auto-reply on' : ''; return; }
    const total = campaign.contacts ? campaign.contacts.length : 0;
    const done = Math.min(campaign.index || 0, total);
    $('.count').textContent = `${done}/${total}`;
    $('.fill').style.width = total ? (done / total * 100).toFixed(1) + '%' : '0';
    let note = campaign.note || '';
    if (campaign.status === 'running' && campaign.nextAt && !campaign.inFlight && campaign.nextAt > Date.now()) {
      const s = Math.ceil((campaign.nextAt - Date.now()) / 1000);
      note = `Next in ${s >= 60 ? Math.floor(s / 60) + 'm ' + (s % 60) + 's' : s + 's'} · ${note}`;
    }
    $('.note').textContent = note;
  }

  safe(() => chrome.storage.local.get(['campaign', 'settings', 'templates', 'autoReply']).then(r => {
    campaign = r.campaign || null; settings = r.settings || {}; templates = r.templates || []; autoReply = r.autoReply || null;
    applyBlur(); render();
  }));
  safe(() => chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local') return;
    if (ch.campaign) campaign = ch.campaign.newValue || null;
    if (ch.settings) { settings = ch.settings.newValue || {}; applyBlur(); }
    if (ch.templates) templates = ch.templates.newValue || [];
    if (ch.autoReply) autoReply = ch.autoReply.newValue || null;
    render();
  }));
  setInterval(render, 1000);

  // ---------- auto-reply (opt-in) ----------
  let arBusy = false;
  async function autoReplyTick() {
    if (!alive || arBusy || running || !autoReply || !autoReply.enabled) return;
    if (campaign && campaign.status === 'running') return;            // never interfere with a campaign
    if (Date.now() - lastUserAction < (Number(autoReply.idleSeconds) || 45) * 1000) return; // you're using WhatsApp
    const rows = qa(SEL.chatRow).filter(r => q(SEL.unread, r));
    if (!rows.length) return;
    const store = await chrome.storage.local.get(['arSeen', 'arLog', 'arStats']);
    const seen = store.arSeen || {}, log = store.arLog || {}, stats = store.arStats || { replies: 0, optouts: 0 };
    const row = rows.find(r => {
      const t = r.querySelector('span[title]');
      const key = clean(t && t.getAttribute('title'));
      return key && seen[key] !== sig(r.innerText);
    });
    if (!row) return;
    arBusy = true;
    try {
      const titleEl = row.querySelector('span[title]');
      const key = clean(titleEl.getAttribute('title'));
      const rowSig = sig(row.innerText);
      clickEl(row.firstElementChild || row);
      const opened = await waitFor(() => { const h = document.querySelector('#main header'); return h && clean(h.innerText).includes(key) ? h : null; }, 6000);
      seen[key] = rowSig;
      if (!opened) return;
      await human(1500, 3000);
      const isGroup = !!opened.querySelector('[data-icon*="group"]') || [...opened.querySelectorAll('[title]')].some(e => (e.getAttribute('title') || '').split(',').length > 2);
      if (isGroup && autoReply.skipGroups !== false) return;
      const msgs = chatMessages();
      const last = msgs[msgs.length - 1];
      if (!last || last.out) return;            // you already answered
      const phone = /^\+?[\d\s\-()]{7,}$/.test(key) ? key.replace(/\D/g, '') : '';
      let reply = '';
      if (anyKeyword(last.text, settings.optOutKeywords || 'stop, unsubscribe')) {
        if (phone) sendBg({ type: 'ws_add_blocklist', phone });
        stats.optouts++;
        reply = autoReply.optOutReply || '';
      } else {
        const rule = (autoReply.rules || []).find(r => r.keywords && r.reply && anyKeyword(last.text, r.keywords));
        reply = rule ? rule.reply : (autoReply.defaultReply || '');
        const cool = (Number(autoReply.cooldownHours) || 12) * 3600000;
        if (reply && log[key] && Date.now() - log[key] < cool && !rule) reply = '';
      }
      if (!reply) return;
      const box = compose();
      if (!box) return;
      if (!editorEmpty(box)) return;            // don't touch a draft you were writing
      await setText(box, fillQuick(reply, currentChatName()), true);
      await human(400, 1000);
      await clickSendAndConfirm(box);
      log[key] = Date.now();
      stats.replies++;
    } catch (e) {
      console.warn('[WaveSend] auto-reply', e);
    } finally {
      await safe(() => chrome.storage.local.set({ arSeen: seen, arLog: log, arStats: stats }));
      arBusy = false;
    }
  }
  setInterval(() => { autoReplyTick(); }, 8000);
})();
