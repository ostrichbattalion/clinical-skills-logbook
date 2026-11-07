/** Validation rules for institution admins managing people. Pure functions, unit-tested. */
import { CATEGORIES, type Category } from './catalogue.js';
import { setsForInstitution } from './requirements.js';

/** Roles an institution admin may give. New admins are created by the platform operator (scripts/create-user.ts). */
export const MANAGED_ROLES = ['student', 'supervisor', 'lecturer'] as const;
export type ManagedRole = (typeof MANAGED_ROLES)[number];

export interface PersonInput {
  email: string;
  name: string;
  role: ManagedRole;
  programmeId?: string;
  studyYear?: number;
  category?: Category;
  regNo?: string;
}

export interface FieldErrors { [field: string]: string }

const EMAIL = /^[^\s@"\\]+@[^\s@"\\]+\.[^\s@"\\]+$/;
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v).trim());

/** Programmes this institution runs, from its requirement sets. */
export function institutionProgrammes(institution: string) {
  return setsForInstitution(institution).flatMap((s) => s.programmes);
}

/**
 * Checks one person (from the form or a CSV row). Returns the cleaned person, or field errors.
 * Students need a programme and year when the institution has requirement sets; otherwise an HPCSA category.
 */
export function validatePerson(raw: unknown, institution: string): { person?: PersonInput; errors: FieldErrors } {
  const r = (raw ?? {}) as Record<string, unknown>;
  const errors: FieldErrors = {};
  const email = str(r.email).toLowerCase();
  const name = str(r.name).replace(/\s+/g, ' ');
  const role = str(r.role).toLowerCase();
  const programmeId = str(r.programmeId ?? r.programme).toUpperCase();
  const yearRaw = str(r.studyYear ?? r.year);
  const category = str(r.category).toUpperCase();
  const regNo = str(r.regNo ?? r.reg_no).toUpperCase();

  if (!EMAIL.test(email) || email.length > 254) errors.email = 'Enter a valid email address';
  if (name.length < 2 || name.length > 80) errors.name = 'Enter a full name (2 to 80 characters)';
  if (!(MANAGED_ROLES as readonly string[]).includes(role))
    errors.role = role === 'admin' ? 'Administrators are added by the platform operator' : `Role must be one of: ${MANAGED_ROLES.join(', ')}`;
  if (regNo && !/^[A-Z0-9 /-]{2,40}$/.test(regNo)) errors.regNo = 'Registration number: letters, digits, spaces, / or - only';

  const programmes = institutionProgrammes(institution);
  let studyYear: number | undefined;
  let cat: Category | undefined;
  if (role === 'student') {
    if (programmes.length) {
      const p = programmes.find((x) => x.id === programmeId);
      if (!p) errors.programmeId = `Programme must be one of: ${programmes.map((x) => x.id).join(', ')}`;
      else {
        cat = p.category;
        const y = Number(yearRaw);
        if (!Number.isInteger(y) || y < 1 || y > p.years) errors.studyYear = `Year of study must be 1 to ${p.years}`;
        else studyYear = y;
      }
      if (category && p && category !== p.category) errors.category = `${p.name} leads to ${p.category}; leave category empty`;
    } else {
      if (!(CATEGORIES as readonly string[]).includes(category)) errors.category = `Category must be ${CATEGORIES.join(', ')}`;
      else cat = category as Category;
      if (programmeId) errors.programmeId = 'Your institution has no programmes set up; use category instead';
    }
  } else if (role) {
    if (programmeId) errors.programmeId = 'Only students have a programme';
    if (yearRaw) errors.studyYear = 'Only students have a year of study';
    if (category) errors.category = 'Only students have a registration category';
  }

  if (Object.keys(errors).length) return { errors };
  return {
    errors,
    person: {
      email, name, role: role as ManagedRole,
      ...(role === 'student' && programmeId && { programmeId }),
      ...(studyYear && { studyYear }),
      ...(cat && { category: cat }),
      ...(regNo && { regNo }),
    },
  };
}

/** What may change on an existing person. Email and institution are fixed. */
export function validateChanges(raw: unknown, current: { role: string; email: string; programmeId?: string; studyYear?: number; category?: string; regNo?: string; name: string }, institution: string) {
  const r = (raw ?? {}) as Record<string, unknown>;
  const merged = {
    email: current.email,
    name: r.name ?? current.name,
    role: r.role ?? current.role,
    programmeId: 'programmeId' in r ? r.programmeId : current.programmeId,
    studyYear: 'studyYear' in r ? r.studyYear : current.studyYear,
    category: 'category' in r ? r.category : current.programmeId ? undefined : current.category,
    regNo: 'regNo' in r ? r.regNo : current.regNo,
  };
  // switching away from student drops student-only fields
  if (merged.role !== 'student') { merged.programmeId = undefined; merged.studyYear = undefined; merged.category = undefined; }
  return validatePerson(merged, institution);
}

/** Column names accepted in an uploaded class list (CSV), in template order. */
export const IMPORT_COLUMNS = ['email', 'name', 'role', 'programme', 'year', 'reg_no', 'category'] as const;
