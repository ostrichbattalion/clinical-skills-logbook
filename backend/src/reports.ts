/** Institution reports: cohort progress, the HPCSA progress summary and the requirement gap check. Pure functions. */
import { catalogue, type Category } from './catalogue.js';
import type { Caller, Entry } from './domain.js';
import { computeCollegeProgress, computeHpcsaProgress, paceStatus, type PaceStatus } from './progress.js';
import { getProgramme, type RequirementSet } from './requirements.js';

/** A skill is "below pace" when verified < 75% of what the time elapsed would predict. */
const BELOW_PACE_FACTOR = 0.75;
/** A skill is an anticipated difficulty when at least this share of the cohort is below pace on it. */
const DIFFICULTY_SHARE = 0.3;

const groupBy = <T>(xs: T[], k: (x: T) => string) => {
  const m = new Map<string, T[]>();
  for (const x of xs) m.set(k(x), [...(m.get(k(x)) ?? []), x]);
  return m;
};
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

export interface CohortFilter { programmeId?: string; studyYear?: number }

export interface StudentRow {
  sub: string; name: string; email: string;
  programmeId: string | null; programmeName: string | null; studyYear: number | null; category: Category | null;
  entries: number; awaitingSignature: number; lastActivity: string | null;
  hpcsa: { percentComplete: number; met: number; withMinimum: number } | null;
  college: { thisYearPercent: number; totalPercent: number; thisYearMet: number; thisYearWithMinimum: number } | null;
  status: PaceStatus;
}

function studentRow(s: Caller, entries: Entry[], elapsed: number) {
  const hp = s.category ? computeHpcsaProgress(entries, s.category) : null;
  const programme = getProgramme(s.programmeId);
  const cp = programme && s.studyYear ? computeCollegeProgress(entries, programme.programme.id, s.studyYear) : null;
  // pace: college target for this year when the student has one, otherwise the HPCSA total
  const pace = cp ? cp.thisYear.percentComplete : hp?.totals.percentComplete ?? 0;
  const row: StudentRow = {
    sub: s.sub, name: s.name, email: s.email,
    programmeId: programme?.programme.id ?? null, programmeName: programme?.programme.name ?? null,
    studyYear: s.studyYear ?? null, category: s.category ?? null,
    entries: entries.length,
    awaitingSignature: entries.filter((e) => e.status === 'AWAITING_SIGNATURE').length,
    lastActivity: entries.reduce<string | null>((a, e) => (!a || e.performedOn > a ? e.performedOn : a), null),
    hpcsa: hp && { percentComplete: hp.totals.percentComplete, met: hp.totals.met, withMinimum: hp.totals.withMinimum },
    college: cp && { thisYearPercent: cp.thisYear.percentComplete, totalPercent: cp.total.percentComplete, thisYearMet: cp.thisYear.met, thisYearWithMinimum: cp.thisYear.withMinimum },
    status: paceStatus(pace, elapsed, entries.length),
  };
  return { row, hp, cp };
}

const matches = (s: Caller, f: CohortFilter) =>
  (!f.programmeId || (f.programmeId === 'none' ? !getProgramme(s.programmeId) : s.programmeId === f.programmeId)) &&
  (!f.studyYear || s.studyYear === f.studyYear);

