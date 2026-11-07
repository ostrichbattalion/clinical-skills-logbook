/* Student dashboard: entries waiting to be sent, awaiting signature, and signed. */
(function () {
  'use strict';
  const L = window.Logbook;
  if (!L.configured) { L.demoNotice(); return; }
  const user = L.requireUser('student');
  if (!user) return;
  L.mountUserBar(user);
  L.mountConnectivity();

  const msg = document.getElementById('dash-msg');
  const pendingList = document.getElementById('pending-list');
  const awaitingList = document.getElementById('awaiting-list');
  const signedList = document.getElementById('signed-list');
  const requestBtn = document.getElementById('request-btn');

  if (new URLSearchParams(location.search).get('saved')) L.notice(msg, 'Entry saved to your pending list.', 'ok');
  if (new URLSearchParams(location.search).get('requested')) L.notice(msg, 'Signature request sent.', 'ok');
  if (new URLSearchParams(location.search).get('queued')) L.notice(msg, 'No connection, so the entry is saved on this phone. It uploads automatically when you have signal.', 'info');
  const outboxBox = document.getElementById('outbox');

  function renderOutbox() {
    const items = L.outbox.list();
    document.getElementById('outbox-section').hidden = items.length === 0;
    document.getElementById('outbox-count').textContent = items.length;
    outboxBox.innerHTML = '';
    for (const it of items) {
      const b = it.body;
      const li = document.createElement('li');
      li.innerHTML = `<div class="details"><strong>${b.kind === 'encounter' ? 'Patient encounter' : 'Skills session'} · ${L.esc(b.setting)}${b.encounterRef ? ' · ' + L.esc(b.encounterRef) : ''}</strong>
        <div class="sub-details">${L.esc(L.formatDate(b.performedOn))} · ${b.skills.length} skill${b.skills.length === 1 ? '' : 's'}</div>
        ${it.status === 'problem' ? `<div class="sub-details" style="color:#a12a2a">Could not upload: ${L.esc(it.error)}</div>` : '<div class="sub-details">Waiting for signal</div>'}</div>`;
      if (it.status === 'problem') {
        const del = document.createElement('button');
        del.type = 'button'; del.className = 'link-button'; del.textContent = 'Delete';
        del.addEventListener('click', () => { if (confirm('Delete this entry from the phone? It was never uploaded.')) { L.outbox.remove(it.clientId); renderOutbox(); } });
        li.appendChild(del);
      }
      outboxBox.appendChild(li);
    }
  }

  async function sync() {
    if (!L.outbox.list().some((i) => i.status === 'waiting')) return;
    const r = await L.outbox.sync();
    renderOutbox();
    if (r.uploaded) { L.notice(msg, `${r.uploaded} saved entr${r.uploaded === 1 ? 'y' : 'ies'} uploaded.`, 'ok'); load(); }
    if (r.problems) L.notice(msg, 'Some saved entries could not be uploaded. See "Saved on this phone" below.');
  }
  window.addEventListener('online', sync);
  setInterval(sync, 30000);

  const skillLine = (e) => e.skills.map((s) => {
    const n = L.esc(s.name || s.skillId) + (s.count > 1 ? ` ×${s.count}` : '');
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
      const data = await L.cachedGet('/entries');
      render(data.entries);
      document.getElementById('stale').hidden = !data.offline;
      if (data.offline) document.getElementById('stale').textContent = `No connection: showing your entries as they were at ${new Date(data.savedAt).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })}.`;
    } catch (err) { L.notice(msg, err.message); }
  }

  requestBtn.addEventListener('click', () => {
    const ids = [...pendingList.querySelectorAll('input:checked')].map((i) => i.value);
    if (ids.length) location.href = 'request_signature.html?ids=' + encodeURIComponent(ids.join(','));
  });

  renderOutbox();
  load().then(sync);
})();
