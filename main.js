// WaveSend – runs inside WhatsApp Web's own page (MAIN world).
// When WaveSend is about to attach a file it "arms" this helper with the file. WhatsApp then opens its
// file picker as usual (Photos & videos / Document) and, instead of showing the OS dialog, the picker
// receives the armed file – exactly like a person choosing that file.
(() => {
  if (window.__waveSendMain) return;
  window.__waveSendMain = true;
  const TOKEN = 'wavesend-main-v2';
  let armed = null;

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__ws !== TOKEN) return;
    if (e.data.cmd === 'arm') {
      armed = { files: e.data.files || [], accept: e.data.accept || '', until: Date.now() + 20000 };
      window.postMessage({ __ws: TOKEN, cmd: 'armed' }, '*');
    }
    if (e.data.cmd === 'disarm') armed = null;
    if (e.data.cmd === 'ping') window.postMessage({ __ws: TOKEN, cmd: 'pong' }, '*');
  });

  function fill(input) {
    if (!armed || Date.now() > armed.until || !armed.files.length) { armed = null; return false; }
    const files = armed.files;
    armed = null;
    try {
      const dt = new DataTransfer();
      files.forEach((f) => dt.items.add(f));
      input.files = dt.files;
    } catch (err) {
      window.postMessage({ __ws: TOKEN, cmd: 'pick_error', error: String(err) }, '*');
      return true;
    }
    setTimeout(() => {
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      window.postMessage({ __ws: TOKEN, cmd: 'picked', accept: input.getAttribute('accept') || '' }, '*');
    }, 0);
    return true;
  }

  const origClick = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function () {
    if (this.type === 'file' && armed && fill(this)) return undefined;
    return origClick.apply(this, arguments);
  };
  if (HTMLInputElement.prototype.showPicker) {
    const origPicker = HTMLInputElement.prototype.showPicker;
    HTMLInputElement.prototype.showPicker = function () {
      if (this.type === 'file' && armed && fill(this)) return undefined;
      return origPicker.apply(this, arguments);
    };
  }
  // A <label> or real click on a file input also opens the picker – catch that too.
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (armed && t instanceof HTMLInputElement && t.type === 'file') { e.preventDefault(); fill(t); }
  }, true);

  // expose the WhatsApp Web version for diagnostics
  const setVersion = () => {
    try {
      const v = (window.Debug && window.Debug.VERSION) || '';
      if (v) document.documentElement.setAttribute('data-ws-wa-version', v);
      else setTimeout(setVersion, 3000);
    } catch (err) { /* ignore */ }
  };
  setTimeout(setVersion, 3000);
})();