export function cohortReport(students: Caller[], entries: Entry[], filter: CohortFilter, elapsed: number, detail = false) {
  const bySub = groupBy(entries, (e) => e.studentSub);
  const chosen = students.filter((s) => matches(s, filter));
  const computed = chosen.map((s) => ({ s, ...studentRow(s, bySub.get(s.sub) ?? [], elapsed) }));

  // Per-skill view for a single programme: this year's college minimums across the cohort
  let skills: unknown[] | null = null;
  const programme = getProgramme(filter.programmeId);
  if (programme) {
    const withCollege = computed.filter((c) => c.cp);
    const byId = new Map<string, { name: string; group: string; hpcsaSkillId: string | null; rows: { min: number; v: number }[] }>();
    for (const c of withCollege) for (const sk of c.cp!.skills) {
      if (sk.thisYear.minimum <= 0) continue;
      const cur = byId.get(sk.skillId) ?? { name: sk.name, group: sk.group, hpcsaSkillId: sk.hpcsaSkillId, rows: [] };
      cur.rows.push({ min: sk.thisYear.minimum, v: sk.thisYear.verified });
      byId.set(sk.skillId, cur);
    }
    skills = [...byId].map(([skillId, x]) => {
      const below = x.rows.filter((r) => r.v < r.min * elapsed * BELOW_PACE_FACTOR).length;
      return {
        skillId, name: x.name, group: x.group, hpcsaSkillId: x.hpcsaSkillId,
        students: x.rows.length, met: x.rows.filter((r) => r.v >= r.min).length, belowPace: below,
        medianVerified: median(x.rows.map((r) => r.v)), typicalMinimum: median(x.rows.map((r) => r.min)),
      };
    }).sort((a, b) => b.belowPace / b.students - a.belowPace / a.students || a.name.localeCompare(b.name));
  }

  const counts = { total: computed.length, 'on-track': 0, behind: 0, 'at-risk': 0, 'no-activity': 0 } as Record<string, number>;
  for (const c of computed) counts[c.row.status]++;

  return {
    students: computed.map((c) => c.row),
    counts,
    skills,
    ...(detail && { detail: computed.flatMap((c) => exportRows(c.s, c.hp, c.cp)) }),
  };
}

/** Flat rows for the spreadsheet export: one per student per skill, college and HPCSA. */
function exportRows(s: Caller, hp: ReturnType<typeof computeHpcsaProgress> | null, cp: ReturnType<typeof computeCollegeProgress>) {
  const base = { student: s.name, email: s.email, programme: cp?.programmeName ?? '', year: s.studyYear ?? '' };
  const college = (cp?.skills ?? []).map((k) => ({
    ...base, framework: 'College', skill: k.name, group: k.group,
    yearMinimum: k.recordOnly ? '' : k.thisYear.minimum, yearVerified: k.thisYear.verified,
    totalMinimum: k.recordOnly ? '' : k.total.minimum, totalVerified: k.total.verified, pending: k.total.pending,
    met: k.recordOnly ? '' : k.total.met ? 'yes' : 'no',
  }));
  const hpcsa = (hp?.skills ?? []).filter((k) => k.minimum > 0 || k.verified > 0).map((k) => ({
    ...base, framework: `HPCSA ${hp!.category}`, skill: k.name, group: k.paediatric ? 'Paediatric' : 'Annexure A',
    yearMinimum: '', yearVerified: '', totalMinimum: k.minimum, totalVerified: k.verified, pending: k.pending,
    met: k.met ? 'yes' : 'no',
  }));
  return [...college, ...hpcsa];
}

/** Sum of a programme's college minimums mapped onto each HPCSA skill, compared with the HPCSA minimum. */
export function gapReport(set: RequirementSet) {
  return {
    setId: set.id, setName: set.name, source: set.source, institution: set.institution,
    programmes: set.programmes.map((p) => {
      const contributions = new Map<string, { total: number; names: string[] }>();
      const collegeOnly: { name: string; total: number }[] = [];
      for (const s of set.skills) {
        const mins = s.minimums[p.id] ?? [];
        const total = mins.reduce<number>((a, m) => a + (m ?? 0), 0);
        if (s.recordOnly || mins.every((m) => m === null)) continue;
        if (!s.hpcsaSkillId) { if (total > 0) collegeOnly.push({ name: s.name, total }); continue; }
        const c = contributions.get(s.hpcsaSkillId) ?? { total: 0, names: [] };
        c.total += total;
        c.names.push(s.name);
        contributions.set(s.hpcsaSkillId, c);
      }
      const rows = catalogue.skills.filter((h) => h.minimums[p.category] > 0).map((h) => {
        const c = contributions.get(h.id);
        const hpcsaMinimum = h.minimums[p.category];
        const collegeMinimum = c?.total ?? 0;
        const status = !c ? 'not-covered' : collegeMinimum >= hpcsaMinimum ? 'ok' : 'short';
        return { hpcsaSkillId: h.id, name: h.name, hpcsaMinimum, collegeMinimum, shortBy: Math.max(0, hpcsaMinimum - collegeMinimum), status, collegeSkills: c?.names ?? [] };
      });
      return {
        programmeId: p.id, programmeName: p.name, category: p.category, years: p.years,
        summary: { ok: rows.filter((r) => r.status === 'ok').length, short: rows.filter((r) => r.status === 'short').length, notCovered: rows.filter((r) => r.status === 'not-covered').length },
        rows: rows.sort((a, b) => (a.status === b.status ? 0 : a.status === 'ok' ? 1 : b.status === 'ok' ? -1 : 0)),
        collegeOnly,
      };
    }),
  };
}

