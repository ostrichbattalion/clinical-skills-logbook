/* Supervisor's phone: opened by scanning a student's QR code. Claims the code, then signs the entries. */
(function () {
  'use strict';
  const L = window.Logbook;
  const KEY = 'logbook.qrToken';
  const msg = document.getElementById('qr-msg');
  const box = document.getElementById('batch');

  // The code arrives in the URL fragment (never sent to any server). Keep it for after sign-in, then drop it from the address bar.
  const fromHash = location.hash.replace(/^#/, '');
  if (fromHash) {
    try { sessionStorage.setItem(KEY, fromHash); } catch { /* ignore */ }
    history.replaceState(null, '', location.pathname);
  }
  if (!L.configured) { L.demoNotice(); return; }
  const user = L.requireUser('supervisor', 'lecturer');
  if (!user) return;
  L.mountUserBar(user);

  let token = fromHash;
  try { token = token || sessionStorage.getItem(KEY) || ''; sessionStorage.removeItem(KEY); } catch { /* ignore */ }
  if (!token) { L.notice(msg, 'No signing code found. Scan the code on the student\'s phone again.'); box.innerHTML = ''; return; }

  L.api('POST', '/sign-requests/claim', { token }).then((r) => {
    SignBatch.mount(box, {
      studentName: r.studentName, studentSub: r.studentSub, entries: r.entries, verifier: user,
      call: (m, p, b) => L.api(m, p, b),
      onDone: (s) => {
        if (s.failed.length) return;
        box.innerHTML = `<p class="notice notice-ok">Done: ${s.signed} signed${s.returned ? `, ${s.returned} returned to the student` : ''}. The student's phone shows it now.</p>
          <a class="btn btn-secondary" href="lecturer_dashboard.html">Go to your sign-off queue</a>`;
      },
    });
  }).catch((err) => { L.notice(msg, err.message); box.innerHTML = ''; });
})();
