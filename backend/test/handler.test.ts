import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  AdminListGroupsForUserCommand, CognitoIdentityProviderClient, ListUsersCommand, ListUsersInGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';

process.env.TABLE_NAME = 'test-table';
process.env.USER_POOL_ID = 'pool';
const { handler } = await import('../src/handler.js');

// ---------- in-memory fakes ----------
type Item = Record<string, any>;
let items: Map<string, Item>;
const key = (pk: string, sk: string) => `${pk}|${sk}`;
const conditionError = (name = 'ConditionalCheckFailedException') => Object.assign(new Error(name), { name });

function checkStatusCondition(existing: Item | undefined, values: Record<string, any>) {
  return existing && existing.status === values[':status'] && existing.updatedAt === values[':updatedAt'];
}

const ddb = mockClient(DynamoDBDocumentClient);
const cognito = mockClient(CognitoIdentityProviderClient);

const users = [
  { sub: 'stu-1', email: 'jane@wcg.za', name: 'Jane Doe', groups: ['student'], institution: 'WCG', category: 'ECA' },
  { sub: 'sup-1', email: 'bj@ems.za', name: 'B Jones', groups: ['supervisor'], institution: 'WCG' },
  { sub: 'lec-1', email: 'lec@wcg.za', name: 'L Ecturer', groups: ['lecturer'], institution: 'WCG' },
  { sub: 'lec-2', email: 'lec@other.za', name: 'Other Lecturer', groups: ['lecturer'], institution: 'OTHER' },
  { sub: 'stu-2', email: 'sam@wcg.za', name: 'Sam', groups: ['student'], institution: 'WCG', category: 'PARAMEDIC' },
  // college programme students and staff
  { sub: 'dip-1', email: 'dee@cec.za', name: 'Dee Dip', groups: ['student'], institution: 'WCG College of Emergency Care', category: 'PARAMEDIC', programme: 'WCG-DIPEMC', year: '2' },
  { sub: 'dip-2', email: 'dan@cec.za', name: 'Dan Dip', groups: ['student'], institution: 'WCG College of Emergency Care', category: 'PARAMEDIC', programme: 'WCG-DIPEMC', year: '2' },
  { sub: 'hc-1', email: 'hal@cec.za', name: 'Hal Cert', groups: ['student'], institution: 'WCG College of Emergency Care', category: 'ECA', programme: 'WCG-HCEMC', year: '1' },
  { sub: 'cec-lec', email: 'lec@cec.za', name: 'CEC Lecturer', groups: ['lecturer'], institution: 'WCG College of Emergency Care' },
  { sub: 'cec-sup', email: 'sup@cec.za', name: 'CEC Supervisor', groups: ['supervisor'], institution: 'WCG College of Emergency Care' },
] as any[];

