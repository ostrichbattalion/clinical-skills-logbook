import { createHash, randomBytes } from 'node:crypto';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { callerFromEvent, requireRole } from './auth.js';
import * as db from './db.js';
import {
  applyReturn,
  applySignature,
  buildEntry,
  canRequestSignature,
  HttpError,
  validateNewEntry,
  validateSign,
  VERIFIER_ROLES,
  type Caller,
  type Entry,
} from './domain.js';
import { academicYear, computeCollegeProgress, computeHpcsaProgress } from './progress.js';
import { cohortReport, gapReport, hpcsaSummary } from './reports.js';
import { getProgramme, loggableSkills, lookupLoggable, setsForInstitution, skillName } from './requirements.js';
import { findUserByEmail, findUserBySub, listStudents } from './users.js';
import { institutionProgrammes, validateChanges, validatePerson } from './admin.js';
import * as people from './admin-users.js';
import { buildSignRequest, hashToken, newToken, planClaim, validateToken } from './sign-requests.js';

type Event = APIGatewayProxyEventV2WithJWTAuthorizer;

const IMPORT_BATCH = 50; // rows per import request; the page sends a class list in batches

/** 422 with per-field messages, so forms and the import preview can show them next to the field. */
function fieldErrors(errors: Record<string, string>): never {
  throw Object.assign(new HttpError(422, Object.values(errors)[0] ?? 'Check the highlighted fields'), { fields: errors });
}

const describe = (p: { role: string; programmeId?: string; studyYear?: number; regNo?: string; name: string }) =>
  [p.name, p.role, p.programmeId && `${p.programmeId} year ${p.studyYear}`, p.regNo && `reg ${p.regNo}`].filter(Boolean).join(', ');

async function audit(caller: Caller, action: string, targetEmail?: string, details?: string) {
  await db.putAudit({
    institution: caller.institution, at: new Date().toISOString(), actorSub: caller.sub, actorName: caller.name, action,
    ...(targetEmail && { targetEmail }), ...(details && { details }),
  });
}

async function loadPerson(caller: Caller, sub: string) {
  const rec = (await people.listInstitutionPeople(caller.institution)).find((p) => p.sub === sub);
  if (!rec) throw new HttpError(404, 'No one with that id at your institution');
  if (rec.roles.includes('admin')) throw new HttpError(403, 'Administrator accounts are managed by the platform operator');
  return rec;
}

const MAX_ENTRIES_PER_REQUEST = 25; // DynamoDB transaction limit is 100; keep sign-off batches readable

/** Time-sortable id: 9 chars of base-36 milliseconds + 12 random hex chars. */
export function newEntryId(now = Date.now()) {
  return `${now.toString(36).padStart(9, '0')}-${randomBytes(6).toString('hex')}`;
}

/**
 * Entries logged offline carry a client-made id (a UUID) and the time they were recorded on the phone. The entry id
 * is derived from them, so uploading the same entry twice (e.g. the reply was lost) can't create a duplicate.
 */
export function offlineEntryId(studentSub: string, clientId: string, recordedAt: number, now = Date.now()) {
  const t = Math.min(now, Math.max(now - 60 * 86_400_000, Math.round(recordedAt)));
  return `${t.toString(36).padStart(9, '0')}-${createHash('sha256').update(`${studentSub}:${clientId}`).digest('hex').slice(0, 12)}`;
}

function parseOffline(b: unknown) {
  const { clientId, recordedAt } = (b ?? {}) as { clientId?: unknown; recordedAt?: unknown };
  if (clientId === undefined) return null;
  if (typeof clientId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId))
    throw new HttpError(400, 'clientId must be a UUID');
  if (typeof recordedAt !== 'number' || !Number.isFinite(recordedAt)) throw new HttpError(400, 'recordedAt must be a timestamp');
  return { clientId: clientId.toLowerCase(), recordedAt };
}

const todayInSA = () => new Date(Date.now() + 2 * 3600_000).toISOString().slice(0, 10); // SAST, no DST

function body(event: Event): unknown {
  if (!event.body) return {};
  try {
    return JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body);
  } catch {
    throw new HttpError(400, 'Body must be valid JSON');
  }
}

const param = (event: Event, name: string) => {
  const v = event.pathParameters?.[name];
  if (!v) throw new HttpError(400, `Missing ${name}`);
  return v;
};

