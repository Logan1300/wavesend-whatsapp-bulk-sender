const $ = (s) => document.querySelector(s);
const send = (type) => chrome.runtime.sendMessage({ type }).catch(() => ({}));

function render(c) {
  const active = c && ['running', 'paused', 'scheduled'].includes(c.status);
  $('#dot').className = 'dot ' + (active ? c.status : '');
  $('#st').textContent = !c ? 'No active campaign'
    : active ? `${c.name} – ${c.status}` : `Last: ${c.name} (${c.status})`;
  $('#prog').hidden = !c;
  $('#pause').hidden = !active || c.status === 'paused';
  $('#resume').hidden = !active || c.status !== 'paused';
  $('#stop').hidden = !active;
  if (!c) return;
  const total = c.contacts.length, done = Math.min(c.index, total);
  $('#fill').style.width = (total ? done / total * 100 : 0) + '%';
  let note = c.note || '';
  if (c.status === 'running' && c.nextAt && !c.inFlight && c.nextAt > Date.now()) {
    note = `Next in ${Math.ceil((c.nextAt - Date.now()) / 1000)} s · ` + note;
  }
  $('#note').textContent = note;
  const n = c.counts || {};
  $('#counts').innerHTML = c.mode === 'validate'
    ? `<span><b>${done}</b>/${total} checked</span><span><b>${n.valid || 0}</b> on WA</span><span><b>${n.invalid || 0}</b> not</span>`
    : c.mode === 'track'
    ? `<span><b>${done}</b>/${total} read</span><span><b>${n.replied || 0}</b> replied</span><span><b>${n.cat_interested || 0}</b> interested</span>`
    : `<span><b>${done}</b>/${total}</span><span><b>${n.sent || 0}</b> sent</span><span><b>${n.failed || 0}</b> failed</span><span><b>${n.invalid || 0}</b> invalid</span>`;
}

let current = null;
chrome.storage.local.get('campaign').then(r => { current = r.campaign || null; render(current); });
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'local' && ch.campaign) { current = ch.campaign.newValue || null; render(current); }
});
setInterval(() => current && current.status === 'running' && render(current), 1000);

$('#dash').addEventListener('click', () => { send('ws_open_dashboard'); window.close(); });
$('#wa').addEventListener('click', () => { send('ws_open_wa'); window.close(); });
$('#pause').addEventListener('click', () => send('ws_pause'));
$('#resume').addEventListener('click', () => send('ws_resume'));
$('#stop').addEventListener('click', () => { if (confirm('Stop this campaign?')) send('ws_stop'); });