beforeEach(() => {
  items = new Map();
  ddb.reset();
  cognito.reset();
  ddb.on(PutCommand).callsFake(({ Item, ConditionExpression }) => {
    const k = key(Item.PK, Item.SK);
    if (ConditionExpression?.includes('attribute_not_exists') && items.has(k)) throw conditionError();
    items.set(k, structuredClone(Item));
    return {};
  });
  ddb.on(GetCommand).callsFake(({ Key }) => ({ Item: structuredClone(items.get(key(Key.PK, Key.SK))) }));
  ddb.on(QueryCommand).callsFake(({ IndexName, ExpressionAttributeValues: v }) => {
    const all = [...items.values()];
    const found = IndexName === 'GSI1'
      ? all.filter((i) => i.GSI1PK === v[':pk']).sort((a, b) => a.GSI1SK.localeCompare(b.GSI1SK))
      : IndexName === 'GSI2' ? all.filter((i) => i.GSI2PK === v[':pk'])
      : all.filter((i) => i.PK === v[':pk'] && i.SK.startsWith(v[':sk'])).sort((a, b) => b.SK.localeCompare(a.SK));
    return { Items: structuredClone(found) };
  });
  ddb.on(TransactWriteCommand).callsFake(({ TransactItems }) => {
    for (const t of TransactItems) {
      const p = t.Put;
      const existing = items.get(key(p.Item.PK, p.Item.SK));
      const ok = p.Item.entityType === 'SignRequest'
        ? existing && existing.status === 'OPEN' && existing.expiresAt > p.ExpressionAttributeValues[':now']
        : checkStatusCondition(existing, p.ExpressionAttributeValues);
      if (!ok) throw conditionError('TransactionCanceledException');
    }
    for (const t of TransactItems) items.set(key(t.Put.Item.PK, t.Put.Item.SK), structuredClone(t.Put.Item));
    return {};
  });
  ddb.on(DeleteCommand).callsFake(({ Key }) => {
    const k = key(Key.PK, Key.SK);
    const it = items.get(k);
    if (!it || !['DRAFT', 'RETURNED'].includes(it.status)) throw conditionError();
    items.delete(k);
    return {};
  });
  cognito.on(ListUsersCommand).callsFake(({ Filter }) => {
    const [, attr, value] = /^(\w+) = "(.*)"$/.exec(Filter)!;
    const u = users.filter((x) => (attr === 'email' ? x.email === value : x.sub === value));
    return {
      Users: u.map((x) => ({
        Username: x.email, Enabled: true,
        Attributes: [
          { Name: 'sub', Value: x.sub }, { Name: 'email', Value: x.email }, { Name: 'name', Value: x.name },
          { Name: 'custom:institution', Value: x.institution },
          ...(x.category ? [{ Name: 'custom:category', Value: x.category }] : []),
          ...(x.programme ? [{ Name: 'custom:programme', Value: x.programme }, { Name: 'custom:study_year', Value: x.year }] : []),
        ],
      })),
    };
  });
  cognito.on(ListUsersInGroupCommand).callsFake(({ GroupName }: { GroupName: string }) => ({
    Users: users.filter((u) => u.groups.includes(GroupName)).map((x) => ({
      Username: x.email, Enabled: true,
      Attributes: [
        { Name: 'sub', Value: x.sub }, { Name: 'email', Value: x.email }, { Name: 'name', Value: x.name },
        { Name: 'custom:institution', Value: x.institution },
        ...(x.category ? [{ Name: 'custom:category', Value: x.category }] : []),
        ...(x.programme ? [{ Name: 'custom:programme', Value: x.programme }, { Name: 'custom:study_year', Value: x.year }] : []),
      ],
    })),
  }));
  cognito.on(AdminListGroupsForUserCommand).callsFake(({ Username }) => ({
    Groups: users.find((u) => u.email === Username)!.groups.map((GroupName: string) => ({ GroupName })),
  }));
});

// ---------- helpers ----------
async function call(as: string, routeKey: string, opts: { body?: unknown; path?: Record<string, string>; query?: Record<string, string> } = {}) {
  const u = users.find((x) => x.sub === as)!;
  const claims: Record<string, string> = {
    token_use: 'id', sub: u.sub, email: u.email, name: u.name, 'cognito:groups': `[${u.groups.join(' ')}]`,
    'custom:institution': u.institution, ...(u.category && { 'custom:category': u.category }),
    ...(u.programme && { 'custom:programme': u.programme, 'custom:study_year': u.year }),
  };
  const res: any = await handler({
    routeKey,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    isBase64Encoded: false,
    pathParameters: opts.path,
    queryStringParameters: opts.query,
    requestContext: { authorizer: { jwt: { claims, scopes: [] } } },
  } as any);
  return { status: res.statusCode as number, data: JSON.parse(res.body) };
}
const GCS = 'glasgow-coma-scale-gcs-score';
const PULSE = 'pulse-with-characteristics-measurement';
const newEntry = (overrides = {}) => ({ kind: 'encounter', performedOn: '2026-11-01', setting: 'Ambulance', encounterRef: 'Call 4471', skills: [{ skillId: GCS }, { skillId: PULSE, count: 2 }], ...overrides });

