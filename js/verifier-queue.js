/* Sign-off queue for supervisors and lecturers, grouped by student. */
(function () {
  'use strict';
  const L = window.Logbook;
  if (!L.configured) { L.demoNotice(); return; }
  const user = L.requireUser('supervisor', 'lecturer');
  if (!user) return;
  L.mountUserBar(user);

  const msg = document.getElementById('queue-msg');
  const box = document.getElementById('queue');
  if (new URLSearchParams(location.search).get('done')) L.notice(msg, 'Saved.', 'ok');

  Promise.all([L.api('GET', '/catalogue'), L.api('GET', '/queue')]).then(([cat, { entries }]) => {
    const names = new Map(cat.skills.map((s) => [s.id, s.name]));
    document.getElementById('queue-count').textContent = entries.length;
    if (!entries.length) { box.innerHTML = '<p class="empty">Nothing is waiting for your signature.</p>'; return; }

    const byStudent = new Map();
    for (const e of entries) {
      if (!byStudent.has(e.studentSub)) byStudent.set(e.studentSub, []);
      byStudent.get(e.studentSub).push(e);
    }
    box.innerHTML = '';
    for (const [sub, list] of byStudent) {
      const first = list[0];
      const g = document.createElement('div');
      g.className = 'encounter-group';
      g.style.background = '#fff';
      g.style.border = '1px solid #ddd';
      g.innerHTML = `<h3>Student: <strong>${L.esc(first.studentName)}</strong> <span class="sub-details">${L.esc(first.category)} · ${L.esc(first.institution)}</span></h3>
        <ul class="entry-list">${list.map((e) => `<li><div class="details">
          <strong>${e.kind === 'encounter' ? 'Patient encounter' : 'Skills session'} · ${L.esc(e.setting)}${e.encounterRef ? ' · ' + L.esc(e.encounterRef) : ''}</strong>
          <div class="sub-details">${L.esc(L.formatDate(e.performedOn))} · requested ${L.esc(L.formatDate(e.request.requestedAt))}</div>
          <div class="skills-line">${e.skills.map((s) => L.esc(names.get(s.skillId) || s.skillId) + (s.count > 1 ? ` ×${s.count}` : '')).join(', ')}</div>
          </div><a class="btn btn-primary btn-icon" style="width:auto" href="supervisor_sig_form.html?student=${encodeURIComponent(sub)}&entry=${encodeURIComponent(e.entryId)}">Review &amp; Sign</a></li>`).join('')}
        </ul>
        ${user.roles.includes('lecturer') ? `<a class="btn btn-link" href="skills_tracker.html?student=${encodeURIComponent(sub)}">View ${L.esc(first.studentName)}'s progress</a>` : ''}`;
      box.appendChild(g);
    }
  }).catch((err) => L.notice(msg, err.message));
})();
