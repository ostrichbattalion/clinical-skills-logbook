/* Cohort progress for lecturers and admins: who is on track, which skills lag, spreadsheet export. */
(function () {
  'use strict';
  const L = window.Logbook;
  if (!L.configured) { L.demoNotice(); return; }
  const user = L.requireUser('lecturer', 'admin');
  if (!user) return;
  L.mountUserBar(user);

  const $ = (id) => document.getElementById(id);
  const msg = $('report-msg');
  const progSel = $('programme');
  const yearSel = $('year');
  const STATUS = { 'at-risk': 'At risk', behind: 'Behind', 'on-track': 'On track', 'no-activity': 'No activity' };
  const ORDER = { 'at-risk': 0, 'no-activity': 1, behind: 2, 'on-track': 3 };
  let programmes = [];
  let first = true;

  const params = new URLSearchParams(location.search);
  function query(extra = {}) {
    const q = new URLSearchParams();
    if (progSel.value) q.set('programme', progSel.value);
    if (yearSel.value) q.set('year', yearSel.value);
    for (const [k, v] of Object.entries(extra)) q.set(k, v);
    return q.toString() ? '?' + q : '';
  }

  function fillYears() {
    const p = programmes.find((x) => x.id === progSel.value);
    const keep = yearSel.value;
    yearSel.innerHTML = '<option value="">All years</option>' +
      (p ? Array.from({ length: p.years }, (_, i) => `<option value="${i + 1}">Year ${i + 1}</option>`).join('') : '');
    yearSel.disabled = !p || p.years < 2;
    if ([...yearSel.options].some((o) => o.value === keep)) yearSel.value = keep;
  }

  const bar = (pct) => `<span class="mini-bar" aria-hidden="true"><span style="width:${Math.min(100, pct)}%"></span></span>${pct}%`;

  function render(r) {
    $('institution').textContent = r.institution;
    $('elapsed').textContent = `Academic year ${r.academicYear.start} to ${r.academicYear.end}: ${Math.round(r.academicYear.elapsed * 100)}% elapsed. Pace compares each student's signed skills with that.`;
    for (const k of ['total', 'on-track', 'behind', 'at-risk', 'no-activity']) $(`count-${k}`).textContent = r.counts[k] ?? 0;

    const rows = [...r.students].sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.name.localeCompare(b.name));
    $('students').innerHTML = rows.length ? rows.map((s) => `<tr>
        <td><a href="skills_tracker.html?student=${encodeURIComponent(s.sub)}">${L.esc(s.name)}</a><div class="sub-details">${L.esc(s.email)}</div></td>
        <td>${L.esc(s.programmeName || 'HPCSA only')}${s.studyYear ? `<div class="sub-details">Year ${L.esc(s.studyYear)}</div>` : ''}</td>
        <td class="num">${s.college ? bar(s.college.thisYearPercent) : '<span class="sub-details">n/a</span>'}</td>
        <td class="num">${s.hpcsa ? bar(s.hpcsa.percentComplete) : '–'}</td>
        <td class="num">${s.awaitingSignature || ''}</td>
        <td>${s.lastActivity ? L.esc(L.formatDate(s.lastActivity)) : '<span class="sub-details">never</span>'}</td>
        <td><span class="pill ${L.esc(s.status)}">${STATUS[s.status]}</span></td>
      </tr>`).join('') : '<tr><td colspan="7" class="empty">No students match these filters.</td></tr>';

    const skillsBox = $('skills-section');
    if (!r.skills) { skillsBox.hidden = true; return; }
    skillsBox.hidden = false;
    $('skills').innerHTML = r.skills.length ? r.skills.map((k) => {
      const share = k.students ? k.belowPace / k.students : 0;
      return `<tr class="${share >= 0.3 ? 'flag' : ''}">
        <td>${L.esc(k.name)}<div class="sub-details">${L.esc(k.group)}${k.hpcsaSkillId ? '' : ' · college-only'}</div></td>
        <td class="num">${k.met} / ${k.students}</td>
        <td class="num">${k.belowPace}${share >= 0.3 ? ' ⚠' : ''}</td>
        <td class="num">${k.medianVerified} of ${k.typicalMinimum}</td>
      </tr>`;
    }).join('') : '<tr><td colspan="4" class="empty">No skills with a minimum this year.</td></tr>';
  }

  async function load() {
    L.notice(msg, '');
    $('students').innerHTML = '<tr><td colspan="7" class="empty">Loading…</td></tr>';
    try {
      const r = await L.api('GET', '/reports/cohort' + query());
      if (first) {
        programmes = r.programmes;
        progSel.innerHTML = '<option value="">All programmes</option>' + programmes.map((p) => `<option value="${L.esc(p.id)}">${L.esc(p.name)}</option>`).join('');
        if (params.get('programme')) progSel.value = params.get('programme');
        fillYears();
        if (params.get('year')) yearSel.value = params.get('year');
        first = false;
        if (progSel.value || yearSel.value) return load();
      }
      const real = programmes.find((p) => p.id === progSel.value && p.id !== 'none');
      $('summary-link').hidden = !real;
      if (real) $('summary-link').href = `hpcsa_summary.html?programme=${encodeURIComponent(real.id)}`;
      history.replaceState(null, '', location.pathname + query());
      render(r);
    } catch (err) { L.notice(msg, err.message); }
  }

  progSel.addEventListener('change', () => { fillYears(); yearSel.value = ''; load(); });
  yearSel.addEventListener('change', load);

  const csvCell = (v) => {
    const s = String(v ?? '');
    return /^[=+\-@\t\r]/.test(s) ? `"'${s.replace(/"/g, '""')}"` : /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  $('export').addEventListener('click', async () => {
    const btn = $('export');
    btn.disabled = true;
    try {
      const r = await L.api('GET', '/reports/cohort' + query({ detail: '1' }));
      const cols = [['student', 'Student'], ['email', 'Email'], ['programme', 'Programme'], ['year', 'Year of study'], ['framework', 'Framework'],
        ['skill', 'Skill'], ['group', 'Group'], ['yearMinimum', 'This year minimum'], ['yearVerified', 'This year signed'],
        ['totalMinimum', 'Total minimum'], ['totalVerified', 'Total signed'], ['pending', 'Awaiting signature'], ['met', 'Total met']];
      const lines = [cols.map((c) => c[1]).join(','), ...r.detail.map((d) => cols.map(([k]) => csvCell(d[k])).join(','))];
      const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `logbook-progress-${(progSel.value || 'all').toLowerCase()}${yearSel.value ? '-y' + yearSel.value : ''}-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (err) { L.notice(msg, err.message); }
    finally { btn.disabled = false; }
  });

  load();
})();
