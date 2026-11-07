import { randomBytes } from 'node:crypto';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { callerFromEvent, requireRole } from './auth.js';
import { catalogue } from './catalogue.js';
import * as db from './db.js';
import {
  applyReturn,
  applySignature,
  buildEntry,
  canRequestSignature,
  computeProgress,
  HttpError,
  validateNewEntry,
  validateSign,
  VERIFIER_ROLES,
  type Caller,
  type Entry,
} from './domain.js';
import { findUserByEmail, findUserBySub } from './users.js';

type Event = APIGatewayProxyEventV2WithJWTAuthorizer;

const MAX_ENTRIES_PER_REQUEST = 25; // DynamoDB transaction limit is 100; keep sign-off batches readable

/** Time-sortable id: 9 chars of base-36 milliseconds + 12 random hex chars. */
export function newEntryId(now = Date.now()) {
  return `${now.toString(36).padStart(9, '0')}-${randomBytes(6).toString('hex')}`;
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

/** What a student or verifier sees of an entry (drops nothing sensitive today; kept as one place to redact later). */
const view = (e: Entry) => e;

async function loadAssigned(event: Event, caller: Caller) {
  requireRole(caller, ...VERIFIER_ROLES);
  const entry = await db.getEntry(param(event, 'studentSub'), param(event, 'entryId'));
  if (!entry || entry.request?.verifierSub !== caller.sub || entry.status !== 'AWAITING_SIGNATURE')
    throw new HttpError(404, 'No entry awaiting your signature with that id');
  return entry;
}

const routes: Record<string, (event: Event, caller: Caller) => Promise<unknown>> = {
  'GET /me': async (_e, caller) => caller,

  'GET /catalogue': async (_e, caller) => ({
    source: catalogue.source,
    version: catalogue.version,
    category: caller.category ?? null,
    skills: catalogue.skills.map((s) => ({
      id: s.id,
      name: s.name,
      paediatric: s.paediatric,
      derived: s.derived,
      minimum: caller.category ? s.minimums[caller.category] : undefined,
      minimums: s.minimums,
    })),
  }),

  'GET /entries': async (_e, caller) => {
    requireRole(caller, 'student');
    return { entries: (await db.listEntries(caller.sub)).map(view) };
  },

  'POST /entries': async (event, caller) => {
    requireRole(caller, 'student');
    const input = validateNewEntry(body(event), todayInSA());
    const entry = buildEntry(input, caller, newEntryId(), new Date().toISOString());
    await db.createEntry(entry);
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
    const progress = computeProgress(await db.listEntries(studentSub), student.category);
    return { student: { sub: student.sub, name: student.name, institution: student.institution }, ...progress };
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
    if (err instanceof HttpError) return json(err.status, { error: err.message });
    const name = (err as Error)?.name;
    if (name === 'TransactionCanceledException' || name === 'ConditionalCheckFailedException')
      return json(409, { error: 'Someone else changed this entry at the same time. Reload and try again.' });
    console.error(JSON.stringify({ msg: 'unhandled', route: event.routeKey, name, error: String(err) }));
    return json(500, { error: 'Something went wrong on our side' });
  }
}
