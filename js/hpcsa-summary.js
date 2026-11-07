/* Printable clinical-learning progress summary for the HPCSA PBEC, per programme. */
(function () {
  'use strict';
  const L = window.Logbook;
  if (!L.configured) { L.demoNotice(); return; }
  const user = L.requireUser('lecturer', 'admin');
  if (!user) return;
  L.mountUserBar(user);

  const $ = (id) => document.getElementById(id);
  const msg = $('summary-msg');
  const programmeId = new URLSearchParams(location.search).get('programme');
  $('back').href = 'reports.html' + (programmeId ? `?programme=${encodeURIComponent(programmeId)}` : '');
  const CATEGORY = { ECA: 'Student Emergency Care Assistant', PARAMEDIC: 'Student Paramedic', ECP: 'Student Emergency Care Practitioner' };
  const PLAN = { ok: 'Covered', short: 'Short', 'not-covered': 'Not in college plan' };

  if (!programmeId) { L.notice(msg, 'Choose a programme on the cohort page first.'); return; }

  $('print').addEventListener('click', () => window.print());
  $('include-names').addEventListener('change', (e) => { $('names-block').hidden = !e.target.checked; });

  L.api('GET', `/reports/hpcsa-summary?programme=${encodeURIComponent(programmeId)}`).then((r) => {
    document.title = `HPCSA progress summary – ${r.programmeName}`;
    $('doc').hidden = false;
    $('m-institution').textContent = r.institution;
    $('m-programme').textContent = r.programmeName;
    $('m-category').textContent = CATEGORY[r.category] || r.category;
    $('m-date').textContent = L.formatDate(r.generatedAt);
    $('m-period').textContent = `${L.formatDate(r.academicYear.start)} to ${L.formatDate(r.academicYear.end)} (${Math.round(r.academicYear.elapsed * 100)}% elapsed)`;
    $('m-cohort').textContent = `${r.cohort.total} student${r.cohort.total === 1 ? '' : 's'}` +
      (r.years > 1 ? ' (' + Object.entries(r.cohort.byYear).sort().map(([y, n]) => `year ${y}: ${n}`).join(', ') + ')' : '');

    const diff = r.skills.filter((s) => s.anticipatedDifficulty);
    $('difficulty-answer').textContent = diff.length
      ? `Yes. Difficulties are anticipated in ${diff.length} of ${r.skills.length} required skills, listed below.`
      : r.cohort.total ? `No. No required skill has 30% or more of the cohort below the expected pace.` : 'No students are enrolled on this programme yet.';
    $('difficulties').innerHTML = diff.length ? diff.map((s) => `<tr>
        <td>${L.esc(s.name)}</td><td class="num">${s.minimum}</td><td class="num">${s.belowPace} of ${s.students}</td>
        <td>${s.collegePlan ? `<span class="pill ${L.esc(s.collegePlan.status)}">${PLAN[s.collegePlan.status]}</span>` : '–'}</td></tr>`).join('')
      : '<tr><td colspan="4" class="empty">None.</td></tr>';
    $('difficulty-table').hidden = !diff.length;

    $('all-skills').innerHTML = r.skills.map((s) => `<tr class="${s.anticipatedDifficulty ? 'flag' : ''}">
        <td>${L.esc(s.name)}</td><td class="num">${s.minimum}</td><td class="num">${s.met}</td><td class="num">${s.belowPace}</td>
        <td>${s.anticipatedDifficulty ? 'Yes' : ''}</td>
        <td>${s.collegePlan ? `${PLAN[s.collegePlan.status]}${s.collegePlan.status === 'ok' ? '' : ` (${s.collegePlan.collegeMinimum})`}` : '–'}</td></tr>`).join('');

    $('shortfalls').innerHTML = r.planShortfalls.length ? r.planShortfalls.map((g) => `<tr>
        <td>${L.esc(g.name)}</td><td class="num">${g.hpcsaMinimum}</td><td class="num">${g.collegeMinimum}</td>
        <td><span class="pill ${L.esc(g.status)}">${PLAN[g.status]}</span></td></tr>`).join('')
      : '<tr><td colspan="4" class="empty">The college requirements meet or exceed every Annexure A minimum.</td></tr>';

    const atRisk = r.studentsAtRisk.filter((s) => s.status === 'at-risk').length;
    const none = r.studentsAtRisk.filter((s) => s.status === 'no-activity').length;
    $('support-count').textContent = `${atRisk} student${atRisk === 1 ? ' is' : 's are'} at risk and ${none} ${none === 1 ? 'has' : 'have'} logged nothing yet.`;
    $('names').innerHTML = r.studentsAtRisk.length
      ? r.studentsAtRisk.map((s) => `<li>${L.esc(s.name)}${s.studyYear ? ` (year ${L.esc(s.studyYear)})` : ''}: ${s.status === 'at-risk' ? 'at risk' : 'no activity'}</li>`).join('')
      : '<li class="empty">None.</li>';
  }).catch((err) => L.notice(msg, err.message));
})();
