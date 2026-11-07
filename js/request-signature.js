/* Student chooses how selected entries get signed: QR for the supervisor's phone, hand-over, or their queue. */
(function () {
  'use strict';
  const L = window.Logbook;
  if (!L.configured) { L.demoNotice(); return; }
  const user = L.requireUser('student');
  if (!user) return;
  L.mountUserBar(user);

  const $ = (id) => document.getElementById(id);
  const msg = $('req-msg');
  const ids = (new URLSearchParams(location.search).get('ids') || '').split(',').filter(Boolean);
  $('count').textContent = `${ids.length} ${ids.length === 1 ? 'entry' : 'entries'}`;
  $('handover-link').href = `handover.html?ids=${encodeURIComponent(ids.join(','))}`;
  let pollTimer = null, clockTimer = null;

  try { const last = localStorage.getItem('logbook.lastVerifier'); if (last) $('verifier').value = last; } catch { /* ignore */ }

  L.api('GET', '/entries').then(({ entries }) => {
    const chosen = entries.filter((e) => ids.includes(e.entryId));
    $('selected').innerHTML = chosen.map((e) => `<li>${L.esc(L.formatDate(e.performedOn))} · ${e.kind === 'encounter' ? 'Patient encounter' : 'Skills session'} · ${L.esc(e.setting)} (${e.skills.length} skill${e.skills.length === 1 ? '' : 's'})</li>`).join('')
      || '<li class="empty">No entries selected.</li>';
  }).catch((err) => L.notice(msg, err.message));

  // ---- QR code for the supervisor's own phone ----
  $('show-qr').addEventListener('click', makeCode);
  $('new-code').addEventListener('click', makeCode);

  async function makeCode() {
    L.notice(msg, '');
    stop();
    $('choices').hidden = true;
    $('qr-panel').hidden = false;
    $('qr').innerHTML = '<p class="empty">Making a code…</p>';
    $('new-code').hidden = true;
    try {
      const r = await L.api('POST', '/entries/sign-requests', { entryIds: ids });
      const url = new URL('qr_sign.html', location.href);
      url.search = '';
      url.hash = r.token;
      const qr = qrcode(0, 'M');
      qr.addData(url.toString());
      qr.make();
      $('qr').innerHTML = qr.createSvgTag({ cellSize: 6, margin: 4, scalable: true });
      $('qr').querySelector('svg').setAttribute('role', 'img');
      $('qr').querySelector('svg').setAttribute('aria-label', 'Signing code for your supervisor to scan');
      const expires = Date.parse(r.expiresAt);
      const tick = () => {
        const left = Math.max(0, Math.round((expires - Date.now()) / 1000));
        $('countdown').textContent = left ? `Code expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : 'This code has expired.';
        if (!left) { stop(); $('qr').innerHTML = ''; $('new-code').hidden = false; }
      };
      tick();
      clockTimer = setInterval(tick, 1000);
      pollTimer = setInterval(poll, 4000);
    } catch (err) {
      L.notice(msg, err.message);
      $('qr-panel').hidden = true;
      $('choices').hidden = false;
    }
  }

  async function poll() {
    try {
      const { entries } = await L.api('GET', '/entries');
      const mine = entries.filter((e) => ids.includes(e.entryId));
      const signed = mine.filter((e) => e.status === 'SIGNED');
      const returned = mine.filter((e) => e.status === 'RETURNED');
      const reviewing = mine.find((e) => e.status === 'AWAITING_SIGNATURE');
      if (reviewing) {
        $('qr').innerHTML = '';
        $('countdown').textContent = '';
        $('qr-status').textContent = `${reviewing.request.verifierName} is reviewing your entries…`;
      }
      if (signed.length + returned.length === ids.length) {
        stop();
        $('qr').innerHTML = '';
        $('countdown').textContent = '';
        const who = signed[0]?.signature?.verifierName || returned[0]?.returned?.by || 'Your supervisor';
        $('qr-status').innerHTML = `<span class="notice notice-ok" style="display:block">✓ ${L.esc(who)} signed ${signed.length}${returned.length ? ` and returned ${returned.length}` : ''}.</span>`;
        $('qr-done').hidden = false;
      }
    } catch { /* keep polling; a brief network drop shouldn't end the flow */ }
  }

  function stop() { clearInterval(pollTimer); clearInterval(clockTimer); }
  window.addEventListener('pagehide', stop);

  // ---- send to their sign-off queue ----
  $('req-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    L.notice(msg, '');
    const email = $('verifier').value.trim();
    if (!email) return L.notice(msg, "Enter your supervisor's or lecturer's email.");
    const btn = $('req-form').querySelector('button');
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
