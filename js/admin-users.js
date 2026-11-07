/* Institution admin: people, roles, programmes, years, invitations and class-list import. */
(function () {
  'use strict';
  const L = window.Logbook;
  if (!L.configured) { L.demoNotice(); return; }
  const user = L.requireUser('admin');
  if (!user) return;
  L.mountUserBar(user);

  const $ = (id) => document.getElementById(id);
  const msg = $('admin-msg');
  const ROLE = { student: 'Student', supervisor: 'Supervisor', lecturer: 'Lecturer', admin: 'Administrator' };
  let people = [];
  let programmes = [];
  let editing = null; // person being edited, or null when adding

  // ---------------- list ----------------
  const status = (p) => !p.enabled ? ['disabled', 'Disabled'] : p.status === 'FORCE_CHANGE_PASSWORD' ? ['invited', 'Invited, not signed in yet'] : ['active', 'Active'];
  const progName = (id) => programmes.find((p) => p.id === id)?.name || id;

  function filtered() {
    const q = $('search').value.trim().toLowerCase();
    const role = $('f-role').value, prog = $('f-programme').value, year = $('f-year').value;
    return people.filter((p) =>
      (!q || (p.name + ' ' + p.email + ' ' + (p.regNo || '')).toLowerCase().includes(q)) &&
      (!role || p.roles.includes(role)) &&
      (!prog || p.programmeId === prog) &&
      (!year || String(p.studyYear) === year));
  }

  function render() {
    const list = filtered();
    $('count').textContent = `${list.length} of ${people.length}`;
    $('people').innerHTML = list.length ? '' : '<tr><td colspan="7" class="empty">No one matches.</td></tr>';
    for (const p of list) {
      const [cls, label] = status(p);
      const managed = !p.self && !p.roles.includes('admin');
      const isStudent = p.roles.includes('student');
      const tr = document.createElement('tr');
      if (!p.enabled) tr.className = 'muted';
      tr.innerHTML = `
        <td>${isStudent && managed ? `<input type="checkbox" class="sel" value="${L.esc(p.sub)}" aria-label="Select ${L.esc(p.name)}">` : ''}</td>
        <td><strong>${L.esc(p.name)}</strong>${p.self ? ' <span class="sub-details">(you)</span>' : ''}<div class="sub-details">${L.esc(p.email)}</div></td>
        <td>${p.roles.map((r) => ROLE[r] || r).join(', ')}</td>
        <td>${p.programmeId ? `${L.esc(progName(p.programmeId))}<div class="sub-details">Year ${L.esc(p.studyYear ?? '?')}</div>` : p.category ? `HPCSA ${L.esc(p.category)}` : ''}</td>
        <td>${L.esc(p.regNo || '')}</td>
        <td><span class="pill ${cls}">${label}</span></td>
        <td class="row-actions"></td>`;
      const actions = tr.querySelector('.row-actions');
      const btn = (text, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'link-button'; b.textContent = text; b.addEventListener('click', fn); actions.appendChild(b); };
      if (managed) {
        btn('Edit', () => openForm(p));
        if (p.status === 'FORCE_CHANGE_PASSWORD' && p.enabled) btn('Resend invite', () => act(`/admin/people/${encodeURIComponent(p.sub)}/resend-invite`, {}, `Invitation sent again to ${p.email}.`));
        btn(p.enabled ? 'Disable' : 'Enable', () => {
          if (p.enabled && !confirm(`Disable ${p.name}? They will be signed out everywhere and cannot sign in until re-enabled. Their logbook entries are kept.`)) return;
          act(`/admin/people/${encodeURIComponent(p.sub)}/enabled`, { enabled: !p.enabled }, `${p.name} ${p.enabled ? 'disabled' : 're-enabled'}.`);
        });
        if (isStudent) { const a = document.createElement('a'); a.href = `skills_tracker.html?student=${encodeURIComponent(p.sub)}`; a.textContent = 'Progress'; actions.appendChild(a); }
      }
      $('people').appendChild(tr);
    }
    $('people').querySelectorAll('.sel').forEach((c) => c.addEventListener('change', updatePromote));
    updatePromote();
  }

  function updatePromote() {
    const n = $('people').querySelectorAll('.sel:checked').length;
    $('promote').disabled = n === 0;
    $('promote').textContent = n ? `Move ${n} selected to next year` : 'Move selected to next year';
  }

  async function act(path, payload, done) {
    L.notice(msg, '');
    try { await L.api('POST', path, payload); L.notice(msg, done, 'ok'); await load(); }
    catch (err) { L.notice(msg, err.message); }
  }

  async function load() {
    const r = await L.api('GET', '/admin/people');
    people = r.people;
    if (!programmes.length) {
      programmes = r.programmes;
      $('institution').textContent = r.institution;
      $('f-programme').innerHTML = '<option value="">All programmes</option>' + programmes.map((p) => `<option value="${L.esc(p.id)}">${L.esc(p.name)}</option>`).join('');
      const maxYears = Math.max(1, ...programmes.map((p) => p.years));
      $('f-year').innerHTML = '<option value="">All years</option>' + Array.from({ length: maxYears }, (_, i) => `<option value="${i + 1}">Year ${i + 1}</option>`).join('');
      $('p-programme').innerHTML = programmes.map((p) => `<option value="${L.esc(p.id)}">${L.esc(p.name)}</option>`).join('');
      $('programme-fields').dataset.mode = programmes.length ? 'programme' : 'category';
    }
    render();
    loadAudit();
  }

  async function loadAudit() {
    try {
      const { events } = await L.api('GET', '/admin/audit');
      $('audit').innerHTML = events.length ? events.map((e) => `<li><span class="sub-details">${L.esc(new Date(e.at).toLocaleString('en-ZA'))}</span> · ${L.esc(e.actorName)}: ${L.esc(e.action)}${e.targetEmail ? ' ' + L.esc(e.targetEmail) : ''}${e.details ? ` <span class="sub-details">(${L.esc(e.details)})</span>` : ''}</li>`).join('')
        : '<li class="empty">No changes yet.</li>';
    } catch { /* audit is secondary; ignore */ }
  }

  ['search', 'f-role', 'f-programme', 'f-year'].forEach((id) => $(id).addEventListener('input', render));

  $('promote').addEventListener('click', async () => {
    const subs = [...$('people').querySelectorAll('.sel:checked')].map((c) => c.value);
    if (!confirm(`Move ${subs.length} student${subs.length === 1 ? '' : 's'} to their next year of study? Entries already logged keep the year they were logged in.`)) return;
    L.notice(msg, '');
    try {
      const { results } = await L.api('POST', '/admin/people/promote', { subs });
      const moved = results.filter((r) => r.ok).length;
      const skipped = results.filter((r) => !r.ok).map((r) => `${r.name || r.sub}: ${r.message}`);
      L.notice(msg, `${moved} moved to the next year.${skipped.length ? ' Not moved: ' + skipped.join('; ') + '.' : ''}`, skipped.length ? 'info' : 'ok');
      await load();
    } catch (err) { L.notice(msg, err.message); }
  });

  // ---------------- add / edit ----------------
  const form = $('person-form');
  function syncRole() {
    const student = $('p-role').value === 'student';
    const mode = $('programme-fields').dataset.mode;
    $('programme-fields').hidden = !student;
    $('f-prog-wrap').hidden = mode !== 'programme';
    $('f-year-wrap').hidden = mode !== 'programme';
    $('f-cat-wrap').hidden = mode !== 'category';
    syncYears();
  }
  function syncYears() {
    const p = programmes.find((x) => x.id === $('p-programme').value);
    const keep = $('p-year').value;
    $('p-year').innerHTML = Array.from({ length: p ? p.years : 1 }, (_, i) => `<option value="${i + 1}">Year ${i + 1}</option>`).join('');
    if ([...$('p-year').options].some((o) => o.value === keep)) $('p-year').value = keep;
  }
  $('p-role').addEventListener('change', syncRole);
  $('p-programme').addEventListener('change', syncYears);

  function clearErrors() {
    form.querySelectorAll('.field').forEach((f) => f.classList.remove('invalid'));
    form.querySelectorAll('.field-error').forEach((e) => e.remove());
  }
  function showErrors(fields) {
    const map = { email: 'p-email', name: 'p-name', role: 'p-role', programmeId: 'p-programme', studyYear: 'p-year', category: 'p-category', regNo: 'p-regno' };
    for (const [k, text] of Object.entries(fields || {})) {
      const input = $(map[k]);
      if (!input) continue;
      const f = input.closest('.field');
      f.classList.add('invalid');
      const e = document.createElement('div');
      e.className = 'field-error';
      e.textContent = text;
      f.appendChild(e);
    }
  }

  function openForm(p) {
    editing = p || null;
    clearErrors();
    $('form-title').textContent = p ? `Edit ${p.name}` : 'Add a person';
    $('p-email').value = p ? p.email : '';
    $('p-email').readOnly = !!p;
    $('p-name').value = p ? p.name : '';
    $('p-role').value = p ? p.roles[0] : 'student';
    if (p?.programmeId) $('p-programme').value = p.programmeId;
    $('p-category').value = p?.category || 'ECA';
    $('p-regno').value = p?.regNo || '';
    syncRole();
    if (p?.studyYear) $('p-year').value = String(p.studyYear);
    $('save').textContent = p ? 'Save changes' : 'Add and send invitation';
    $('person-panel').hidden = false;
    $('import-panel').hidden = true;
    $(p ? 'p-name' : 'p-email').focus();
  }
  $('add').addEventListener('click', () => openForm(null));
  $('cancel').addEventListener('click', () => { $('person-panel').hidden = true; });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors();
    L.notice(msg, '');
    const role = $('p-role').value;
    const student = role === 'student';
    const mode = $('programme-fields').dataset.mode;
    const payload = {
      ...(!editing && { email: $('p-email').value }),
      name: $('p-name').value, role, regNo: $('p-regno').value,
      ...(student && mode === 'programme' && { programmeId: $('p-programme').value, studyYear: Number($('p-year').value) }),
      ...(student && mode === 'category' && { category: $('p-category').value }),
    };
    const b = $('save');
    b.disabled = true;
    try {
      const res = await fetchWithFields(editing ? `/admin/people/${encodeURIComponent(editing.sub)}` : '/admin/people', payload);
      if (res.fields) { showErrors(res.fields); return; }
      $('person-panel').hidden = true;
      L.notice(msg, editing ? `${payload.name} updated.${editing.roles[0] !== role ? ' Their new role applies when they next sign in.' : ''}` : `${payload.name} added. An invitation with a temporary password has been emailed to ${payload.email.trim().toLowerCase()}.`, 'ok');
      await load();
    } catch (err) { L.notice(msg, err.message); }
    finally { b.disabled = false; }
  });

  /** Like L.api but returns { fields } for validation errors instead of throwing. */
  async function fetchWithFields(path, payload) {
    try { return await L.api('POST', path, payload); }
    catch (err) {
      if (err.fields) return { fields: err.fields };
      throw err;
    }
  }

  // ---------------- import ----------------
  const BATCH = 50;
  let importRows = [];
  const HEADER_ALIASES = { email: 'email', 'e-mail': 'email', name: 'name', full_name: 'name', role: 'role', programme: 'programme', program: 'programme',
    year: 'year', year_of_study: 'year', study_year: 'year', reg_no: 'reg_no', registration_number: 'reg_no', hpcsa_number: 'reg_no', category: 'category' };

  function parseCsv(text) {
    const rows = []; let row = []; let field = ''; let q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') q = false; else field += c; }
      else if (c === '"') q = true;
      else if (c === ',' || c === ';') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); field = ''; if (row.some((f) => f.trim())) rows.push(row); row = []; }
      else field += c;
    }
    row.push(field);
    if (row.some((f) => f.trim())) rows.push(row);
    return rows;
  }

  $('import').addEventListener('click', () => { $('import-panel').hidden = false; $('person-panel').hidden = true; $('import-file').focus(); });
  $('import-cancel').addEventListener('click', () => { $('import-panel').hidden = true; });
  $('template').addEventListener('click', () => {
    const ex = programmes[0];
    const lines = ['email,name,role,programme,year,reg_no,category',
      ex ? `jane.doe@example.ac.za,Jane Doe,student,${ex.id},1,,` : 'jane.doe@example.ac.za,Jane Doe,student,,,,ECA',
      'b.jones@example.gov.za,B. Jones,supervisor,,,PA1234567,'];
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    a.download = 'class-list-template.csv';
    document.body.appendChild(a); a.click(); a.remove();
  });

  $('import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    L.notice(msg, '');
    const text = (await readText(file)).replace(/^﻿/, '');
    const [header, ...data] = parseCsv(text);
    const keys = (header || []).map((h) => HEADER_ALIASES[h.trim().toLowerCase().replace(/\s+/g, '_')] || null);
    if (!keys.includes('email') || !keys.includes('name') || !keys.includes('role')) {
      L.notice(msg, 'The file needs at least email, name and role columns. Download the template for the layout.');
      return;
    }
    importRows = data.map((cells) => Object.fromEntries(keys.map((k, i) => [k, (cells[i] || '').trim()]).filter(([k]) => k)));
    $('import-summary').textContent = `Checking ${importRows.length} row${importRows.length === 1 ? '' : 's'}…`;
    $('import-go').hidden = true;
    try {
      const results = await runImport(true);
      showPreview(results);
    } catch (err) { L.notice(msg, err.message); }
  });

  function readText(file) {
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsText(file); });
  }

  async function runImport(dryRun) {
    const out = [];
    for (let i = 0; i < importRows.length; i += BATCH) {
      const { results } = await L.api('POST', '/admin/people/import', { rows: importRows.slice(i, i + BATCH), dryRun });
      out.push(...results.map((r) => ({ ...r, row: r.row + i })));
      if (!dryRun) $('import-summary').textContent = `Created ${out.filter((r) => r.ok).length} so far…`;
    }
    return out;
  }

  function showPreview(results, done = false) {
    const good = results.filter((r) => r.ok).length;
    $('import-summary').textContent = done
      ? `Created ${good} account${good === 1 ? '' : 's'}; invitations are on their way. ${results.length - good} row${results.length - good === 1 ? '' : 's'} not imported.`
      : `${good} of ${results.length} rows are ready. ${results.length - good ? 'Fix the rows marked below in your file and choose it again, or import just the ready rows.' : ''}`;
    $('import-preview').innerHTML = results.map((r) => {
      const row = importRows[r.row] || {};
      return `<tr class="${r.ok ? 'good' : 'bad'}"><td class="num">${r.row + 2}</td><td>${L.esc(row.email)}</td><td>${L.esc(row.name)}</td><td>${L.esc(row.role)}</td>
        <td>${L.esc([row.programme, row.year && 'Y' + row.year, row.category, row.reg_no].filter(Boolean).join(' · '))}</td>
        <td>${r.ok ? (done ? 'Created' : 'Ready') : L.esc(Object.values(r.errors).join('; '))}</td></tr>`;
    }).join('');
    $('import-table').hidden = false;
    $('import-go').hidden = done || good === 0;
    $('import-go').textContent = `Create ${good} account${good === 1 ? '' : 's'} and send invitations`;
  }

  $('import-go').addEventListener('click', async () => {
    $('import-go').disabled = true;
    try {
      const results = await runImport(false);
      showPreview(results, true);
      $('import-file').value = '';
      await load();
    } catch (err) { L.notice(msg, err.message); }
    finally { $('import-go').disabled = false; }
  });

  load().catch((err) => L.notice(msg, err.message));
})();