/** What a student or verifier sees of an entry: adds skill names so any client can show college skills. */
const view = (e: Entry) => ({ ...e, skills: e.skills.map((s) => ({ ...s, name: skillName(s.skillId) })) });

async function loadAssigned(event: Event, caller: Caller) {
  requireRole(caller, ...VERIFIER_ROLES);
  const entry = await db.getEntry(param(event, 'studentSub'), param(event, 'entryId'));
  if (!entry || entry.request?.verifierSub !== caller.sub || entry.status !== 'AWAITING_SIGNATURE')
    throw new HttpError(404, 'No entry awaiting your signature with that id');
  return entry;
}

const routes: Record<string, (event: Event, caller: Caller) => Promise<unknown>> = {
  'GET /me': async (_e, caller) => caller,

  'GET /catalogue': async (_e, caller) => {
    const programme = getProgramme(caller.programmeId);
    const year = caller.studyYear ?? 1;
    return {
      framework: programme ? 'college' : 'hpcsa',
      source: programme ? programme.set.source : 'HPCSA PBEC Annexure A (14 March 2021)',
      programme: programme ? { id: programme.programme.id, name: programme.programme.name, years: programme.programme.years } : null,
      studyYear: programme ? year : null,
      category: caller.category ?? null,
      skills: loggableSkills(programme?.programme.id).map((s) => ({
        id: s.id, name: s.name, group: s.group, derived: s.derived, recordOnly: s.recordOnly, hpcsaSkillId: s.hpcsaSkillId,
        minimumThisYear: programme ? s.yearMinimums?.[year - 1] ?? null : null,
      })),
    };
  },

  'GET /entries': async (_e, caller) => {
    requireRole(caller, 'student');
    return { entries: (await db.listEntries(caller.sub)).map(view) };
  },

  'POST /entries': async (event, caller) => {
    requireRole(caller, 'student');
    const b = body(event);
    const input = validateNewEntry(b, todayInSA(), (id) => lookupLoggable(id, caller.programmeId));
    const offline = parseOffline(b);
    const entryId = offline ? offlineEntryId(caller.sub, offline.clientId, offline.recordedAt) : newEntryId();
    const entry = buildEntry(input, caller, entryId, new Date().toISOString());
    try {
      await db.createEntry(entry);
    } catch (err) {
      if (offline && (err as Error).name === 'ConditionalCheckFailedException') {
        const existing = await db.getEntry(caller.sub, entryId);
        if (existing) return { entry: view(existing), duplicate: true };
      }
      throw err;
    }
    return { entry: view(entry) };
  },

  'DELETE /entries/{entryId}': async (event, caller) => {
    requireRole(caller, 'student');
    try {
      await db.deleteDraft(caller.sub, param(event, 'entryId'));
    } catch (err) {
      if ((err as Error).name === 'ConditionalCheckFailedException')
        throw new HttpError(409, 'Only draft or returned entries can be deleted');
      throw err;
    }
    return { deleted: true };
  },

  'POST /entries/request-signature': async (event, caller) => {
    requireRole(caller, 'student');
    const b = body(event) as { entryIds?: unknown; verifierEmail?: unknown };
    if (!Array.isArray(b.entryIds) || b.entryIds.length === 0 || !b.entryIds.every((x) => typeof x === 'string'))
      throw new HttpError(400, 'Choose at least one entry');
    if (b.entryIds.length > MAX_ENTRIES_PER_REQUEST)
      throw new HttpError(400, `Request at most ${MAX_ENTRIES_PER_REQUEST} entries at a time`);
    if (typeof b.verifierEmail !== 'string' || !b.verifierEmail.includes('@'))
      throw new HttpError(400, "Enter the supervisor's or lecturer's email address");

    const verifier = await findUserByEmail(b.verifierEmail);
    if (!verifier || !verifier.roles.some((r) => VERIFIER_ROLES.includes(r)))
      throw new HttpError(404, 'No supervisor or lecturer account uses that email address');
    if (verifier.sub === caller.sub) throw new HttpError(400, 'You cannot sign your own entries');

    const ids = [...new Set(b.entryIds as string[])];
    const entries = await Promise.all(ids.map((id) => db.getEntry(caller.sub, id)));
    const now = new Date().toISOString();
    const changes = entries.map((before, i) => {
      if (!before) throw new HttpError(404, `Entry ${ids[i]} not found`);
      if (!canRequestSignature(before)) throw new HttpError(409, `Entry from ${before.performedOn} is already ${before.status.toLowerCase().replace('_', ' ')}`);
      const after: Entry = {
        ...before,
        status: 'AWAITING_SIGNATURE',
        updatedAt: now,
        request: { verifierSub: verifier.sub, verifierName: verifier.name, verifierEmail: verifier.email, requestedAt: now },
      };
      return { before, after };
    });
    await db.replaceEntries(changes);
    return { requested: changes.length, verifier: { name: verifier.name, email: verifier.email } };
  },

  'POST /entries/sign-requests': async (event, caller) => {
    requireRole(caller, 'student');
    const ids = (body(event) as { entryIds?: unknown }).entryIds;
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string')) throw new HttpError(400, 'Choose at least one entry');
    const unique = [...new Set(ids as string[])];
    const entries = await Promise.all(unique.map((id) => db.getEntry(caller.sub, id)));
    if (entries.some((e) => !e)) throw new HttpError(404, 'One of those entries was not found');
    const token = newToken();
    const req = buildSignRequest(caller, entries as Entry[], token, new Date());
    await db.putSignRequest(req);
    return { token, expiresAt: req.expiresAt, entries: req.entryIds.length };
  },

  'POST /sign-requests/claim': async (event, caller) => {
    const token = validateToken((body(event) as { token?: unknown }).token);
    const req = await db.getSignRequest(hashToken(token));
    const entries = req ? await Promise.all(req.entryIds.map((id) => db.getEntry(req.studentSub, id))) : [];
    const { claimed, changes } = planClaim(req, entries, caller, new Date());
    await db.claimSignRequest(claimed, changes);
    return { studentName: claimed.studentName, studentSub: claimed.studentSub, entries: changes.map((c) => view(c.after)) };
  },

  'GET /progress': async (event, caller) => {
    const studentSub = event.queryStringParameters?.studentSub ?? caller.sub;
    let student: Caller | undefined = caller;
    if (studentSub !== caller.sub) {
      requireRole(caller, 'lecturer', 'admin');
      student = await findUserBySub(studentSub);
      if (!student || !student.roles.includes('student') || student.institution !== caller.institution)
        throw new HttpError(404, 'No student with that id at your institution');
    } else requireRole(caller, 'student');
    if (!student.category) throw new HttpError(409, 'This student has no registration category set');
    const entries = await db.listEntries(studentSub);
    const programme = getProgramme(student.programmeId);
    return {
      student: { sub: student.sub, name: student.name, institution: student.institution, programmeId: student.programmeId ?? null, studyYear: student.studyYear ?? null },
      academicYear: academicYear(),
      hpcsa: computeHpcsaProgress(entries, student.category),
      college: programme ? computeCollegeProgress(entries, programme.programme.id, student.studyYear ?? 1) : null,
    };
  },

  'GET /reports/cohort': async (event, caller) => {
    requireRole(caller, 'lecturer', 'admin');
    const q = event.queryStringParameters ?? {};
    const studyYear = q.year ? Number(q.year) : undefined;
    if (studyYear !== undefined && !(Number.isInteger(studyYear) && studyYear >= 1 && studyYear <= 6)) throw new HttpError(400, 'year must be 1 to 6');
    const [students, entries] = await Promise.all([listStudents(caller.institution), db.listInstitutionEntries(caller.institution)]);
    const year = academicYear();
    return {
      institution: caller.institution,
      generatedAt: new Date().toISOString(),
      academicYear: year,
      programmes: [
        ...setsForInstitution(caller.institution).flatMap((s) => s.programmes.map((p) => ({ id: p.id, name: p.name, years: p.years, category: p.category }))),
        ...(students.some((s) => !getProgramme(s.programmeId)) ? [{ id: 'none', name: 'No programme (HPCSA only)', years: 1, category: null }] : []),
      ],
      filter: { programmeId: q.programme ?? null, studyYear: studyYear ?? null },
      ...cohortReport(students, entries, { programmeId: q.programme || undefined, studyYear }, year.elapsed, q.detail === '1'),
    };
  },

  'GET /reports/hpcsa-summary': async (event, caller) => {
    requireRole(caller, 'lecturer', 'admin');
    const programmeId = event.queryStringParameters?.programme;
    const set = setsForInstitution(caller.institution).find((s) => s.programmes.some((p) => p.id === programmeId));
    if (!programmeId || !set) throw new HttpError(404, 'Choose a programme run by your institution');
    const [students, entries] = await Promise.all([listStudents(caller.institution), db.listInstitutionEntries(caller.institution)]);
    const year = academicYear();
    return { generatedAt: new Date().toISOString(), academicYear: year, ...hpcsaSummary(students, entries, programmeId, year.elapsed, set) };
  },

  'GET /reports/gap': async (_e, caller) => {
    requireRole(caller, 'lecturer', 'admin');
    const sets = setsForInstitution(caller.institution);
    if (!sets.length) throw new HttpError(404, 'No requirement set is loaded for your institution');
    return { sets: sets.map(gapReport) };
  },

  // ---------------- institution admin: people ----------------
  'GET /admin/people': async (_e, caller) => {
    requireRole(caller, 'admin');
    const list = await people.listInstitutionPeople(caller.institution);
    return {
      institution: caller.institution,
      programmes: institutionProgrammes(caller.institution),
      people: list.map(({ username: _u, institution: _i, ...p }) => ({ ...p, self: p.sub === caller.sub })),
    };
  },

  'POST /admin/people': async (event, caller) => {
    requireRole(caller, 'admin');
    const { person, errors } = validatePerson(body(event), caller.institution);
    if (!person) return fieldErrors(errors);
    try {
      const sub = await people.createPerson(person, caller.institution);
      await audit(caller, 'Added', person.email, describe(person));
      return { created: { sub, email: person.email } };
    } catch (err) {
      if (err instanceof people.AlreadyExists) throw new HttpError(409, err.message);
      throw err;
    }
  },

  'POST /admin/people/import': async (event, caller) => {
    requireRole(caller, 'admin');
    const b = body(event) as { rows?: unknown; dryRun?: unknown };
    if (!Array.isArray(b.rows) || b.rows.length === 0) throw new HttpError(400, 'No rows to import');
    if (b.rows.length > IMPORT_BATCH) throw new HttpError(400, `Send at most ${IMPORT_BATCH} rows at a time`);
    const dryRun = b.dryRun !== false;
    const seen = new Set<string>();
    const checked = await people.mapLimit(b.rows as unknown[], 4, async (row, i) => {
      const { person, errors } = validatePerson(row, caller.institution);
      if (person) {
        // record the email before awaiting anything: rows are checked concurrently
        const duplicate = seen.has(person.email);
        seen.add(person.email);
        if (duplicate) errors.email = 'This email appears more than once in the file';
        else if (await people.emailExists(person.email)) errors.email = 'Already has an account';
      }
      return { row: i, email: person?.email ?? String((row as Record<string, unknown>)?.email ?? ''), person: Object.keys(errors).length ? undefined : person, errors };
    });
    if (dryRun) return { dryRun: true, results: checked.map(({ person, ...r }) => ({ ...r, ok: !!person })) };
    const results = await people.mapLimit(checked, 4, async (c) => {
      if (!c.person) return { row: c.row, email: c.email, ok: false, errors: c.errors };
      try {
        await people.createPerson(c.person, caller.institution);
        return { row: c.row, email: c.email, ok: true, errors: {} };
      } catch (err) {
        return { row: c.row, email: c.email, ok: false, errors: { email: err instanceof people.AlreadyExists ? 'Already has an account' : 'Could not create this account' } };
      }
    });
    const created = results.filter((r) => r.ok).length;
    if (created) await audit(caller, 'Imported', undefined, `${created} account${created === 1 ? '' : 's'} from a class list`);
    return { dryRun: false, results };
  },

  'POST /admin/people/promote': async (event, caller) => {
    requireRole(caller, 'admin');
    const subs = (body(event) as { subs?: unknown }).subs;
    if (!Array.isArray(subs) || subs.length === 0 || !subs.every((x) => typeof x === 'string')) throw new HttpError(400, 'Choose at least one student');
    if (subs.length > 500) throw new HttpError(400, 'Move at most 500 students at a time');
    const all = new Map((await people.listInstitutionPeople(caller.institution)).map((p) => [p.sub, p]));
    const results = await people.mapLimit([...new Set(subs as string[])], 4, async (sub) => {
      const rec = all.get(sub);
      if (!rec || !rec.roles.includes('student')) return { sub, ok: false, message: 'Not a student at your institution' };
      const p = getProgramme(rec.programmeId);
      if (!p || !rec.studyYear) return { sub, name: rec.name, ok: false, message: 'No programme or year set' };
      if (rec.studyYear >= p.programme.years) return { sub, name: rec.name, ok: false, message: `Already in the final year (${rec.studyYear})` };
      await people.setStudyYear(rec, rec.studyYear + 1);
      return { sub, name: rec.name, ok: true, message: `Year ${rec.studyYear} → ${rec.studyYear + 1}` };
    });
    const moved = results.filter((r) => r.ok).length;
    if (moved) await audit(caller, 'Moved to next year', undefined, `${moved} student${moved === 1 ? '' : 's'}`);
    return { results };
  },

  'POST /admin/people/{sub}': async (event, caller) => {
    requireRole(caller, 'admin');
    const rec = await loadPerson(caller, param(event, 'sub'));
    if (rec.sub === caller.sub) throw new HttpError(403, 'Ask another administrator to change your own account');
    const { person, errors } = validateChanges(body(event), { ...rec, role: rec.roles[0] }, caller.institution);
    if (!person) return fieldErrors(errors);
    await people.updatePerson(rec, person, caller.institution);
    await audit(caller, 'Updated', rec.email, describe(person));
    return { updated: true };
  },

  'POST /admin/people/{sub}/enabled': async (event, caller) => {
    requireRole(caller, 'admin');
    const rec = await loadPerson(caller, param(event, 'sub'));
    if (rec.sub === caller.sub) throw new HttpError(403, 'You cannot disable your own account');
    const enabled = (body(event) as { enabled?: unknown }).enabled;
    if (typeof enabled !== 'boolean') throw new HttpError(400, 'enabled must be true or false');
    await people.setEnabled(rec, enabled);
    await audit(caller, enabled ? 'Re-enabled' : 'Disabled', rec.email);
    return { enabled };
  },

  'POST /admin/people/{sub}/resend-invite': async (event, caller) => {
    requireRole(caller, 'admin');
    const rec = await loadPerson(caller, param(event, 'sub'));
    if (rec.status !== 'FORCE_CHANGE_PASSWORD') throw new HttpError(409, 'This person has already signed in; they can use "forgot password" instead');
    await people.resendInvite(rec);
    await audit(caller, 'Resent invitation', rec.email);
    return { resent: true };
  },

  'GET /admin/audit': async (_e, caller) => {
    requireRole(caller, 'admin');
    return { events: await db.listAudit(caller.institution, 50) };
  },

  'GET /queue': async (_e, caller) => {
    requireRole(caller, ...VERIFIER_ROLES);
    const entries = await db.listQueue(caller.sub);
    return { entries: entries.map(view) };
  },

  'GET /queue/{studentSub}/{entryId}': async (event, caller) => ({ entry: view(await loadAssigned(event, caller)) }),

  'POST /queue/{studentSub}/{entryId}/sign': async (event, caller) => {
    const before = await loadAssigned(event, caller);
    const after = applySignature(before, caller, validateSign(body(event)), new Date().toISOString());
    await db.replaceEntries([{ before, after }]);
    return { entry: view(after) };
  },

  'POST /queue/{studentSub}/{entryId}/return': async (event, caller) => {
    const before = await loadAssigned(event, caller);
    const after = applyReturn(before, caller, body(event), new Date().toISOString());
    await db.replaceEntries([{ before, after }]);
    return { entry: view(after) };
  },
};

export const routeKeys = Object.keys(routes);

const json = (statusCode: number, data: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify(data),
});

export async function handler(event: Event): Promise<APIGatewayProxyResultV2> {
  const route = routes[event.routeKey];
  try {
    if (!route) throw new HttpError(404, 'Not found');
    const caller = callerFromEvent(event);
    return json(200, await route(event, caller));
  } catch (err) {
    if (err instanceof HttpError) return json(err.status, { error: err.message, ...((err as HttpError & { fields?: unknown }).fields ? { fields: (err as HttpError & { fields?: unknown }).fields } : {}) });
    const name = (err as Error)?.name;
    if (name === 'TransactionCanceledException' || name === 'ConditionalCheckFailedException')
      return json(409, { error: 'Someone else changed this entry at the same time. Reload and try again.' });
    console.error(JSON.stringify({ msg: 'unhandled', route: event.routeKey, name, error: String(err) }));
    return json(500, { error: 'Something went wrong on our side' });
  }
}