// ---------- the core loop ----------
test('log → request → sign / return → progress', async () => {
  const a = await call('stu-1', 'POST /entries', { body: newEntry() });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.equal(a.data.entry.status, 'DRAFT');
  const b = await call('stu-1', 'POST /entries', { body: newEntry({ kind: 'skills', setting: 'Triage', skills: [{ skillId: GCS, count: 3 }] }) });
  const ids = [a.data.entry.entryId, b.data.entry.entryId];

  const req = await call('stu-1', 'POST /entries/request-signature', { body: { entryIds: ids, verifierEmail: 'BJ@ems.za ' } });
  assert.equal(req.status, 200, JSON.stringify(req.data));
  assert.equal(req.data.requested, 2);

  // re-requesting the same entries is refused
  assert.equal((await call('stu-1', 'POST /entries/request-signature', { body: { entryIds: ids, verifierEmail: 'bj@ems.za' } })).status, 409);

  const q = await call('sup-1', 'GET /queue');
  assert.equal(q.data.entries.length, 2);
  assert.equal((await call('lec-1', 'GET /queue')).data.entries.length, 0); // other verifiers don't see it

  const path = (id: string) => ({ studentSub: 'stu-1', entryId: id });
  // wrong verifier cannot open or sign
  assert.equal((await call('lec-1', 'POST /queue/{studentSub}/{entryId}/sign', { path: path(ids[0]), body: { witnessedSkillIds: [GCS], regNo: 'X' } })).status, 404);
  // a student cannot sign
  assert.equal((await call('stu-1', 'POST /queue/{studentSub}/{entryId}/sign', { path: path(ids[0]), body: { witnessedSkillIds: [GCS], regNo: 'X' } })).status, 403);

  const signed = await call('sup-1', 'POST /queue/{studentSub}/{entryId}/sign', { path: path(ids[0]), body: { witnessedSkillIds: [GCS], regNo: 'PA123' } });
  assert.equal(signed.status, 200, JSON.stringify(signed.data));
  assert.equal(signed.data.entry.signature.verifierName, 'B Jones');
  const again = await call('sup-1', 'POST /queue/{studentSub}/{entryId}/sign', { path: path(ids[0]), body: { witnessedSkillIds: [GCS], regNo: 'PA123' } });
  assert.equal(again.status, 404); // no longer awaiting

  const ret = await call('sup-1', 'POST /queue/{studentSub}/{entryId}/return', { path: path(ids[1]), body: { reason: 'I was not on that shift' } });
  assert.equal(ret.data.entry.status, 'RETURNED');
  assert.equal((await call('sup-1', 'GET /queue')).data.entries.length, 0);

  // signed entries cannot be deleted; returned ones can
  assert.equal((await call('stu-1', 'DELETE /entries/{entryId}', { path: { entryId: ids[0] } })).status, 409);

  const p = await call('stu-1', 'GET /progress');
  assert.equal(p.status, 200);
  const get = (id: string) => p.data.hpcsa.skills.find((s: any) => s.skillId === id);
  assert.equal(p.data.college, null); // HPCSA-only student
  assert.deepEqual([get(GCS).verified, get(GCS).pending, get(GCS).minimum], [1, 3, 70]);
  assert.equal(get(PULSE).verified, 0);
  assert.equal(get('patients-seen').verified, 1);

  // lecturer at same institution can view; other institution cannot; supervisor cannot
  assert.equal((await call('lec-1', 'GET /progress', { query: { studentSub: 'stu-1' } })).status, 200);
  assert.equal((await call('lec-2', 'GET /progress', { query: { studentSub: 'stu-1' } })).status, 404);
  assert.equal((await call('sup-1', 'GET /progress', { query: { studentSub: 'stu-1' } })).status, 403);
  // one student cannot read another's progress
  assert.equal((await call('stu-2', 'GET /progress', { query: { studentSub: 'stu-1' } })).status, 403);

  assert.equal((await call('stu-1', 'DELETE /entries/{entryId}', { path: { entryId: ids[1] } })).status, 200);
});

