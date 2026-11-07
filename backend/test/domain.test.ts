import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogue, PATIENTS_SEEN_ID } from '../src/catalogue.js';
import {
  applyReturn, applySignature, buildEntry, computeProgress, HttpError, validateNewEntry, validateSign,
  type Caller, type Entry,
} from '../src/domain.js';
import { parseGroups } from '../src/auth.js';

const student: Caller = { sub: 's1', email: 'jane@x.za', name: 'Jane', roles: ['student'], institution: 'WCG', category: 'ECA' };
const supervisor: Caller = { sub: 'v1', email: 'bj@x.za', name: 'B Jones', roles: ['supervisor'], institution: 'WCG', regNo: 'PA1' };
const GCS = 'glasgow-coma-scale-gcs-score';
const PULSE = 'pulse-with-characteristics-measurement';

const valid = { kind: 'encounter', performedOn: '2026-11-01', setting: 'Ambulance', skills: [{ skillId: GCS, count: 1 }, { skillId: PULSE, count: 2 }] };
const throwsStatus = (fn: () => unknown, status: number, re?: RegExp) =>
  assert.throws(fn, (e: unknown) => e instanceof HttpError && e.status === status && (!re || re.test(e.message)));

test('catalogue matches Annexure A', () => {
  assert.equal(catalogue.skills.length, 139);
  const patients = catalogue.skills.find((s) => s.id === PATIENTS_SEEN_ID)!;
  assert.deepEqual(patients.minimums, { ECP: 450, PARAMEDIC: 200, ECA: 100 });
  assert.deepEqual(catalogue.skills.find((s) => s.id === GCS)!.minimums, { ECP: 285, PARAMEDIC: 140, ECA: 70 });
  assert.equal(new Set(catalogue.skills.map((s) => s.id)).size, 139);
});

test('validateNewEntry accepts a good entry and defaults count to 1', () => {
  const v = validateNewEntry({ ...valid, skills: [{ skillId: GCS }] }, '2026-11-07');
  assert.deepEqual(v.skills, [{ skillId: GCS, count: 1 }]);
});

test('validateNewEntry rejects bad input', () => {
  const t = '2026-11-07';
  throwsStatus(() => validateNewEntry({ ...valid, kind: 'x' }, t), 400, /kind/);
  throwsStatus(() => validateNewEntry({ ...valid, performedOn: '2026-11-08' }, t), 400, /future/);
  throwsStatus(() => validateNewEntry({ ...valid, performedOn: '07/11/2026' }, t), 400, /date/);
  throwsStatus(() => validateNewEntry({ ...valid, skills: [] }, t), 400);
  throwsStatus(() => validateNewEntry({ ...valid, skills: [{ skillId: 'nope' }] }, t), 400, /Unknown/);
  throwsStatus(() => validateNewEntry({ ...valid, skills: [{ skillId: PATIENTS_SEEN_ID }] }, t), 400, /automatically/);
  throwsStatus(() => validateNewEntry({ ...valid, skills: [{ skillId: GCS }, { skillId: GCS }] }, t), 400, /twice/);
  throwsStatus(() => validateNewEntry({ ...valid, skills: [{ skillId: GCS, count: 0 }] }, t), 400);
  throwsStatus(() => validateNewEntry({ ...valid, skills: [{ skillId: GCS, count: 1.5 }] }, t), 400);
  throwsStatus(() => validateNewEntry({ ...valid, setting: '  ' }, t), 400, /setting/);
});

function awaiting(): Entry {
  const e = buildEntry(validateNewEntry(valid, '2026-11-07'), student, 'e1', '2026-11-01T08:00:00Z');
  return { ...e, status: 'AWAITING_SIGNATURE', request: { verifierSub: 'v1', verifierName: 'B Jones', verifierEmail: 'bj@x.za', requestedAt: 't' } };
}

test('buildEntry needs a registration category', () => {
  const { category: _c, ...noCat } = student;
  throwsStatus(() => buildEntry(validateNewEntry(valid, '2026-11-07'), noCat, 'e', 'now'), 403);
});

