/**
 * Progress against HPCSA Annexure A and against a college requirement set.
 * Only VERIFIED skills on SIGNED entries count; anything on unsigned entries is "pending".
 * Each signed encounter counts as one patient seen.
 */
import { catalogue, PATIENTS_SEEN_ID, type Category } from './catalogue.js';
import type { Entry } from './domain.js';
import { getProgramme, hpcsaIdFor, loggableSkills } from './requirements.js';

type Tally = { verified: Map<string, number>; pending: Map<string, number> };
const add = (m: Map<string, number>, id: string, n: number) => m.set(id, (m.get(id) ?? 0) + n);

/** Adds up an entry's skills, translating each logged skill id with `key` (null = doesn't count here). */
function tally(entries: Entry[], key: (skillId: string) => string | null, patientsKey: string | null): Tally {
  const t: Tally = { verified: new Map(), pending: new Map() };
  for (const e of entries) {
    const signed = e.status === 'SIGNED';
    const target = signed ? t.verified : t.pending;
    if (e.kind === 'encounter' && patientsKey) add(target, patientsKey, 1);
    for (const s of e.skills) {
      const k = key(s.skillId);
      if (!k || k === patientsKey) continue;
      if (signed && s.status !== 'VERIFIED') continue;
      add(target, k, s.count);
    }
  }
  return t;
}

/** Overall % = verified counts capped at each minimum / sum of minimums, so over-logging one skill can't inflate it. */
function percent(rows: { minimum: number; verified: number }[]) {
  const withMin = rows.filter((r) => r.minimum > 0);
  const required = withMin.reduce((a, r) => a + r.minimum, 0);
  const achieved = withMin.reduce((a, r) => a + Math.min(r.verified, r.minimum), 0);
  return {
    required,
    withMinimum: withMin.length,
    met: withMin.filter((r) => r.verified >= r.minimum).length,
    percentComplete: required === 0 ? 100 : Math.floor((achieved / required) * 100),
  };
}

export interface SkillProgress {
  skillId: string;
  name: string;
  paediatric: boolean;
  minimum: number;
  verified: number;
  pending: number;
  met: boolean;
}

export interface HpcsaProgress {
  category: Category;
  catalogueVersion: string;
  totals: { required: number; met: number; withMinimum: number; percentComplete: number };
  skills: SkillProgress[];
}

export function computeHpcsaProgress(entries: Entry[], category: Category): HpcsaProgress {
  const t = tally(entries, hpcsaIdFor, PATIENTS_SEEN_ID);
  const skills = catalogue.skills.map((s) => {
    const minimum = s.minimums[category];
    const verified = t.verified.get(s.id) ?? 0;
    return { skillId: s.id, name: s.name, paediatric: s.paediatric, minimum, verified, pending: t.pending.get(s.id) ?? 0, met: verified >= minimum };
  });
  return { category, catalogueVersion: catalogue.version, totals: percent(skills), skills };
}

export interface CollegeSkillProgress {
  skillId: string;
  name: string;
  group: string;
  hpcsaSkillId: string | null;
  recordOnly: boolean;
  /** one row per year of study */
  years: { year: number; minimum: number | null; verified: number; pending: number }[];
  thisYear: { minimum: number; verified: number; pending: number; met: boolean };
  total: { minimum: number; verified: number; pending: number; met: boolean };
}

export interface CollegeProgress {
  programmeId: string;
  programmeName: string;
  setName: string;
  studyYear: number;
  years: number;
  thisYear: ReturnType<typeof percent>;
  total: ReturnType<typeof percent>;
  skills: CollegeSkillProgress[];
}

/**
 * College progress for one programme. Entries count toward the year of study stamped on them when logged
 * (entries without a stamp count toward the current year).
 */
export function computeCollegeProgress(entries: Entry[], programmeId: string, studyYear: number): CollegeProgress | null {
  const p = getProgramme(programmeId);
  if (!p) return null;
  const skills = loggableSkills(programmeId);
  const ids = new Set(skills.map((s) => s.id));
  const patients = skills.find((s) => s.derived)?.id ?? null;
  const byYear = new Map<number, Entry[]>();
  for (const e of entries) {
    const y = e.studyYear ?? studyYear;
    byYear.set(y, [...(byYear.get(y) ?? []), e]);
  }
  const tallies = new Map([...byYear].map(([y, es]) => [y, tally(es, (id) => (ids.has(id) ? id : null), patients)]));
  const years = Array.from({ length: p.programme.years }, (_, i) => i + 1);

  const rows: CollegeSkillProgress[] = skills.map((s) => {
    const perYear = years.map((year) => {
      const t = tallies.get(year);
      return { year, minimum: s.yearMinimums?.[year - 1] ?? null, verified: t?.verified.get(s.id) ?? 0, pending: t?.pending.get(s.id) ?? 0 };
    });
    // entries stamped with a year outside the programme still count toward the total
    let extraV = 0, extraP = 0;
    for (const [y, t] of tallies) if (!years.includes(y)) { extraV += t.verified.get(s.id) ?? 0; extraP += t.pending.get(s.id) ?? 0; }
    const cur = perYear[Math.min(studyYear, p.programme.years) - 1];
    const totalMin = perYear.reduce((a, r) => a + (r.minimum ?? 0), 0);
    const totalV = perYear.reduce((a, r) => a + r.verified, 0) + extraV;
    return {
      skillId: s.id, name: s.name, group: s.group, hpcsaSkillId: s.hpcsaSkillId, recordOnly: s.recordOnly,
      years: perYear,
      thisYear: { minimum: cur.minimum ?? 0, verified: cur.verified, pending: cur.pending, met: cur.verified >= (cur.minimum ?? 0) },
      total: { minimum: totalMin, verified: totalV, pending: perYear.reduce((a, r) => a + r.pending, 0) + extraP, met: totalV >= totalMin },
    };
  });
  return {
    programmeId, programmeName: p.programme.name, setName: p.set.name, studyYear, years: p.programme.years,
    thisYear: percent(rows.map((r) => r.thisYear)),
    total: percent(rows.map((r) => r.total)),
    skills: rows,
  };
}

/** Academic year, default 1 February to 30 November (South African HEI calendar); override with ACADEMIC_YEAR="MM-DD:MM-DD". */
export function academicYear(now = new Date(), spec = process.env.ACADEMIC_YEAR ?? '02-01:11-30') {
  const [s, e] = spec.split(':');
  const y = now.getUTCFullYear();
  const start = new Date(`${y}-${s}T00:00:00Z`);
  const end = new Date(`${y}-${e}T23:59:59Z`);
  const fraction = Math.min(1, Math.max(0, (now.getTime() - start.getTime()) / (end.getTime() - start.getTime())));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10), elapsed: Math.round(fraction * 1000) / 1000 };
}

export type PaceStatus = 'on-track' | 'behind' | 'at-risk' | 'no-activity';

/**
 * Compares progress with how far through the year we are. On track: within 10 points of the expected %;
 * behind: within 25; otherwise at risk. Nobody is flagged in the first 10% of the year unless they have no entries.
 */
export function paceStatus(percentComplete: number, elapsed: number, entryCount: number): PaceStatus {
  if (entryCount === 0) return 'no-activity';
  if (elapsed < 0.1) return 'on-track';
  const expected = elapsed * 100;
  if (percentComplete >= expected - 10) return 'on-track';
  if (percentComplete >= expected - 25) return 'behind';
  return 'at-risk';
}
