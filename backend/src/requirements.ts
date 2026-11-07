/** Institution requirement sets (college logbooks) and the skill list each student logs against. */
import data from './requirement-sets.json';
import { catalogue, getSkill as getHpcsaSkill, PATIENTS_SEEN_ID } from './catalogue.js';
import type { CollegeSkill, Programme, RequirementSet } from './requirements-types.js';

export * from './requirements-types.js';

export const requirementSets = (data as { sets: RequirementSet[] }).sets;

const programmeIndex = new Map<string, { set: RequirementSet; programme: Programme }>();
const collegeSkillIndex = new Map<string, CollegeSkill>();
for (const set of requirementSets) {
  for (const programme of set.programmes) programmeIndex.set(programme.id, { set, programme });
  for (const s of set.skills) collegeSkillIndex.set(s.id, s);
}

export const getProgramme = (id: string | undefined) => (id ? programmeIndex.get(id) : undefined);
export const getCollegeSkill = (id: string) => collegeSkillIndex.get(id);
export const setsForInstitution = (institution: string) => requirementSets.filter((s) => s.institution === institution);

/** A skill a student can pick when logging. */
export interface LoggableSkill {
  id: string;
  name: string;
  group: string;
  hpcsaSkillId: string | null;
  derived: boolean;
  recordOnly: boolean;
  collegeSpecific: boolean;
  /** minimum per year of study for the student's programme (college lists only) */
  yearMinimums?: (number | null)[];
}

const offeredIn = (s: CollegeSkill, programmeId: string) => (s.minimums[programmeId] ?? []).some((m) => m !== null);

/** Students on a programme log against its college list; everyone else logs against HPCSA Annexure A. */
export function loggableSkills(programmeId?: string): LoggableSkill[] {
  const p = getProgramme(programmeId);
  if (p) {
    return p.set.skills.filter((s) => offeredIn(s, p.programme.id)).map((s) => ({
      id: s.id, name: s.name, group: s.group, hpcsaSkillId: s.hpcsaSkillId, derived: s.derived,
      recordOnly: s.recordOnly, collegeSpecific: s.collegeSpecific, yearMinimums: s.minimums[p.programme.id],
    }));
  }
  return catalogue.skills.map((s) => ({
    id: s.id, name: s.name, group: s.paediatric ? 'Paediatric' : 'Annexure A', hpcsaSkillId: s.id, derived: s.derived,
    recordOnly: false, collegeSpecific: false,
  }));
}

/** Looks up a skill id that the given programme's students may log. */
export function lookupLoggable(skillId: string, programmeId?: string): LoggableSkill | undefined {
  const p = getProgramme(programmeId);
  if (p) {
    const s = getCollegeSkill(skillId);
    if (!s || !s.id.startsWith(`${p.set.id}/`) || !offeredIn(s, p.programme.id)) return undefined;
    return loggableSkills(programmeId).find((x) => x.id === skillId);
  }
  const h = getHpcsaSkill(skillId);
  return h && loggableSkills().find((x) => x.id === skillId);
}

/** The HPCSA Annexure A skill a logged skill counts toward (null for college-only skills). */
export function hpcsaIdFor(skillId: string): string | null {
  if (getHpcsaSkill(skillId)) return skillId;
  return getCollegeSkill(skillId)?.hpcsaSkillId ?? null;
}

export function skillName(skillId: string): string {
  return getHpcsaSkill(skillId)?.name ?? getCollegeSkill(skillId)?.name ?? skillId;
}

export { PATIENTS_SEEN_ID };
