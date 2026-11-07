/* Progress against the HPCSA Annexure A minimums for the student's registration category. */
(function () {
  'use strict';
  const L = window.Logbook;
  if (!L.configured) { L.demoNotice(); return; }
  const user = L.requireUser('student', 'lecturer', 'admin');
  if (!user) return;
  L.mountUserBar(user);

  const studentSub = new URLSearchParams(location.search).get('student');
  const msg = document.getElementById('tracker-msg');
  const grid = document.getElementById('grid');
  const showZero = document.getElementById('show-zero');
  let data = null;
  let filter = 'all';

  if (!user.roles.includes('student')) document.getElementById('back').href = 'lecturer_dashboard.html';

  const CATEGORY_NAMES = { ECA: 'Emergency Care Assistant (higher certificate)', PARAMEDIC: 'Paramedic (diploma)', ECP: 'Emergency Care Practitioner (degree)' };

  function render() {
    const skills = data.skills.filter((s) => {
      if (s.minimum === 0 && !showZero.checked) return false;
      if (filter === 'met') return s.minimum > 0 && s.met;
      if (filter === 'progress') return !s.met && (s.verified > 0 || s.pending > 0);
      if (filter === 'notstarted') return s.minimum > 0 && s.verified === 0 && s.pending === 0;
      if (filter === 'paeds') return s.paediatric;
      return true;
    });
    grid.innerHTML = skills.length ? '' : '<p class="empty">No skills match this filter.</p>';
    for (const s of skills) {
      const pct = s.minimum ? Math.min(100, Math.round((s.verified / s.minimum) * 100)) : 100;
      const state = s.minimum === 0 ? 'locked' : s.met ? 'completed met' : 'in-progress';
      const card = document.createElement('div');
      card.className = `achievement-card ${state}`;
      card.innerHTML = `<div class="card-content">
          <h3>${L.esc(s.name)}</h3>
          ${s.minimum === 0 ? '<div class="badge badge-locked">No minimum for this category</div>'
            : s.met ? '<div class="badge badge-success">Minimum met</div>'
            : `<div class="badge badge-primary">${s.minimum - s.verified} to go</div>`}
          <p class="quota-text">${s.verified} / ${s.minimum} signed</p>
          <div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="${s.minimum}" aria-valuenow="${s.verified}" aria-label="${L.esc(s.name)}">
            <div class="progress-fill" style="width:${pct}%"></div>
          </div>
          <div class="progress-meta"><span>${s.pending ? `${s.pending} awaiting signature` : ''}</span></div>
        </div>`;
      grid.appendChild(card);
    }
  }

  document.querySelectorAll('.filter-btn').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach((x) => { x.classList.remove('active'); x.setAttribute('aria-pressed', 'false'); });
    b.classList.add('active');
    b.setAttribute('aria-pressed', 'true');
    filter = b.dataset.filter;
    render();
  }));
  showZero.addEventListener('change', render);

  L.api('GET', '/progress' + (studentSub ? `?studentSub=${encodeURIComponent(studentSub)}` : '')).then((p) => {
    data = p;
    document.getElementById('who').textContent = studentSub ? `${p.student.name} · ` : '';
    document.getElementById('category').textContent = CATEGORY_NAMES[p.category] || p.category;
    document.getElementById('overall').textContent = `${p.totals.percentComplete}%`;
    document.getElementById('met').textContent = `${p.totals.met} of ${p.totals.withMinimum} skills at minimum`;
    render();
  }).catch((err) => { L.notice(msg, err.message); grid.innerHTML = ''; });
})();
