/* Progress: college target this year, college total to graduation, and HPCSA Annexure A minimums. */
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
  const tabs = document.getElementById('view-tabs');
  let data = null;
  let view = 'hpcsa';
  let filter = 'all';

  if (!user.roles.includes('student')) document.getElementById('back').href = 'reports.html';

  const CATEGORY_NAMES = { ECA: 'Emergency Care Assistant (higher certificate)', PARAMEDIC: 'Paramedic (diploma)', ECP: 'Emergency Care Practitioner (degree)' };

  /** Normalises each view to rows of { name, group, minimum, verified, pending, paediatric, recordOnly }. */
  function rows() {
    if (view === 'hpcsa') return data.hpcsa.skills.map((s) => ({ ...s, group: s.paediatric ? 'Paediatric' : '' }));
    const key = view === 'year' ? 'thisYear' : 'total';
    return data.college.skills.map((s) => ({
      name: s.name, group: s.group, paediatric: /paediatric/i.test(s.name + s.group), recordOnly: s.recordOnly,
      minimum: s.recordOnly ? 0 : s[key].minimum, verified: s[key].verified, pending: s[key].pending, met: s[key].met,
    }));
  }

  function summary() {
    const t = view === 'hpcsa' ? data.hpcsa.totals : view === 'year' ? data.college.thisYear : data.college.total;
    document.getElementById('overall').textContent = `${t.percentComplete}%`;
    document.getElementById('met').textContent = `${t.met} of ${t.withMinimum} skills at minimum`;
    const heading = view === 'hpcsa'
      ? `HPCSA Annexure A minimums for ${CATEGORY_NAMES[data.hpcsa.category] || data.hpcsa.category}, cumulative to graduation (PBEC, March 2021).`
      : view === 'year'
        ? `${data.college.programmeName}: this year's minimums (year ${data.college.studyYear} of ${data.college.years}).`
        : `${data.college.programmeName}: all years added together, to graduation.`;
    document.getElementById('framework-note').textContent = heading + ' Only skills signed by a supervisor or lecturer count.';
    if (data.academicYear && view === 'year') {
      document.getElementById('framework-note').textContent += ` The academic year is ${Math.round(data.academicYear.elapsed * 100)}% through.`;
    }
  }

  function render() {
    summary();
    const list = rows().filter((s) => {
      if ((s.minimum === 0 && !s.recordOnly) && !showZero.checked) return false;
      if (s.recordOnly && !showZero.checked && filter !== 'record') return false;
      if (filter === 'met') return s.minimum > 0 && s.verified >= s.minimum;
      if (filter === 'progress') return s.verified < s.minimum && (s.verified > 0 || s.pending > 0);
      if (filter === 'notstarted') return s.minimum > 0 && s.verified === 0 && s.pending === 0;
      if (filter === 'paeds') return s.paediatric;
      if (filter === 'record') return s.recordOnly;
      return true;
    });
    grid.innerHTML = list.length ? '' : '<p class="empty">No skills match this filter.</p>';
    for (const s of list) {
      const met = s.minimum > 0 && s.verified >= s.minimum;
      const pct = s.minimum ? Math.min(100, Math.round((s.verified / s.minimum) * 100)) : 100;
      const card = document.createElement('div');
      card.className = `achievement-card ${s.minimum === 0 ? 'locked' : met ? 'completed met' : 'in-progress'}`;
      card.innerHTML = `<div class="card-content">
          <h3>${L.esc(s.name)}</h3>
          ${s.group ? `<div class="sub-details">${L.esc(s.group)}</div>` : ''}
          ${s.recordOnly ? '<div class="badge badge-info">Record only</div>'
            : s.minimum === 0 ? '<div class="badge badge-locked">No minimum here</div>'
            : met ? '<div class="badge badge-success">Minimum met</div>'
            : `<div class="badge badge-primary">${s.minimum - s.verified} to go</div>`}
          <p class="quota-text">${s.minimum ? `${s.verified} / ${s.minimum} signed` : `${s.verified} signed`}</p>
          ${s.minimum ? `<div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="${s.minimum}" aria-valuenow="${s.verified}" aria-label="${L.esc(s.name)}">
            <div class="progress-fill" style="width:${pct}%"></div></div>` : ''}
          <div class="progress-meta"><span>${s.pending ? `${s.pending} awaiting signature` : ''}</span></div>
        </div>`;
      grid.appendChild(card);
    }
  }

  function setView(v) {
    view = v;
    tabs.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === v)));
    tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
    document.querySelector('[data-filter=record]').hidden = v === 'hpcsa';
    render();
  }

  tabs.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setView(b.dataset.view); });
  document.querySelectorAll('.filter-btn[data-filter]').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn[data-filter]').forEach((x) => { x.classList.remove('active'); x.setAttribute('aria-pressed', 'false'); });
    b.classList.add('active');
    b.setAttribute('aria-pressed', 'true');
    filter = b.dataset.filter;
    render();
  }));
  showZero.addEventListener('change', render);

  L.cachedGet('/progress' + (studentSub ? `?studentSub=${encodeURIComponent(studentSub)}` : '')).then((p) => {
    data = p;
    if (p.offline) L.notice(msg, `No connection: showing progress as it was at ${new Date(p.savedAt).toLocaleString('en-ZA')}.`, 'info');
    document.getElementById('who').textContent = studentSub ? p.student.name : '';
    if (p.college) {
      tabs.hidden = false;
      setView('year');
    } else setView('hpcsa');
  }).catch((err) => { L.notice(msg, err.message); grid.innerHTML = ''; });
})();
