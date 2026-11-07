import type { Category } from './catalogue-types.js';

export interface Programme {
  id: string; // e.g. WCG-DIPEMC
  name: string;
  category: Category; // HPCSA registration category it leads to
  years: number;
}

export interface CollegeSkill {
  id: string; // "<setId>/<slug>"
  name: string;
  group: string;
  hpcsaSkillId: string | null; // null = college-only skill
  collegeSpecific: boolean;
  recordOnly: boolean; // e.g. medications: logged and counted, no minimum
  derived: boolean; // patients seen: counted from signed encounters
  note?: string;
  /** per programme id: minimum for each year of study (index 0 = year 1); null = not in that year's list */
  minimums: Record<string, (number | null)[]>;
}

export interface RequirementSet {
  id: string;
  institution: string;
  name: string;
  source: string;
  programmes: Programme[];
  skills: CollegeSkill[];
}
