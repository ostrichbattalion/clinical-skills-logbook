import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  AdminAddUserToGroupCommand, AdminCreateUserCommand, AdminDeleteUserAttributesCommand, AdminDisableUserCommand,
  AdminEnableUserCommand, AdminListGroupsForUserCommand, AdminRemoveUserFromGroupCommand, AdminUpdateUserAttributesCommand,
  AdminUserGlobalSignOutCommand, CognitoIdentityProviderClient, ListUsersCommand, ListUsersInGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { validatePerson, validateChanges } from '../src/admin.js';

process.env.TABLE_NAME = 't';
process.env.USER_POOL_ID = 'p';
const { handler } = await import('../src/handler.js');

const CEC = 'WCG College of Emergency Care';

// ---------------- pure validation ----------------
test('validatePerson: students need a programme and a valid year at a college with requirement sets', () => {
  const ok = validatePerson({ email: ' Jane@CEC.za ', name: 'Jane  Doe', role: 'Student', programme: 'wcg-dipemc', year: '2' }, CEC);
  assert.deepEqual(ok.person, { email: 'jane@cec.za', name: 'Jane Doe', role: 'student', programmeId: 'WCG-DIPEMC', studyYear: 2, category: 'PARAMEDIC' });
  assert.match(validatePerson({ email: 'a@b.za', name: 'Al', role: 'student', programme: 'WCG-HCEMC', year: '2' }, CEC).errors.studyYear, /1 to 1/);
  assert.ok(validatePerson({ email: 'a@b.za', name: 'Al', role: 'student', programme: 'NOPE', year: '1' }, CEC).errors.programmeId);
  assert.ok(validatePerson({ email: 'a@b.za', name: 'Al', role: 'student', programme: 'WCG-DIPEMC', year: '1', category: 'ECA' }, CEC).errors.category);
});

test('validatePerson: other institutions use a category; staff have no student fields; admins are refused', () => {
  assert.equal(validatePerson({ email: 'a@b.za', name: 'Al', role: 'student', category: 'eca' }, 'Other').person?.category, 'ECA');
  assert.ok(validatePerson({ email: 'a@b.za', name: 'Al', role: 'student' }, 'Other').errors.category);
  assert.ok(validatePerson({ email: 'a@b.za', name: 'Al', role: 'lecturer', year: '1' }, CEC).errors.studyYear);
  assert.match(validatePerson({ email: 'a@b.za', name: 'Al', role: 'admin' }, CEC).errors.role, /platform operator/);
  assert.ok(validatePerson({ email: 'not-an-email', name: 'Al', role: 'supervisor' }, CEC).errors.email);
  assert.ok(validatePerson({ email: 'a@b.za', name: 'A', role: 'supervisor' }, CEC).errors.name);
  assert.ok(validatePerson({ email: 'a@b.za', name: 'Al', role: 'supervisor', reg_no: 'PA<1>' }, CEC).errors.regNo);
  assert.equal(validatePerson({ email: 'a@b.za', name: 'Al', role: 'supervisor', reg_no: 'pa 123/4' }, CEC).person?.regNo, 'PA 123/4');
});

test('validateChanges: switching a student to supervisor drops programme and year', () => {
  const cur = { role: 'student', email: 'a@b.za', name: 'Al', programmeId: 'WCG-DIPEMC', studyYear: 2, category: 'PARAMEDIC' };
  const r = validateChanges({ role: 'supervisor', regNo: 'PA1' }, cur, CEC);
  assert.deepEqual(r.person, { email: 'a@b.za', name: 'Al', role: 'supervisor', regNo: 'PA1' });
  assert.equal(validateChanges({ studyYear: 3 }, cur, CEC).person?.studyYear, 3);
  assert.ok(validateChanges({ studyYear: 4 }, cur, CEC).errors.studyYear);
});