test('signature requests are refused for unknown or non-verifier accounts', async () => {
  const a = await call('stu-1', 'POST /entries', { body: newEntry() });
  const id = a.data.entry.entryId;
  assert.equal((await call('stu-1', 'POST /entries/request-signature', { body: { entryIds: [id], verifierEmail: 'nobody@x.za' } })).status, 404);
  assert.equal((await call('stu-1', 'POST /entries/request-signature', { body: { entryIds: [id], verifierEmail: 'sam@wcg.za' } })).status, 404);
  assert.equal((await call('stu-1', 'POST /entries/request-signature', { body: { entryIds: ['missing'], verifierEmail: 'bj@ems.za' } })).status, 404);
});

test('students only see their own entries; verifiers cannot log', async () => {
  await call('stu-1', 'POST /entries', { body: newEntry() });
  assert.equal((await call('stu-2', 'GET /entries')).data.entries.length, 0);
  assert.equal((await call('stu-1', 'GET /entries')).data.entries.length, 1);
  assert.equal((await call('sup-1', 'POST /entries', { body: newEntry() })).status, 403);
});

test('bad requests get clear errors, not 500s', async () => {
  const r = await call('stu-1', 'POST /entries', { body: newEntry({ performedOn: '2999-01-01' }) });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /future/);
  assert.equal((await call('stu-1', 'GET /nowhere')).status, 404);
  const catalogue = await call('stu-1', 'GET /catalogue');
  assert.equal(catalogue.data.skills.length, 139);
  assert.equal(catalogue.data.framework, 'hpcsa');
});

