/**
 * Pure business rules for the logbook core loop: no AWS calls here, so they are unit-tested directly.
 *
 * Lifecycle of an entry:
 *   DRAFT ──request──▶ AWAITING_SIGNATURE ──sign──▶ SIGNED (immutable)
 *     ▲                       │
 *     └──────── RETURNED ◀────┘ return (verifier sends it back with a reason)
 */
import { catalogue, CATEGORIES, getSkill, PATIENTS_SEEN_ID, type Category } from './catalogue.js';

export const ROLES = ['student', 'supervisor', 'lecturer', 'admin'] as const;
export type Role = (typeof ROLES)[number];
export const VERIFIER_ROLES: readonly Role[] = ['supervisor', 'lecturer'];

export type EntryKind = 'encounter' | 'skills';
export type EntryStatus = 'DRAFT' | 'AWAITING_SIGNATURE' | 'RETURNED' | 'SIGNED';
export type SkillStatus = 'CLAIMED' | 'VERIFIED' | 'NOT_WITNESSED';

export interface EntrySkill {
  skillId: string;
  count: number;
  status: SkillStatus;
}

export interface Signature {
  verifierSub: string;
  verifierName: string;
  verifierEmail: string;
  verifierRole: Role;
  verifierRegNo: string;
  signedAt: string;
  comment?: string;
}

export interface Entry {
  entryId: string;
  studentSub: string;
  studentName: string;
  studentEmail: string;
  institution: string;
  category: Category;
  kind: EntryKind;
  performedOn: string; // YYYY-MM-DD
  setting: string;
  encounterRef?: string;
  notes?: string;
  skills: EntrySkill[];
  status: EntryStatus;
  createdAt: string;
  updatedAt: string;
  request?: { verifierSub: string; verifierName: string; verifierEmail: string; requestedAt: string };
  returned?: { by: string; reason: string; at: string };
  signature?: Signature;
}