// ---------------- API against a fake Cognito ----------------
type U = { username: string; sub: string; attrs: Record<string, string>; groups: string[]; enabled: boolean; status: string; signedOut?: number };
let pool: U[];
let audit: any[];
let n = 0;
const ddb = mockClient(DynamoDBDocumentClient);
const cog = mockClient(CognitoIdentityProviderClient);
const toUser = (u: U) => ({ Username: u.username, Enabled: u.enabled, UserStatus: u.status, Attributes: [{ Name: 'sub', Value: u.sub }, ...Object.entries(u.attrs).map(([Name, Value]) => ({ Name, Value }))] });
const byName = (n: string) => pool.find((u) => u.username === n)!;
const mk = (sub: string, email: string, name: string, group: string, inst: string, extra: Record<string, string> = {}): U =>
  ({ username: email, sub, attrs: { email, name, 'custom:institution': inst, ...extra }, groups: [group], enabled: true, status: 'CONFIRMED' });

beforeEach(() => {
  n = 0;
  audit = [];
  pool = [
    mk('adm', 'admin@cec.za', 'Ada Admin', 'admin', CEC),
    mk('adm2', 'admin2@cec.za', 'Second Admin', 'admin', CEC),
    mk('s1', 'dee@cec.za', 'Dee Dip', 'student', CEC, { 'custom:programme': 'WCG-DIPEMC', 'custom:study_year': '1', 'custom:category': 'PARAMEDIC' }),
    mk('s2', 'dan@cec.za', 'Dan Dip', 'student', CEC, { 'custom:programme': 'WCG-DIPEMC', 'custom:study_year': '3', 'custom:category': 'PARAMEDIC' }),
    mk('l1', 'lec@cec.za', 'Lee Lecturer', 'lecturer', CEC),
    mk('x1', 'other@else.za', 'Elsewhere', 'student', 'Other College', { 'custom:category': 'ECA' }),
    mk('oadm', 'admin@else.za', 'Other Admin', 'admin', 'Other College'),
  ];
  ddb.reset(); cog.reset();
  ddb.on(PutCommand).callsFake(({ Item }) => { audit.push(Item); return {}; });
  ddb.on(QueryCommand).callsFake(({ ExpressionAttributeValues: v }) => ({ Items: audit.filter((a) => a.PK === v[':pk']).sort((a, b) => b.SK.localeCompare(a.SK)) }));
  cog.on(ListUsersInGroupCommand).callsFake(({ GroupName }) => ({ Users: pool.filter((u) => u.groups.includes(GroupName)).map(toUser) }));
  cog.on(ListUsersCommand).callsFake(({ Filter }) => { const [, a, v] = /^(\w+) = "(.*)"$/.exec(Filter)!; return { Users: pool.filter((u) => (a === 'sub' ? u.sub : u.attrs.email) === v).map(toUser) }; });
  cog.on(AdminListGroupsForUserCommand).callsFake(({ Username }) => ({ Groups: byName(Username).groups.map((GroupName) => ({ GroupName })) }));
  cog.on(AdminCreateUserCommand).callsFake(({ Username, UserAttributes, MessageAction }) => {
    if (MessageAction === 'RESEND') { byName(Username).attrs.resent = 'yes'; return {}; }
    if (pool.some((u) => u.username === Username)) throw Object.assign(new Error('exists'), { name: 'UsernameExistsException' });
    const u: U = { username: Username, sub: `new-${++n}`, attrs: Object.fromEntries(UserAttributes.map((a: any) => [a.Name, a.Value])), groups: [], enabled: true, status: 'FORCE_CHANGE_PASSWORD' };
    pool.push(u);
    return { User: toUser(u) };
  });
  cog.on(AdminAddUserToGroupCommand).callsFake(({ Username, GroupName }) => { const u = byName(Username); if (!u.groups.includes(GroupName)) u.groups.push(GroupName); return {}; });
  cog.on(AdminRemoveUserFromGroupCommand).callsFake(({ Username, GroupName }) => { const u = byName(Username); u.groups = u.groups.filter((g) => g !== GroupName); return {}; });
  cog.on(AdminUpdateUserAttributesCommand).callsFake(({ Username, UserAttributes }) => { for (const a of UserAttributes) byName(Username).attrs[a.Name] = a.Value; return {}; });
  cog.on(AdminDeleteUserAttributesCommand).callsFake(({ Username, UserAttributeNames }) => { for (const a of UserAttributeNames) delete byName(Username).attrs[a]; return {}; });
  cog.on(AdminDisableUserCommand).callsFake(({ Username }) => { byName(Username).enabled = false; return {}; });
  cog.on(AdminEnableUserCommand).callsFake(({ Username }) => { byName(Username).enabled = true; return {}; });
  cog.on(AdminUserGlobalSignOutCommand).callsFake(({ Username }) => { const u = byName(Username); u.signedOut = (u.signedOut ?? 0) + 1; return {}; });
});

