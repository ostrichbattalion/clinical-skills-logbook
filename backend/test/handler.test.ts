import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  AdminListGroupsForUserCommand, CognitoIdentityProviderClient, ListUsersCommand,
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
];

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
      : all.filter((i) => i.PK === v[':pk'] && i.SK.startsWith(v[':sk'])).sort((a, b) => b.SK.localeCompare(a.SK));
    return { Items: structuredClone(found) };
  });
  ddb.on(TransactWriteCommand).callsFake(({ TransactItems }) => {
    for (const t of TransactItems) {
      const p = t.Put;
      if (!checkStatusCondition(items.get(key(p.Item.PK, p.Item.SK)), p.ExpressionAttributeValues))
        throw conditionError('TransactionCanceledException');
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
        ],
      })),
    };
  });
  cognito.on(AdminListGroupsForUserCommand).callsFake(({ Username }) => ({
    Groups: users.find((u) => u.email === Username)!.groups.map((GroupName) => ({ GroupName })),
  }));
});

// ---------- helpers ----------
async function call(as: string, routeKey: string, opts: { body?: unknown; path?: Record<string, string>; query?: Record<string, string> } = {}) {
  const u = users.find((x) => x.sub === as)!;
  const claims: Record<string, string> = {
    token_use: 'id', sub: u.sub, email: u.email, name: u.name, 'cognito:groups': `[${u.groups.join(' ')}]`,
    'custom:institution': u.institution, ...(u.category && { 'custom:category': u.category }),
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
  const get = (id: string) => p.data.skills.find((s: any) => s.skillId === id);
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
  assert.equal(catalogue.data.skills.find((s: any) => s.id === GCS).minimum, 70);
});
