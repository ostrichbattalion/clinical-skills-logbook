import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getProgramme, hpcsaIdFor, loggableSkills, lookupLoggable, requirementSets } from '../src/requirements.js';
import { computeCollegeProgress, computeHpcsaProgress, paceStatus } from '../src/progress.js';
import { cohortReport, gapReport, hpcsaSummary } from '../src/reports.js';
import { validateNewEntry, buildEntry, type Caller, type Entry } from '../src/domain.js';

const set = requirementSets.find((s) => s.id === 'wcg-cec-2024')!;
const DIP = 'WCG-DIPEMC', HC = 'WCG-HCEMC';
const id = (slug: string) => `wcg-cec-2024/${slug}`;
const GCS = id('glasgow-coma-scale-adult');
const NEEDLE_CRIC = id('needle-cricothyroidotomy');
const ADRENALINE = id('med-adrenaline');

test('WCG requirement set loads with both programmes and mapped skills', () => {
  assert.equal(set.skills.length, 160);
  assert.deepEqual(set.programmes.map((p) => [p.id, p.category, p.years]), [[HC, 'ECA', 1], [DIP, 'PARAMEDIC', 3]]);
  assert.equal(hpcsaIdFor(GCS), 'glasgow-coma-scale-gcs-score');
  assert.equal(hpcsaIdFor(NEEDLE_CRIC), null);
  assert.equal(hpcsaIdFor('glasgow-coma-scale-gcs-score'), 'glasgow-coma-scale-gcs-score');
  assert.deepEqual(set.skills.find((s) => s.id === GCS)!.minimums, { [HC]: [70], [DIP]: [45, 60, 40] });
});

test('students log against their own programme list only', () => {
  assert.ok(lookupLoggable(GCS, DIP));
  assert.equal(lookupLoggable('glasgow-coma-scale-gcs-score', DIP), undefined, 'HPCSA ids are not loggable for programme students');
  assert.ok(lookupLoggable('glasgow-coma-scale-gcs-score'), 'HPCSA-only students log HPCSA ids');
  assert.equal(lookupLoggable(GCS), undefined);
  // a diploma-only skill is not offered to the higher certificate
  const dipOnly = loggableSkills(DIP).find((s) => !loggableSkills(HC).some((h) => h.id === s.id))!;
  assert.equal(lookupLoggable(dipOnly.id, HC), undefined);
  assert.ok(loggableSkills(HC).length < loggableSkills(DIP).length);
  assert.ok(lookupLoggable(ADRENALINE, HC)!.recordOnly);
});

const student = (over: Partial<Caller> = {}): Caller => ({
  sub: 's1', email: 's@x', name: 'Stu', roles: ['student'], institution: set.institution, category: 'PARAMEDIC', programmeId: DIP, studyYear: 2, ...over,
});

function signed(skills: [string, number][], studyYear: number, kind: 'encounter' | 'skills' = 'skills', sub = 's1', i = 0): Entry {
  const e = buildEntry(
    validateNewEntry({ kind, performedOn: '2026-03-01', setting: 'Ambulance', skills: skills.map(([skillId, count]) => ({ skillId, count })) }, '2026-11-07', (x) => lookupLoggable(x, DIP)),
    student({ sub, studyYear }), `e${sub}${studyYear}${i}`, 'T');
  return { ...e, status: 'SIGNED', skills: e.skills.map((s) => ({ ...s, status: 'VERIFIED' })) };
}

test('entries are stamped with programme and year, and counted per year', () => {
  const y1 = signed([[GCS, 10]], 1, 'encounter');
  const y2 = signed([[GCS, 30], [NEEDLE_CRIC, 1], [ADRENALINE, 2]], 2, 'encounter', 's1', 1);
  assert.equal(y1.programmeId, DIP);
  assert.equal(y1.studyYear, 1);
  const cp = computeCollegeProgress([y1, y2], DIP, 2)!;
  const gcs = cp.skills.find((s) => s.skillId === GCS)!;
  assert.deepEqual(gcs.years.map((y) => [y.minimum, y.verified]), [[45, 10], [60, 30], [40, 0]]);
  assert.deepEqual(gcs.thisYear, { minimum: 60, verified: 30, pending: 0, met: false });
  assert.deepEqual([gcs.total.minimum, gcs.total.verified], [145, 40]);
  const patients = cp.skills.find((s) => s.skillId === id('total-number-of-patients-seen-and-documented'))!;
  assert.deepEqual(patients.years.map((y) => y.verified), [1, 1, 0]);
  assert.equal(cp.skills.find((s) => s.skillId === ADRENALINE)!.total.verified, 2);
  // HPCSA view sees the mapped college skills; college-only and medications don't count there
  const hp = computeHpcsaProgress([y1, y2], 'PARAMEDIC');
  assert.equal(hp.skills.find((s) => s.skillId === 'glasgow-coma-scale-gcs-score')!.verified, 40);
  assert.equal(hp.skills.find((s) => s.skillId === 'patients-seen')!.verified, 2);
});

