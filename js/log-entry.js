/* Log entry form (encounter or skills session). Used by log_new_encounter.html and log_single_skill.html. */
(function () {
  'use strict';
  const L = window.Logbook;
  if (!L.configured) { L.demoNotice(); return; }
  const user = L.requireUser('student');
  if (!user) return;
  L.mountUserBar(user);
  L.mountConnectivity();

  const COMMON = [
    'history-taking-registration-category-specific', 'general-physical-assessment-medical', 'general-physical-assessment-trauma',
    'glasgow-coma-scale-gcs-score', 'blood-pressure-measurement-non-inasive-blood-pressure-nibp', 'pulse-with-characteristics-measurement',
    'respirations-with-characteristics-measurement', 'use-of-a-pulse-oximeter', 'blood-glucose-measurement-use-of-glucometer',
    'intravenous-infusion-peripheral-limb-cannulation-and-attachment', 'mask-oxygen-administration',
  ];

  const form = document.getElementById('entry-form');
  const msg = document.getElementById('entry-msg');
  const search = document.getElementById('skill-search');
  const results = document.getElementById('skill-results');
  const chosenList = document.getElementById('chosen-skills');
  const commonBox = document.getElementById('common-skills');
  const dateInput = document.getElementById('performed-on');
  const refField = document.getElementById('ref-field');

  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  dateInput.value = today;
  dateInput.max = today;

  let skills = [];
  const chosen = new Map(); // skillId -> count

  function kind() { return form.querySelector('input[name=kind]:checked').value; }
  function syncKind() {
    refField.hidden = kind() !== 'encounter';
    document.getElementById('page-title').textContent = kind() === 'encounter' ? 'Log Patient Encounter' : 'Log Skills Session';
  }
  form.querySelectorAll('input[name=kind]').forEach((r) => r.addEventListener('change', syncKind));
  syncKind();

  function renderChosen() {
    chosenList.innerHTML = '';
    if (chosen.size === 0) { chosenList.innerHTML = '<li class="empty">No skills added yet.</li>'; return; }
    for (const [id, count] of chosen) {
      const s = skills.find((x) => x.id === id);
      const li = document.createElement('li');
      li.innerHTML = `<span class="name">${L.esc(s.name)}</span>
        <label class="visually-hidden" for="count-${L.esc(id)}">Times performed</label>
        <input type="number" id="count-${L.esc(id)}" min="1" max="50" value="${count}" aria-label="Times performed: ${L.esc(s.name)}">
        <button type="button" class="link-button" aria-label="Remove ${L.esc(s.name)}">Remove</button>`;
      li.querySelector('input').addEventListener('change', (e) => {
        const n = Math.max(1, Math.min(50, Math.round(Number(e.target.value) || 1)));
        e.target.value = n;
        chosen.set(id, n);
      });
      li.querySelector('button').addEventListener('click', () => { chosen.delete(id); renderChosen(); renderCommon(); });
      chosenList.appendChild(li);
    }
  }

  function add(id) {
    chosen.set(id, (chosen.get(id) || 0) + (chosen.has(id) ? 0 : 1));
    renderChosen();
    renderCommon();
  }

  function renderCommon() {
    commonBox.innerHTML = '';
    const seen = new Set();
    for (const hid of COMMON) {
      // college lists: the first college skill that counts toward this HPCSA skill
      const s = skills.find((x) => !x.derived && (x.id === hid || x.hpcsaSkillId === hid));
      if (!s || seen.has(s.id)) continue;
      seen.add(s.id);
      const id = s.id;
      const li = document.createElement('li');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.id = `common-${hid}`;
      box.checked = chosen.has(id);
      box.addEventListener('change', () => { box.checked ? add(id) : (chosen.delete(id), renderChosen()); });
      const label = document.createElement('label');
      label.htmlFor = box.id;
      label.textContent = s.name;
      li.append(box, label);
      commonBox.appendChild(li);
    }
  }

  function renderResults() {
    const q = search.value.trim().toLowerCase();
    results.innerHTML = '';
    if (q.length < 2) { results.hidden = true; return; }
    const words = q.split(/\s+/);
    const matches = skills.filter((s) => !s.derived && words.every((w) => (s.name + ' ' + s.group).toLowerCase().includes(w))).slice(0, 30);
    results.hidden = false;
    if (!matches.length) { results.innerHTML = '<li class="empty" style="padding:10px">No matching skill in your logbook list.</li>'; return; }
    for (const s of matches) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = `${L.esc(s.name)}${chosen.has(s.id) ? ' ✓' : ''}<span class="sub-details" style="display:block">${L.esc(s.group)}${s.recordOnly ? ' · record only' : ''}${s.minimumThisYear ? ` · this year's minimum ${s.minimumThisYear}` : ''}</span>`;
      b.addEventListener('click', () => { add(s.id); search.value = ''; renderResults(); search.focus(); });
      li.appendChild(b);
      results.appendChild(li);
    }
  }
  search.addEventListener('input', renderResults);

  L.cachedGet('/catalogue').then((c) => {
    skills = c.skills;
    document.getElementById('framework').textContent = c.programme
      ? `Logging against ${c.programme.name}, year ${c.studyYear} (${c.source}). Skills also count toward the HPCSA minimums.`
      : `Logging against ${c.source}.`;
    renderCommon();
    renderChosen();
  }).catch((err) => L.notice(msg, err.message));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    L.notice(msg, '');
    if (chosen.size === 0) return L.notice(msg, 'Add at least one skill you performed.');
    const body = {
      kind: kind(),
      performedOn: dateInput.value,
      setting: document.getElementById('setting').value,
      encounterRef: kind() === 'encounter' ? document.getElementById('encounter-ref').value : undefined,
      notes: document.getElementById('notes').value,
      skills: [...chosen].map(([skillId, count]) => ({ skillId, count })),
    };
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    const queue = () => { L.outbox.add(body); window.location.href = 'student_pwa_dashboard.html?queued=1'; };
    try {
      if (navigator.onLine === false) return queue();
      await L.api('POST', '/entries', body);
      window.location.href = 'student_pwa_dashboard.html?saved=1';
    } catch (err) {
      if (err.offline) {
        try { return queue(); } catch (e2) { L.notice(msg, e2.message); }
      } else L.notice(msg, err.message);
      btn.disabled = false;
    }
  });
})();