async function call(asSub: string, routeKey: string, opts: { body?: unknown; path?: Record<string, string> } = {}) {
  const u = pool.find((x) => x.sub === asSub)!;
  const claims = { token_use: 'id', sub: u.sub, email: u.attrs.email, name: u.attrs.name, 'cognito:groups': `[${u.groups.join(' ')}]`, 'custom:institution': u.attrs['custom:institution'] };
  const res: any = await handler({ routeKey, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), isBase64Encoded: false, pathParameters: opts.path, requestContext: { authorizer: { jwt: { claims, scopes: [] } } } } as any);
  return { status: res.statusCode as number, data: JSON.parse(res.body) };
}

test('admins list only their own institution, with roles and status', async () => {
  const r = await call('adm', 'GET /admin/people');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.people.map((p: any) => p.name), ['Ada Admin', 'Dan Dip', 'Dee Dip', 'Lee Lecturer', 'Second Admin']);
  assert.equal(r.data.people.find((p: any) => p.sub === 'adm').self, true);
  assert.equal(r.data.people.find((p: any) => p.sub === 's1').studyYear, 1);
  assert.deepEqual(r.data.programmes.map((p: any) => p.id), ['WCG-HCEMC', 'WCG-DIPEMC']);
  assert.equal(r.data.people[0].username, undefined, 'internal username not exposed');
  for (const who of ['s1', 'l1']) assert.equal((await call(who, 'GET /admin/people')).status, 403);
});

