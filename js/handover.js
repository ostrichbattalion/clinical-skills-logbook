/*
 * Hand-over signing: the supervisor signs on the student's phone.
 * The supervisor's session lives only in this page's memory (never in storage), is used for this one batch, and is
 * revoked when they finish, cancel, go idle for 3 minutes, or leave the page. The student's own session is untouched.
 */
(function () {
  'use strict';
  const L = window.Logbook;
  if (!L.configured) { L.demoNotice(); return; }
  const student = L.requireUser('student');
  if (!student) return;
  L.mountUserBar(student);

  const $ = (id) => document.getElementById(id);
  const msg = $('ho-msg');
  const ids = (new URLSearchParams(location.search).get('ids') || '').split(',').filter(Boolean);
  const IDLE_MS = window.LOGBOOK_HANDOVER_IDLE_MS || 3 * 60 * 1000; // overridable only for automated tests
  let sup = null;         // supervisor session, memory only
  let challenge = null;   // pending MFA step
  let token = null;       // sign request code, memory only
  let idleTimer = null;

  $('student-name').textContent = student.name;

  function show(step) {
    for (const s of ['step-hand', 'step-signin', 'step-sign', 'step-done']) $(s).hidden = s !== step;
  }

  async function endSupervisor(reason) {
    clearTimeout(idleTimer);
    const s = sup;
    sup = null;
    challenge = null;
    $('sup-password').value = '';
    $('sup-code').value = '';
    $('batch').innerHTML = '';
    $('sup-banner').hidden = true;
    if (s) await L.revoke(s);
    if (reason) { show('step-hand'); L.notice(msg, reason, 'info'); }
  }

  function resetIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => endSupervisor('The supervisor was signed out after 3 minutes without activity.'), IDLE_MS);
  }
  ['input', 'click', 'keydown', 'touchstart'].forEach((t) => document.addEventListener(t, () => { if (sup || challenge) resetIdle(); }, { passive: true }));
  window.addEventListener('pagehide', () => { if (sup) L.revoke(sup); });

  $('start').addEventListener('click', async () => {
    L.notice(msg, '');
    if (!ids.length) return L.notice(msg, 'Go back and select the entries to sign.');
    try {
      token = (await L.api('POST', '/entries/sign-requests', { entryIds: ids })).token;
      show('step-signin');
      resetIdle();
      $('sup-email').focus();
    } catch (err) { L.notice(msg, err.message); }
  });

  $('cancel').addEventListener('click', () => endSupervisor('Cancelled. Nothing was signed.'));

  $('signin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    L.notice(msg, '');
    const btn = $('signin-form').querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const result = challenge
        ? await L.answerChallenge(challenge, $('sup-code').value.trim())
        : await L.signIn($('sup-email').value, $('sup-password').value, { persist: false });
      $('sup-password').value = '';
      if (result.challenge) {
        if (result.challenge.name === 'SOFTWARE_TOKEN_MFA') {
          challenge = result.challenge;
          $('mfa-field').hidden = false;
          $('sup-code').focus();
          return;
        }
        throw new Error('This account needs setting up first. Sign in once on your own device, then try again.');
      }
      challenge = null;
      $('mfa-field').hidden = true;
      const s = result.session;
      if (s.user.sub === student.sub) throw new Error('That is the student\'s own account. The supervisor must sign in.');
      if (!s.user.roles.some((r) => r === 'supervisor' || r === 'lecturer')) { await L.revoke(s); throw new Error('Only a supervisor or lecturer can sign.'); }
      sup = s;
      $('sup-banner').textContent = `${s.user.name} is signed in on this phone for this sign-off only. They will be signed out automatically.`;
      $('sup-banner').hidden = false;
      const claim = await L.apiAs(sup, 'POST', '/sign-requests/claim', { token });
      show('step-sign');
      SignBatch.mount($('batch'), {
        studentName: claim.studentName, studentSub: claim.studentSub, entries: claim.entries, verifier: sup.user,
        call: (m, p, b) => L.apiAs(sup, m, p, b),
        onDone: async (summary) => {
          if (summary.failed.length) return;
          const who = sup.user.name;
          await endSupervisor();
          $('done-text').textContent = `${who} signed ${summary.signed}${summary.returned ? ` and returned ${summary.returned}` : ''}, and has been signed out of this phone. Hand the phone back to ${student.name}.`;
          show('step-done');
        },
      });
    } catch (err) {
      L.notice(msg, err.message);
      if (sup) await endSupervisor();
    } finally {
      btn.disabled = false;
    }
  });

  show('step-hand');
  L.api('GET', '/entries').then(({ entries }) => {
    const chosen = entries.filter((e) => ids.includes(e.entryId));
    $('selected').innerHTML = chosen.map((e) => `<li>${L.esc(L.formatDate(e.performedOn))} · ${e.kind === 'encounter' ? 'Patient encounter' : 'Skills session'} · ${L.esc(e.setting)}</li>`).join('') || '<li class="empty">No entries selected.</li>';
  }).catch(() => { /* list is informational */ });
})();
