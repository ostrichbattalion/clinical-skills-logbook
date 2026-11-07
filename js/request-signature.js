/* Sends selected entries to a named supervisor or lecturer for sign-off. */
(function () {
  'use strict';
  const L = window.Logbook;
  if (!L.configured) { L.demoNotice(); return; }
  const user = L.requireUser('student');
  if (!user) return;
  L.mountUserBar(user);

  const msg = document.getElementById('req-msg');
  const form = document.getElementById('req-form');
  const ids = (new URLSearchParams(location.search).get('ids') || '').split(',').filter(Boolean);
  const summary = document.getElementById('selected');
  document.getElementById('count').textContent = `${ids.length} ${ids.length === 1 ? 'entry' : 'entries'}`;

  try { const last = localStorage.getItem('logbook.lastVerifier'); if (last) document.getElementById('verifier').value = last; } catch { /* ignore */ }

  L.api('GET', '/entries').then(({ entries }) => {
    const chosen = entries.filter((e) => ids.includes(e.entryId));
    summary.innerHTML = chosen.map((e) => `<li>${L.esc(L.formatDate(e.performedOn))} · ${e.kind === 'encounter' ? 'Patient encounter' : 'Skills session'} · ${L.esc(e.setting)} (${e.skills.length} skill${e.skills.length === 1 ? '' : 's'})</li>`).join('')
      || '<li class="empty">No entries selected.</li>';
  }).catch((err) => L.notice(msg, err.message));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    L.notice(msg, '');
    const email = document.getElementById('verifier').value.trim();
    if (!email) return L.notice(msg, "Enter your supervisor's or lecturer's email.");
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      await L.api('POST', '/entries/request-signature', { entryIds: ids, verifierEmail: email });
      try { localStorage.setItem('logbook.lastVerifier', email); } catch { /* ignore */ }
      location.href = 'student_pwa_dashboard.html?requested=1';
    } catch (err) {
      L.notice(msg, err.message);
      btn.disabled = false;
    }
  });
})();