/**
 * Summary in the shape of the PBEC mid-year progress report: for each Annexure A skill with a minimum for the
 * programme's category, how many students have met it and how many are below the pace needed to graduate with it.
 * Expected share by now = (completed years + share of this year elapsed) / years in the programme.
 */
export function hpcsaSummary(students: Caller[], entries: Entry[], programmeId: string, elapsed: number, set: RequirementSet) {
  const p = getProgramme(programmeId);
  if (!p) return null;
  const cohort = students.filter((s) => s.programmeId === programmeId && s.category);
  const bySub = groupBy(entries, (e) => e.studentSub);
  const progress = cohort.map((s) => {
    const es = bySub.get(s.sub) ?? [];
    const expectedShare = Math.min(1, ((Math.min(s.studyYear ?? 1, p.programme.years) - 1) + elapsed) / p.programme.years);
    return { s, hp: computeHpcsaProgress(es, p.programme.category), expectedShare, row: studentRow(s, es, elapsed).row };
  });
  const gap = gapReport(set).programmes.find((g) => g.programmeId === programmeId)!;
  const gapById = new Map(gap.rows.map((r) => [r.hpcsaSkillId, r]));
  const skills = catalogue.skills.filter((h) => h.minimums[p.programme.category] > 0).map((h) => {
    const minimum = h.minimums[p.programme.category];
    const per = progress.map((x) => ({ v: x.hp.skills.find((k) => k.skillId === h.id)!.verified, expected: minimum * x.expectedShare }));
    const below = per.filter((r) => r.v < r.expected * BELOW_PACE_FACTOR).length;
    const g = gapById.get(h.id);
    return {
      skillId: h.id, name: h.name, minimum, students: per.length,
      met: per.filter((r) => r.v >= minimum).length, belowPace: below,
      anticipatedDifficulty: per.length > 0 && below / per.length >= DIFFICULTY_SHARE,
      collegePlan: g ? { status: g.status, collegeMinimum: g.collegeMinimum } : null,
    };
  });
  const byYear: Record<string, number> = {};
  for (const x of progress) byYear[String(x.s.studyYear ?? '?')] = (byYear[String(x.s.studyYear ?? '?')] ?? 0) + 1;
  return {
    institution: set.institution, programmeId, programmeName: p.programme.name, category: p.programme.category,
    years: p.programme.years, cohort: { total: cohort.length, byYear },
    skills,
    anticipatedDifficulties: skills.filter((s) => s.anticipatedDifficulty).length,
    planShortfalls: gap.rows.filter((r) => r.status !== 'ok').map((r) => ({ name: r.name, hpcsaMinimum: r.hpcsaMinimum, collegeMinimum: r.collegeMinimum, status: r.status })),
    studentsAtRisk: progress.filter((x) => x.row.status === 'at-risk' || x.row.status === 'no-activity')
      .map((x) => ({ name: x.s.name, studyYear: x.s.studyYear ?? null, status: x.row.status })),
  };
}