export interface Caller {
  sub: string;
  email: string;
  name: string;
  roles: Role[];
  institution: string;
  category?: Category;
  regNo?: string;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const MAX_TEXT = 500;
const MAX_COUNT_PER_SKILL = 50;
const MAX_SKILLS_PER_ENTRY = 60;

function text(v: unknown, field: string, { required = false, max = MAX_TEXT } = {}): string | undefined {
  if (v === undefined || v === null || v === '') {
    if (required) throw new HttpError(400, `${field} is required`);
    return undefined;
  }
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be text`);
  const t = v.trim();
  if (required && !t) throw new HttpError(400, `${field} is required`);
  if (t.length > max) throw new HttpError(400, `${field} must be at most ${max} characters`);
  return t || undefined;
}

export function isCategory(v: unknown): v is Category {
  return typeof v === 'string' && (CATEGORIES as readonly string[]).includes(v);
}

export interface NewEntryInput {
  kind: EntryKind;
  performedOn: string;
  setting: string;
  encounterRef?: string;
  notes?: string;
  skills: { skillId: string; count: number }[];
}

/** Validates a student's new log entry. `today` is injected for testability (YYYY-MM-DD). */
export function validateNewEntry(body: unknown, today: string): NewEntryInput {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'Request body must be a JSON object');
  const b = body as Record<string, unknown>;

  if (b.kind !== 'encounter' && b.kind !== 'skills') throw new HttpError(400, 'kind must be "encounter" or "skills"');

  const performedOn = text(b.performedOn, 'performedOn', { required: true })!;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(performedOn) || Number.isNaN(Date.parse(performedOn)))
    throw new HttpError(400, 'performedOn must be a date (YYYY-MM-DD)');
  if (performedOn > today) throw new HttpError(400, 'performedOn cannot be in the future');

  if (!Array.isArray(b.skills) || b.skills.length === 0) throw new HttpError(400, 'Add at least one skill');
  if (b.skills.length > MAX_SKILLS_PER_ENTRY) throw new HttpError(400, `At most ${MAX_SKILLS_PER_ENTRY} skills per entry`);

  const seen = new Set<string>();
  const skills = b.skills.map((s: unknown) => {
    const { skillId, count } = (s ?? {}) as Record<string, unknown>;
    if (typeof skillId !== 'string') throw new HttpError(400, 'Each skill needs a skillId');
    const skill = getSkill(skillId);
    if (!skill) throw new HttpError(400, `Unknown skill: ${skillId}`);
    if (skill.derived) throw new HttpError(400, `${skill.name} is counted automatically from signed encounters`);
    if (seen.has(skillId)) throw new HttpError(400, `${skill.name} is listed twice`);
    seen.add(skillId);
    const n = count === undefined ? 1 : count;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_COUNT_PER_SKILL)
      throw new HttpError(400, `Count for ${skill.name} must be a whole number from 1 to ${MAX_COUNT_PER_SKILL}`);
    return { skillId, count: n };
  });

  return {
    kind: b.kind,
    performedOn,
    setting: text(b.setting, 'setting', { required: true, max: 120 })!,
    encounterRef: text(b.encounterRef, 'encounterRef', { max: 60 }),
    notes: text(b.notes, 'notes'),
    skills,
  };
}

export function buildEntry(input: NewEntryInput, student: Caller, entryId: string, now: string): Entry {
  if (!student.category) throw new HttpError(403, 'Your account has no registration category; ask an administrator to set it');
  return {
    entryId,
    studentSub: student.sub,
    studentName: student.name,
    studentEmail: student.email,
    institution: student.institution,
    category: student.category,
    kind: input.kind,
    performedOn: input.performedOn,
    setting: input.setting,
    ...(input.encounterRef && { encounterRef: input.encounterRef }),
    ...(input.notes && { notes: input.notes }),
    skills: input.skills.map((s) => ({ ...s, status: 'CLAIMED' as const })),
    status: 'DRAFT',
    createdAt: now,
    updatedAt: now,
  };
}

export function canRequestSignature(entry: Entry): boolean {
  return entry.status === 'DRAFT' || entry.status === 'RETURNED';
}

export interface SignInput {
  witnessedSkillIds: string[];
  regNo: string;
  comment?: string;
}

export function validateSign(body: unknown): SignInput {
  const b = (body ?? {}) as Record<string, unknown>;
  if (!Array.isArray(b.witnessedSkillIds) || !b.witnessedSkillIds.every((x) => typeof x === 'string'))
    throw new HttpError(400, 'witnessedSkillIds must be a list of skill ids');
  return {
    witnessedSkillIds: b.witnessedSkillIds as string[],
    regNo: text(b.regNo, 'regNo (professional registration number)', { required: true, max: 40 })!,
    comment: text(b.comment, 'comment'),
  };
}

/** Applies a verifier's signature. Skills not ticked are recorded as NOT_WITNESSED; nothing is deleted. */
export function applySignature(entry: Entry, verifier: Caller, input: SignInput, now: string): Entry {
  assertCanActOn(entry, verifier);
  const claimed = new Set(entry.skills.map((s) => s.skillId));
  for (const id of input.witnessedSkillIds)
    if (!claimed.has(id)) throw new HttpError(400, `Skill ${id} is not part of this entry`);
  if (input.witnessedSkillIds.length === 0)
    throw new HttpError(400, 'Tick at least one witnessed skill, or return the entry to the student instead');
  const witnessed = new Set(input.witnessedSkillIds);
  return {
    ...entry,
    skills: entry.skills.map((s) => ({ ...s, status: witnessed.has(s.skillId) ? 'VERIFIED' : 'NOT_WITNESSED' })),
    status: 'SIGNED',
    updatedAt: now,
    signature: {
      verifierSub: verifier.sub,
      verifierName: verifier.name,
      verifierEmail: verifier.email,
      verifierRole: verifier.roles.includes('lecturer') ? 'lecturer' : 'supervisor',
      verifierRegNo: input.regNo,
      signedAt: now,
      ...(input.comment && { comment: input.comment }),
    },
  };
}

export function applyReturn(entry: Entry, verifier: Caller, body: unknown, now: string): Entry {
  assertCanActOn(entry, verifier);
  const reason = text((body as Record<string, unknown> | null)?.reason, 'reason', { required: true })!;
  const { request: _request, ...rest } = entry;
  return { ...rest, status: 'RETURNED', updatedAt: now, returned: { by: verifier.name, reason, at: now } };
}

function assertCanActOn(entry: Entry, verifier: Caller) {
  if (entry.status !== 'AWAITING_SIGNATURE') throw new HttpError(409, 'This entry is not awaiting a signature');
  if (entry.request?.verifierSub !== verifier.sub) throw new HttpError(403, 'This entry was sent to a different verifier');
  if (entry.studentSub === verifier.sub) throw new HttpError(403, 'You cannot sign your own entry');
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

export interface Progress {
  category: Category;
  catalogueVersion: string;
  totals: { required: number; met: number; withMinimum: number; percentComplete: number };
  skills: SkillProgress[];
}

/**
 * Counts toward Annexure A: only VERIFIED skills on SIGNED entries count. Pending = claimed on entries that
 * are draft, returned or awaiting a signature. Each signed encounter counts as one patient seen.
 */
export function computeProgress(entries: Entry[], category: Category): Progress {
  const verified = new Map<string, number>();
  const pending = new Map<string, number>();
  const add = (m: Map<string, number>, id: string, n: number) => m.set(id, (m.get(id) ?? 0) + n);

  for (const e of entries) {
    if (e.status === 'SIGNED') {
      if (e.kind === 'encounter') add(verified, PATIENTS_SEEN_ID, 1);
      for (const s of e.skills) if (s.status === 'VERIFIED') add(verified, s.skillId, s.count);
    } else {
      if (e.kind === 'encounter') add(pending, PATIENTS_SEEN_ID, 1);
      for (const s of e.skills) add(pending, s.skillId, s.count);
    }
  }

  const skills = catalogue.skills.map((s) => {
    const minimum = s.minimums[category];
    const v = verified.get(s.id) ?? 0;
    return { skillId: s.id, name: s.name, paediatric: s.paediatric, minimum, verified: v, pending: pending.get(s.id) ?? 0, met: v >= minimum };
  });

  // Overall % = verified counts (capped at each minimum) / sum of minimums, so one over-logged skill can't inflate it.
  const withMin = skills.filter((s) => s.minimum > 0);
  const required = withMin.reduce((a, s) => a + s.minimum, 0);
  const achieved = withMin.reduce((a, s) => a + Math.min(s.verified, s.minimum), 0);
  return {
    category,
    catalogueVersion: catalogue.version,
    totals: {
      required,
      met: withMin.filter((s) => s.met).length,
      withMinimum: withMin.length,
      percentComplete: required === 0 ? 100 : Math.floor((achieved / required) * 100),
    },
    skills,
  };
}