test('add a person: validated, created with institution set by the server, invited, audited', async () => {
  const bad = await call('adm', 'POST /admin/people', { body: { email: 'x', name: 'X', role: 'student' } });
  assert.equal(bad.status, 422);
  assert.ok(bad.data.fields.email && bad.data.fields.name && bad.data.fields.programmeId);
  const ok = await call('adm', 'POST /admin/people', { body: { email: 'New@CEC.za', name: 'New Student', role: 'student', programmeId: 'WCG-HCEMC', studyYear: 1, institution: 'Hacked' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const u = pool.find((x) => x.username === 'new@cec.za')!;
  assert.deepEqual([u.attrs['custom:institution'], u.attrs['custom:category'], u.groups[0], u.status], [CEC, 'ECA', 'student', 'FORCE_CHANGE_PASSWORD']);
  assert.equal((await call('adm', 'POST /admin/people', { body: { email: 'new@cec.za', name: 'Again', role: 'supervisor' } })).status, 409);
  assert.equal((await call('adm', 'POST /admin/people', { body: { email: 'boss@cec.za', name: 'Boss', role: 'admin' } })).status, 422);
  const log = await call('adm', 'GET /admin/audit');
  assert.equal(log.data.events[0].action, 'Added');
  assert.equal(log.data.events[0].targetEmail, 'new@cec.za');
  assert.equal(log.data.events[0].actorName, 'Ada Admin');
});

test('edit, change role, disable/enable, resend invite; guards on self, admins and other institutions', async () => {
  const yr = await call('adm', 'POST /admin/people/{sub}', { path: { sub: 's1' }, body: { studyYear: 2 } });
  assert.equal(yr.status, 200, JSON.stringify(yr.data));
  assert.equal(byName('dee@cec.za').attrs['custom:study_year'], '2');
  const role = await call('adm', 'POST /admin/people/{sub}', { path: { sub: 's1' }, body: { role: 'supervisor', regNo: 'PA42' } });
  assert.equal(role.status, 200, JSON.stringify(role.data));
  const d = byName('dee@cec.za');
  assert.deepEqual([d.groups, d.attrs['custom:programme'], d.attrs['custom:reg_no'], d.signedOut], [['supervisor'], undefined, 'PA42', 1]);

  assert.equal((await call('adm', 'POST /admin/people/{sub}/enabled', { path: { sub: 'l1' }, body: { enabled: false } })).status, 200);
  assert.deepEqual([byName('lec@cec.za').enabled, byName('lec@cec.za').signedOut], [false, 1]);
  assert.equal((await call('adm', 'POST /admin/people/{sub}/enabled', { path: { sub: 'l1' }, body: { enabled: true } })).status, 200);
  assert.equal(byName('lec@cec.za').enabled, true);

  assert.equal((await call('adm', 'POST /admin/people/{sub}/resend-invite', { path: { sub: 'l1' } })).status, 409, 'already signed in');
  await call('adm', 'POST /admin/people', { body: { email: 'inv@cec.za', name: 'Invited', role: 'lecturer' } });
  const invited = pool.find((u) => u.username === 'inv@cec.za')!;
  assert.equal((await call('adm', 'POST /admin/people/{sub}/resend-invite', { path: { sub: invited.sub } })).status, 200);
  assert.equal(invited.attrs.resent, 'yes');

  assert.equal((await call('adm', 'POST /admin/people/{sub}/enabled', { path: { sub: 'adm' }, body: { enabled: false } })).status, 403, 'not yourself');
  assert.equal((await call('adm', 'POST /admin/people/{sub}', { path: { sub: 'adm2' }, body: { name: 'Hacked' } })).status, 403, 'not other admins');
  assert.equal((await call('adm', 'POST /admin/people/{sub}', { path: { sub: 'x1' }, body: { name: 'Hacked' } })).status, 404, 'not other institutions');
  assert.equal((await call('oadm', 'POST /admin/people/{sub}/enabled', { path: { sub: 's2' }, body: { enabled: false } })).status, 404);
  assert.equal(byName('dan@cec.za').enabled, true);
});

test('move to next year skips final-year students and non-students', async () => {
  const r = await call('adm', 'POST /admin/people/promote', { body: { subs: ['s1', 's2', 'l1', 'x1'] } });
  assert.equal(r.status, 200);
  const by = Object.fromEntries(r.data.results.map((x: any) => [x.sub, x]));
  assert.deepEqual([by.s1.ok, by.s1.message], [true, 'Year 1 → 2']);
  assert.deepEqual([by.s2.ok, by.s2.message], [false, 'Already in the final year (3)']);
  assert.equal(by.l1.ok, false);
  assert.equal(by.x1.ok, false, 'other institution');
  assert.equal(byName('dee@cec.za').attrs['custom:study_year'], '2');
  assert.equal((await call('adm', 'GET /admin/audit')).data.events[0].action, 'Moved to next year');
});

test('CSV import: dry run reports per-row problems, then creates only valid rows', async () => {
  const rows = [
    { email: 'a1@cec.za', name: 'Amy One', role: 'student', programme: 'WCG-DIPEMC', year: '1' },
    { email: 'a2@cec.za', name: 'Ben Two', role: 'supervisor', reg_no: 'PA9' },
    { email: 'dee@cec.za', name: 'Dee Again', role: 'student', programme: 'WCG-DIPEMC', year: '1' },
    { email: 'a1@cec.za', name: 'Amy Dup', role: 'student', programme: 'WCG-DIPEMC', year: '1' },
    { email: 'a5@cec.za', name: 'Bad Year', role: 'student', programme: 'WCG-DIPEMC', year: '7' },
  ];
  const dry = await call('adm', 'POST /admin/people/import', { body: { rows, dryRun: true } });
  assert.equal(dry.status, 200, JSON.stringify(dry.data));
  assert.deepEqual(dry.data.results.map((r: any) => r.ok), [true, true, false, false, false]);
  assert.match(dry.data.results[2].errors.email, /Already has an account/);
  assert.match(dry.data.results[3].errors.email, /more than once/);
  assert.ok(dry.data.results[4].errors.studyYear);
  assert.equal(pool.length, 7, 'dry run creates nothing');
  const real = await call('adm', 'POST /admin/people/import', { body: { rows, dryRun: false } });
  assert.deepEqual(real.data.results.map((r: any) => r.ok), [true, true, false, false, false]);
  assert.equal(pool.length, 9);
  assert.equal(pool.find((u) => u.username === 'a2@cec.za')!.attrs['custom:reg_no'], 'PA9');
  assert.equal((await call('adm', 'GET /admin/audit')).data.events[0].details, '2 accounts from a class list');
  assert.equal((await call('adm', 'POST /admin/people/import', { body: { rows: Array(51).fill(rows[0]) } })).status, 400);
});