test('programme students log college skills; lecturers get cohort, HPCSA summary and gap reports', async () => {
  const GCS_C = 'wcg-cec-2024/glasgow-coma-scale-adult';
  const cat = await call('dip-1', 'GET /catalogue');
  assert.equal(cat.data.framework, 'college');
  assert.equal(cat.data.programme.id, 'WCG-DIPEMC');
  assert.equal(cat.data.skills.find((s: any) => s.id === GCS_C).minimumThisYear, 60);
  // HPCSA ids are refused for a programme student
  assert.equal((await call('dip-1', 'POST /entries', { body: newEntry({ skills: [{ skillId: GCS }] }) })).status, 400);
  const e = await call('dip-1', 'POST /entries', { body: newEntry({ skills: [{ skillId: GCS_C, count: 5 }, { skillId: 'wcg-cec-2024/needle-cricothyroidotomy' }] }) });
  assert.equal(e.status, 200, JSON.stringify(e.data));
  assert.deepEqual([e.data.entry.programmeId, e.data.entry.studyYear], ['WCG-DIPEMC', 2]);
  await call('dip-1', 'POST /entries/request-signature', { body: { entryIds: [e.data.entry.entryId], verifierEmail: 'sup@cec.za' } });
  const s = await call('cec-sup', 'POST /queue/{studentSub}/{entryId}/sign', { path: { studentSub: 'dip-1', entryId: e.data.entry.entryId }, body: { witnessedSkillIds: [GCS_C, 'wcg-cec-2024/needle-cricothyroidotomy'], regNo: 'PA9' } });
  assert.equal(s.status, 200, JSON.stringify(s.data));

  const p = await call('dip-1', 'GET /progress');
  assert.equal(p.data.college.programmeId, 'WCG-DIPEMC');
  assert.deepEqual(p.data.college.skills.find((k: any) => k.skillId === GCS_C).thisYear, { minimum: 60, verified: 5, pending: 0, met: false });
  assert.equal(p.data.hpcsa.skills.find((k: any) => k.skillId === GCS).verified, 5);
  assert.equal(p.data.hpcsa.skills.find((k: any) => k.skillId === 'patients-seen').verified, 1);

  // reports: lecturer at the college sees its three students; filters work
  const all = await call('cec-lec', 'GET /reports/cohort');
  assert.equal(all.status, 200, JSON.stringify(all.data));
  assert.deepEqual(all.data.students.map((x: any) => x.name), ['Dan Dip', 'Dee Dip', 'Hal Cert']);
  assert.deepEqual(all.data.programmes.map((x: any) => x.id), ['WCG-HCEMC', 'WCG-DIPEMC']);
  const dip = await call('cec-lec', 'GET /reports/cohort', { query: { programme: 'WCG-DIPEMC', year: '2', detail: '1' } });
  assert.equal(dip.data.students.length, 2);
  assert.ok(dip.data.skills.length > 50);
  assert.ok(dip.data.detail.some((d: any) => d.student === 'Dee Dip' && d.skill === 'Glasgow coma scale - adult' && d.yearVerified === 5));
  const sum = await call('cec-lec', 'GET /reports/hpcsa-summary', { query: { programme: 'WCG-DIPEMC' } });
  assert.equal(sum.status, 200, JSON.stringify(sum.data));
  assert.equal(sum.data.cohort.total, 2);
  assert.equal(sum.data.category, 'PARAMEDIC');
  const gap = await call('cec-lec', 'GET /reports/gap');
  assert.equal(gap.data.sets[0].programmes.length, 2);

  // other institutions and other roles are kept out
  assert.equal((await call('lec-1', 'GET /reports/cohort')).data.students.every((x: any) => x.name !== 'Dee Dip'), true);
  assert.equal((await call('lec-1', 'GET /reports/gap')).status, 404);
  assert.equal((await call('lec-1', 'GET /reports/hpcsa-summary', { query: { programme: 'WCG-DIPEMC' } })).status, 404);
  assert.equal((await call('cec-sup', 'GET /reports/cohort')).status, 403);
  assert.equal((await call('dip-1', 'GET /reports/cohort')).status, 403);
  assert.equal((await call('cec-lec', 'GET /reports/cohort', { query: { year: '9' } })).status, 400);
});