test('missing programme set-up blocks logging with a clear message', () => {
  const input = validateNewEntry({ kind: 'skills', performedOn: '2026-03-01', setting: 'x', skills: [{ skillId: GCS }] }, '2026-11-07', (x) => lookupLoggable(x, DIP));
  assert.throws(() => buildEntry(input, student({ studyYear: undefined }), 'e', 'T'), /year of study/);
  assert.throws(() => buildEntry(input, student({ programmeId: 'NOPE' }), 'e', 'T'), /programme/);
});

test('gap check reproduces the diploma shortfalls against HPCSA Paramedic', () => {
  const dip = gapReport(set).programmes.find((p) => p.programmeId === DIP)!;
  const row = (hid: string) => dip.rows.find((r) => r.hpcsaSkillId === hid)!;
  assert.deepEqual([row('glasgow-coma-scale-gcs-score').collegeMinimum, row('glasgow-coma-scale-gcs-score').status], [145, 'ok']);
  assert.ok(dip.summary.short > 0);
  for (const r of dip.rows) assert.equal(r.status === 'ok', r.collegeMinimum >= r.hpcsaMinimum);
  assert.ok(dip.collegeOnly.some((c) => c.name === 'Needle cricothyroidotomy'));
});

test('pace status thresholds', () => {
  assert.equal(paceStatus(0, 0.5, 0), 'no-activity');
  assert.equal(paceStatus(0, 0.05, 3), 'on-track');
  assert.equal(paceStatus(45, 0.5, 3), 'on-track');
  assert.equal(paceStatus(30, 0.5, 3), 'behind');
  assert.equal(paceStatus(10, 0.5, 3), 'at-risk');
});

test('cohort report and HPCSA summary', () => {
  const students = [student({ sub: 'a', name: 'Ann' }), student({ sub: 'b', name: 'Ben' }), student({ sub: 'c', name: 'Cat', programmeId: HC, category: 'ECA', studyYear: 1 })];
  const entries = [signed([[GCS, 30]], 2, 'skills', 'a', 1), signed([[GCS, 30]], 2, 'skills', 'a', 2)]; // Ann met this year's GCS; Ben has nothing
  const r = cohortReport(students, entries, { programmeId: DIP }, 0.5, true);
  assert.deepEqual(r.students.map((s) => [s.name, s.status]), [['Ann', 'at-risk'], ['Ben', 'no-activity']]);
  assert.equal(r.counts.total, 2);
  const gcs = (r.skills as any[]).find((s) => s.skillId === GCS);
  assert.deepEqual([gcs.students, gcs.met, gcs.belowPace], [2, 1, 1]);
  assert.ok((r as any).detail.some((d: any) => d.student === 'Ann' && d.framework === 'College' && d.skill === 'Glasgow coma scale - adult' && d.yearVerified === 60));
  assert.ok((r as any).detail.some((d: any) => d.framework === 'HPCSA PARAMEDIC'));
  assert.equal(cohortReport(students, entries, {}, 0.5).students.length, 3);

  const sum = hpcsaSummary(students, entries, DIP, 0.5, set)!;
  assert.equal(sum.cohort.total, 2);
  const g = sum.skills.find((s) => s.skillId === 'glasgow-coma-scale-gcs-score')!;
  // year 2 halfway: expected share (1 + 0.5) / 3 = 0.5 of 140 = 70; Ann has 60 (>= 52.5), Ben 0
  assert.deepEqual([g.minimum, g.met, g.belowPace, g.anticipatedDifficulty], [140, 0, 1, true]);
  assert.ok(sum.planShortfalls.length > 0);
  assert.deepEqual(sum.studentsAtRisk.map((s) => s.name).sort(), ['Ann', 'Ben']);
});