test('signing marks unticked skills NOT_WITNESSED and records the signer', () => {
  const s = applySignature(awaiting(), supervisor, validateSign({ witnessedSkillIds: [GCS], regNo: 'PA1' }), 'T');
  assert.equal(s.status, 'SIGNED');
  assert.deepEqual(s.skills.map((x) => x.status), ['VERIFIED', 'NOT_WITNESSED']);
  assert.equal(s.signature?.verifierRegNo, 'PA1');
  assert.equal(s.signature?.verifierRole, 'supervisor');
});

test('only the requested verifier can sign, only once, never their own entry', () => {
  const other = { ...supervisor, sub: 'v2' };
  throwsStatus(() => applySignature(awaiting(), other, { witnessedSkillIds: [GCS], regNo: 'x' }, 'T'), 403);
  const signed = applySignature(awaiting(), supervisor, { witnessedSkillIds: [GCS], regNo: 'x' }, 'T');
  throwsStatus(() => applySignature(signed, supervisor, { witnessedSkillIds: [GCS], regNo: 'x' }, 'T'), 409);
  const self = { ...awaiting(), studentSub: 'v1' };
  throwsStatus(() => applySignature(self, supervisor, { witnessedSkillIds: [GCS], regNo: 'x' }, 'T'), 403);
  throwsStatus(() => applySignature(awaiting(), supervisor, { witnessedSkillIds: ['other'], regNo: 'x' }, 'T'), 400);
  throwsStatus(() => applySignature(awaiting(), supervisor, { witnessedSkillIds: [], regNo: 'x' }, 'T'), 400);
  throwsStatus(() => validateSign({ witnessedSkillIds: [GCS] }), 400, /regNo/);
});

test('returning needs a reason and clears the request', () => {
  throwsStatus(() => applyReturn(awaiting(), supervisor, {}, 'T'), 400, /reason/);
  const r = applyReturn(awaiting(), supervisor, { reason: 'Wrong date' }, 'T');
  assert.equal(r.status, 'RETURNED');
  assert.equal(r.request, undefined);
  assert.equal(r.returned?.reason, 'Wrong date');
});

test('progress counts only verified skills on signed entries', () => {
  const signed = applySignature(awaiting(), supervisor, { witnessedSkillIds: [GCS], regNo: 'x' }, 'T');
  const pending = { ...awaiting(), entryId: 'e2' };
  const p = computeProgress([signed, pending], 'ECA');
  const get = (id: string) => p.skills.find((s) => s.skillId === id)!;
  assert.deepEqual([get(GCS).verified, get(GCS).pending, get(GCS).minimum], [1, 1, 70]);
  assert.deepEqual([get(PULSE).verified, get(PULSE).pending], [0, 2]); // not witnessed doesn't count
  assert.deepEqual([get(PATIENTS_SEEN_ID).verified, get(PATIENTS_SEEN_ID).pending], [1, 1]);
  assert.equal(p.totals.met, 0);
});

test('overall percentage caps each skill at its minimum', () => {
  const big: Entry = { ...awaiting(), status: 'SIGNED', kind: 'skills', skills: [{ skillId: GCS, count: 50, status: 'VERIFIED' }] };
  const many = Array.from({ length: 10 }, (_, i) => ({ ...big, entryId: `b${i}` })); // 500 GCS, minimum 70
  const p = computeProgress(many, 'ECA');
  assert.equal(p.skills.find((s) => s.skillId === GCS)!.met, true);
  assert.equal(p.totals.percentComplete, Math.floor((70 / p.totals.required) * 100));
  assert.equal(p.totals.met, 1);
});

test('skills with a zero minimum for a category are excluded from totals', () => {
  const p = computeProgress([], 'ECA');
  assert.ok(p.totals.withMinimum < 139);
  assert.equal(p.totals.percentComplete, 0);
  const ecp = computeProgress([], 'ECP');
  assert.ok(ecp.totals.withMinimum > p.totals.withMinimum);
});

test('parseGroups handles both claim encodings and ignores unknown groups', () => {
  assert.deepEqual(parseGroups('[student lecturer]'), ['student', 'lecturer']);
  assert.deepEqual(parseGroups(['admin', 'hacker']), ['admin']);
  assert.deepEqual(parseGroups(undefined), []);
});