test('on-the-spot signing: single-use code, claimed by a verifier, expires, refuses changed entries', async () => {
  const a = await call('stu-1', 'POST /entries', { body: newEntry() });
  const b = await call('stu-1', 'POST /entries', { body: newEntry({ kind: 'skills', setting: 'Triage' }) });
  const ids = [a.data.entry.entryId, b.data.entry.entryId];
  const req = await call('stu-1', 'POST /entries/sign-requests', { body: { entryIds: ids } });
  assert.equal(req.status, 200, JSON.stringify(req.data));
  const token = req.data.token;
  assert.match(token, /^[A-Za-z0-9_-]{22}$/);
  const stored = [...items.values()].find((i) => i.entityType === 'SignRequest')!;
  assert.ok(stored.PK.length > 70 && !JSON.stringify(stored).includes(token), 'only a hash of the code is stored');
  assert.ok(stored.ttl > Date.now() / 1000);

  // students (including the owner) can't claim; bad and unknown codes are refused
  assert.equal((await call('stu-1', 'POST /sign-requests/claim', { body: { token } })).status, 403);
  assert.equal((await call('stu-2', 'POST /sign-requests/claim', { body: { token } })).status, 403);
  assert.equal((await call('sup-1', 'POST /sign-requests/claim', { body: { token: 'short' } })).status, 400);
  assert.equal((await call('sup-1', 'POST /sign-requests/claim', { body: { token: 'A'.repeat(22) } })).status, 404);

  const claim = await call('sup-1', 'POST /sign-requests/claim', { body: { token } });
  assert.equal(claim.status, 200, JSON.stringify(claim.data));
  assert.equal(claim.data.studentName, 'Jane Doe');
  assert.deepEqual(claim.data.entries.map((e: any) => [e.status, e.request.verifierName]), [['AWAITING_SIGNATURE', 'B Jones'], ['AWAITING_SIGNATURE', 'B Jones']]);
  assert.ok(claim.data.entries[0].skills[0].name, 'skill names included');
  // single use
  const again = await call('sup-1', 'POST /sign-requests/claim', { body: { token } });
  assert.deepEqual([again.status, /already opened/.test(again.data.error)], [409, true]);
  assert.equal((await call('lec-1', 'POST /sign-requests/claim', { body: { token } })).status, 409);
  // signing then goes through the normal queue route
  const signed = await call('sup-1', 'POST /queue/{studentSub}/{entryId}/sign', { path: { studentSub: 'stu-1', entryId: ids[0] }, body: { witnessedSkillIds: [GCS], regNo: 'PA1' } });
  assert.equal(signed.status, 200);
  // a code for already-sent entries can't be made
  assert.equal((await call('stu-1', 'POST /entries/sign-requests', { body: { entryIds: [ids[0]] } })).status, 409);

  // expiry
  const c = await call('stu-1', 'POST /entries', { body: newEntry() });
  const r2 = await call('stu-1', 'POST /entries/sign-requests', { body: { entryIds: [c.data.entry.entryId] } });
  for (const i of items.values()) if (i.entityType === 'SignRequest' && i.status === 'OPEN') i.expiresAt = '2000-01-01T00:00:00.000Z';
  assert.equal((await call('sup-1', 'POST /sign-requests/claim', { body: { token: r2.data.token } })).status, 410);

  // an entry deleted after the code was made
  const r3 = await call('stu-1', 'POST /entries/sign-requests', { body: { entryIds: [c.data.entry.entryId] } });
  await call('stu-1', 'DELETE /entries/{entryId}', { path: { entryId: c.data.entry.entryId } });
  const changed = await call('sup-1', 'POST /sign-requests/claim', { body: { token: r3.data.token } });
  assert.deepEqual([changed.status, /changed since/.test(changed.data.error)], [409, true]);
  // other students' entries can't be put in a code
  assert.equal((await call('stu-2', 'POST /entries/sign-requests', { body: { entryIds: [ids[1]] } })).status, 404);
});

test('offline uploads are idempotent: the same clientId never creates two entries', async () => {
  const clientId = '3f2b8a4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
  const recordedAt = Date.now() - 3 * 3600_000;
  const first = await call('stu-1', 'POST /entries', { body: newEntry({ clientId, recordedAt }) });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const again = await call('stu-1', 'POST /entries', { body: newEntry({ clientId, recordedAt, setting: 'changed on retry' }) });
  assert.equal(again.status, 200);
  assert.equal(again.data.duplicate, true);
  assert.equal(again.data.entry.entryId, first.data.entry.entryId);
  assert.equal(again.data.entry.setting, 'Ambulance', 'the first upload wins');
  assert.equal((await call('stu-1', 'GET /entries')).data.entries.length, 1);
  // the id sorts by when it was recorded on the phone, not when it arrived
  assert.ok(first.data.entry.entryId.startsWith(recordedAt.toString(36).padStart(9, '0')));
  // another student using the same clientId gets their own entry
  const other = await call('stu-2', 'POST /entries', { body: newEntry({ clientId, recordedAt }) });
  assert.notEqual(other.data.entry.entryId, first.data.entry.entryId);
  assert.equal((await call('stu-1', 'POST /entries', { body: newEntry({ clientId: 'nope', recordedAt }) })).status, 400);
  assert.equal((await call('stu-1', 'POST /entries', { body: newEntry({ clientId, recordedAt: 'x' }) })).status, 400);
});
