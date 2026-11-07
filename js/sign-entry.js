/* Review one entry: tick what you witnessed and sign, or return it to the student with a reason. */
(function () {
  'use strict';
  const L = window.Logbook;
  if (!L.configured) { L.demoNotice(); return; }
  const user = L.requireUser('supervisor', 'lecturer');
  if (!user) return;
  L.mountUserBar(user);

  const q = new URLSearchParams(location.search);
  const path = `/queue/${encodeURIComponent(q.get('student') || '')}/${encodeURIComponent(q.get('entry') || '')}`;
  const msg = document.getElementById('sign-msg');
  const signForm = document.getElementById('sign-form');
  const returnForm = document.getElementById('return-form');
  document.getElementById('signer-name').value = user.name;
  document.getElementById('reg-code').value = user.regNo || '';

  Promise.all([L.api('GET', '/catalogue'), L.api('GET', path)]).then(([cat, { entry: e }]) => {
    const names = new Map(cat.skills.map((s) => [s.id, s.name]));
    document.getElementById('student-name').textContent = e.studentName;
    document.getElementById('entry-title').textContent =
      `${e.kind === 'encounter' ? 'Patient encounter' : 'Skills session'} · ${e.setting}${e.encounterRef ? ' · ' + e.encounterRef : ''} · ${L.formatDate(e.performedOn)}`;
    if (e.notes) { const n = document.getElementById('entry-notes'); n.textContent = `Student's note: ${e.notes}`; n.hidden = false; }
    const list = document.getElementById('skill-list');
    list.innerHTML = e.skills.map((s, i) => `<li><input type="checkbox" id="s${i}" value="${L.esc(s.skillId)}" checked>
      <label for="s${i}">${L.esc(names.get(s.skillId) || s.skillId)}${s.count > 1 ? ` <strong>×${s.count}</strong>` : ''}</label></li>`).join('');
    signForm.hidden = false;
    document.getElementById('return-section').hidden = false;
  }).catch((err) => L.notice(msg, err.message));

  signForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    L.notice(msg, '');
    const witnessed = [...document.querySelectorAll('#skill-list input:checked')].map((i) => i.value);
    if (!witnessed.length) return L.notice(msg, 'Tick at least one skill you witnessed, or return the entry instead.');
    const regNo = document.getElementById('reg-code').value.trim();
    if (!regNo) return L.notice(msg, 'Enter your professional registration number.');
    if (!document.getElementById('attest').checked) return L.notice(msg, 'Confirm that you personally witnessed the ticked skills.');
    const btn = signForm.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await L.api('POST', path + '/sign', { witnessedSkillIds: witnessed, regNo, comment: document.getElementById('comment').value });
      location.href = 'lecturer_dashboard.html?done=1';
    } catch (err) { L.notice(msg, err.message); btn.disabled = false; }
  });

  returnForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    L.notice(msg, '');
    const reason = document.getElementById('return-reason').value.trim();
    if (!reason) return L.notice(msg, 'Give the student a reason so they can fix the entry.');
    const btn = returnForm.querySelector('button');
    btn.disabled = true;
    try {
      await L.api('POST', path + '/return', { reason });
      location.href = 'lecturer_dashboard.html?done=1';
    } catch (err) { L.notice(msg, err.message); btn.disabled = false; }
  });
})();
