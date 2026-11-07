/*
 * Signs a batch of a student's entries in one go: used by QR signing (supervisor's own phone) and hand-over
 * signing (student's phone). An entry with nothing ticked is returned to the student with the reason given.
 */
(function () {
  'use strict';
  const L = window.Logbook;

  /**
   * opts: { studentName, studentSub, entries, verifier: {name, regNo}, call: (method, path, body) => Promise, onDone(summary) }
   */
  function mount(container, opts) {
    const { entries, verifier } = opts;
    container.innerHTML = `
      <p>You are signing for <strong>${L.esc(opts.studentName)}</strong>. Untick anything you did not witness. An entry with nothing ticked goes back to the student.</p>
      <div class="batch-entries"></div>
      <form class="batch-form" novalidate>
        <div class="field"><label for="b-name">Your name</label><input id="b-name" value="${L.esc(verifier.name)}" readonly></div>
        <div class="field"><label for="b-regno">Your professional registration number</label><input id="b-regno" maxlength="40" value="${L.esc(verifier.regNo || '')}" required></div>
        <div class="field"><label for="b-comment">Comment for the student (optional)</label><textarea id="b-comment" rows="2" maxlength="500"></textarea></div>
        <div class="field"><input type="checkbox" id="b-attest"> <label for="b-attest" style="display:inline;font-weight:normal">I personally witnessed the ticked skills being performed by this student on actual patients.</label></div>
        <p class="batch-msg" role="alert" hidden></p>
        <button type="submit" class="btn btn-approve">Sign</button>
      </form>`;
    const list = container.querySelector('.batch-entries');
    entries.forEach((e, i) => {
      const box = document.createElement('div');
      box.className = 'encounter-group';
      box.dataset.index = String(i);
      box.innerHTML = `<h3>${e.kind === 'encounter' ? 'Patient encounter' : 'Skills session'} · ${L.esc(e.setting)}${e.encounterRef ? ' · ' + L.esc(e.encounterRef) : ''} · ${L.esc(L.formatDate(e.performedOn))}</h3>
        ${e.notes ? `<p class="sub-details">Student's note: ${L.esc(e.notes)}</p>` : ''}
        <ul class="skill-checklist">${e.skills.map((s, j) => `<li><input type="checkbox" id="e${i}s${j}" value="${L.esc(s.skillId)}" checked>
          <label for="e${i}s${j}">${L.esc(s.name || s.skillId)}${s.count > 1 ? ` <strong>×${s.count}</strong>` : ''}</label></li>`).join('')}</ul>
        <div class="field return-reason" hidden><label for="r${i}">Nothing ticked: reason for returning this entry</label><input id="r${i}" maxlength="500" placeholder="e.g. I wasn't with this patient"></div>`;
      const sync = () => { box.querySelector('.return-reason').hidden = box.querySelectorAll('input[type=checkbox]:checked').length > 0; };
      box.querySelectorAll('input[type=checkbox]').forEach((c) => c.addEventListener('change', sync));
      list.appendChild(box);
    });

    const form = container.querySelector('.batch-form');
    const msg = container.querySelector('.batch-msg');
    let busy = false;
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (busy) return;
      L.notice(msg, '');
      const regNo = container.querySelector('#b-regno').value.trim();
      const plan = [...list.children].map((box) => {
        const e = entries[Number(box.dataset.index)];
        const witnessed = [...box.querySelectorAll('input[type=checkbox]:checked')].map((c) => c.value);
        return { e, witnessed, reason: box.querySelector('.return-reason input').value.trim() };
      });
      if (plan.some((p) => p.witnessed.length) && !regNo) return L.notice(msg, 'Enter your professional registration number.');
      if (plan.some((p) => p.witnessed.length) && !container.querySelector('#b-attest').checked) return L.notice(msg, 'Confirm that you personally witnessed the ticked skills.');
      const missing = plan.find((p) => !p.witnessed.length && !p.reason);
      if (missing) return L.notice(msg, 'Give a reason for each entry you are returning, so the student can fix it.');
      busy = true;
      form.querySelector('button').disabled = true;
      const summary = { signed: 0, returned: 0, failed: [] };
      for (const p of plan) {
        const base = `/queue/${encodeURIComponent(opts.studentSub)}/${encodeURIComponent(p.e.entryId)}`;
        try {
          if (p.witnessed.length) { await opts.call('POST', base + '/sign', { witnessedSkillIds: p.witnessed, regNo, comment: container.querySelector('#b-comment').value }); summary.signed++; }
          else { await opts.call('POST', base + '/return', { reason: p.reason }); summary.returned++; }
        } catch (err) { summary.failed.push(err.message); }
      }
      busy = false;
      if (summary.failed.length) {
        L.notice(msg, `Some entries could not be saved: ${summary.failed.join('; ')}`);
        form.querySelector('button').disabled = false;
      }
      opts.onDone(summary);
    });
  }

  window.SignBatch = { mount };
})();
