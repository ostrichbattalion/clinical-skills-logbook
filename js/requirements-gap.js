/* Compares each college programme's requirements (all years added up) with the HPCSA Annexure A minimums. */
(function () {
  'use strict';
  const L = window.Logbook;
  if (!L.configured) { L.demoNotice(); return; }
  const user = L.requireUser('lecturer', 'admin');
  if (!user) return;
  L.mountUserBar(user);

  const msg = document.getElementById('gap-msg');
  const box = document.getElementById('gap');
  const STATUS = { ok: 'Covered', short: 'Short', 'not-covered': 'Not in college plan' };

  L.api('GET', '/reports/gap').then(({ sets }) => {
    box.innerHTML = '';
    for (const set of sets) {
      const head = document.createElement('p');
      head.innerHTML = `<strong>${L.esc(set.setName)}</strong> <span class="sub-details">(${L.esc(set.source)})</span>`;
      box.appendChild(head);
      for (const p of set.programmes) {
        const sec = document.createElement('section');
        const gaps = p.rows.filter((r) => r.status !== 'ok');
        const row = (r) => `<tr class="${r.status === 'ok' ? '' : 'flag'}">
            <td>${L.esc(r.name)}</td><td class="num">${r.hpcsaMinimum}</td><td class="num">${r.collegeMinimum}</td>
            <td><span class="pill ${L.esc(r.status)}">${STATUS[r.status]}${r.status === 'short' ? ` by ${r.shortBy}` : ''}</span></td>
            <td class="sub-details">${r.collegeSkills.map(L.esc).join('; ') || '–'}</td></tr>`;
        sec.innerHTML = `<h2>${L.esc(p.programmeName)} <span class="sub-details">→ HPCSA ${L.esc(p.category)}, ${p.years} year${p.years > 1 ? 's' : ''}</span></h2>
          <p><span class="pill ok">${p.summary.ok} covered</span> <span class="pill short">${p.summary.short} short</span> <span class="pill not-covered">${p.summary.notCovered} not in plan</span></p>
          <div class="table-wrap"><table class="data-table">
            <thead><tr><th>Skill (Annexure A)</th><th class="num">HPCSA minimum</th><th class="num">College minimum</th><th>Status</th><th>College logbook skills counted</th></tr></thead>
            <tbody>${gaps.length ? gaps.map(row).join('') : '<tr><td colspan="5" class="empty">Every Annexure A minimum is covered.</td></tr>'}</tbody>
            <tbody class="all-rows" hidden>${p.rows.filter((r) => r.status === 'ok').map(row).join('')}</tbody>
          </table></div>
          <button type="button" class="link-button toggle no-print">Show the ${p.summary.ok} covered skills too</button>
          ${p.collegeOnly.length ? `<details><summary>${p.collegeOnly.length} college skills with no Annexure A equivalent</summary><ul>${p.collegeOnly.map((c) => `<li>${L.esc(c.name)} (${c.total})</li>`).join('')}</ul></details>` : ''}`;
        sec.querySelector('.toggle').addEventListener('click', (e) => {
          const all = sec.querySelector('.all-rows');
          all.hidden = !all.hidden;
          e.target.textContent = all.hidden ? `Show the ${p.summary.ok} covered skills too` : 'Hide covered skills';
        });
        box.appendChild(sec);
      }
    }
  }).catch((err) => { L.notice(msg, err.message); box.innerHTML = ''; });
})();
