/* Student dashboard: entries waiting to be sent, awaiting signature, and signed. */
(function () {
  'use strict';
  const L = window.Logbook;
  if (!L.configured) { L.demoNotice(); return; }
  const user = L.requireUser('student');
  if (!user) return;
  L.mountUserBar(user);

  const msg = document.getElementById('dash-msg');
  const pendingList = document.getElementById('pending-list');
  const awaitingList = document.getElementById('awaiting-list');
  const signedList = document.getElementById('signed-list');
  const requestBtn = document.getElementById('request-btn');
  let names = new Map();

  if (new URLSearchParams(location.search).get('saved')) L.notice(msg, 'Entry saved to your pending list.', 'ok');
  if (new URLSearchParams(location.search).get('requested')) L.notice(msg, 'Signature request sent.', 'ok');

  const skillLine = (e) => e.skills.map((s) => {
    const n = L.esc(names.get(s.skillId) || s.skillId) + (s.count > 1 ? ` ×${s.count}` : '');
    return s.status === 'NOT_WITNESSED' ? `<s title="Not witnessed">${n}</s>` : n;
  }).join(', ');
  const title = (e) => (e.kind === 'encounter' ? 'Patient encounter' : 'Skills session') + ` · ${L.esc(e.setting)}` + (e.encounterRef ? ` · ${L.esc(e.encounterRef)}` : '');

  function li(e, extra = '') {
    const el = document.createElement('li');
    el.innerHTML = `${extra}<div class="details"><strong>${title(e)}</strong>
      <div class="sub-details">${L.esc(L.formatDate(e.performedOn))}</div>
      <div class="skills-line">${skillLine(e)}</div></div>`;
    return el;
  }

  function updateButton() {
    const n = pendingList.querySelectorAll('input:checked').length;
    requestBtn.disabled = n === 0;
    requestBtn.textContent = n ? `Request Signature for ${n} Selected` : 'Select entries to request a signature';
  }

  function render(entries) {
    const pending = entries.filter((e) => e.status === 'DRAFT' || e.status === 'RETURNED');
    const awaiting = entries.filter((e) => e.status === 'AWAITING_SIGNATURE');
    const signed = entries.filter((e) => e.status === 'SIGNED').slice(0, 20);
    document.getElementById('pending-count').textContent = pending.length;

    pendingList.innerHTML = pending.length ? '' : '<li class="empty">Nothing waiting. Log an encounter or skill above.</li>';
    for (const e of pending) {
      const id = `sel-${e.entryId}`;
      const el = li(e, `<input type="checkbox" id="${L.esc(id)}" value="${L.esc(e.entryId)}" aria-label="Select entry">`);
      if (e.status === 'RETURNED') {
        el.querySelector('strong').insertAdjacentHTML('beforeend', ' <span class="status-pill returned">Returned</span>');
        el.querySelector('.details').insertAdjacentHTML('beforeend', `<div class="sub-details">${L.esc(e.returned.by)}: “${L.esc(e.returned.reason)}”</div>`);
      }
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'link-button';
      del.textContent = 'Delete';
      del.addEventListener('click', async () => {
        if (!confirm('Delete this entry? This cannot be undone.')) return;
        try { await L.api('DELETE', `/entries/${encodeURIComponent(e.entryId)}`); load(); }
        catch (err) { L.notice(msg, err.message); }
      });
      el.appendChild(del);
      el.querySelector('input').addEventListener('change', updateButton);
      pendingList.appendChild(el);
    }

    awaitingList.innerHTML = awaiting.length ? '' : '<li class="empty">No entries waiting for a signature.</li>';
    for (const e of awaiting) {
      const el = li(e);
      el.querySelector('strong').insertAdjacentHTML('beforeend', ' <span class="status-pill awaiting">Awaiting</span>');
      el.querySelector('.details').insertAdjacentHTML('beforeend', `<div class="sub-details">Sent to ${L.esc(e.request.verifierName)}</div>`);
      awaitingList.appendChild(el);
    }

    signedList.innerHTML = signed.length ? '' : '<li class="empty">No signed entries yet.</li>';
    for (const e of signed) {
      const el = li(e, '<span class="status-icon" style="color:#28a745" aria-hidden="true">✓</span>');
      el.querySelector('.details').insertAdjacentHTML('beforeend',
        `<div class="sub-details">Signed by ${L.esc(e.signature.verifierName)} (${L.esc(e.signature.verifierRegNo)}) on ${L.esc(L.formatDate(e.signature.signedAt))}</div>`);
      signedList.appendChild(el);
    }
    updateButton();
  }

  async function load() {
    try {
      const [cat, data] = await Promise.all([names.size ? null : L.api('GET', '/catalogue'), L.api('GET', '/entries')]);
      if (cat) names = new Map(cat.skills.map((s) => [s.id, s.name]));
      render(data.entries);
    } catch (err) { L.notice(msg, err.message); }
  }

  requestBtn.addEventListener('click', () => {
    const ids = [...pendingList.querySelectorAll('input:checked')].map((i) => i.value);
    if (ids.length) location.href = 'request_signature.html?ids=' + encodeURIComponent(ids.join(','));
  });

  load();
})();
