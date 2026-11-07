/** Cognito operations behind the admin screen. Every function is scoped to one institution by its callers. */
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserAttributesCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminRemoveUserFromGroupCommand,
  AdminUpdateUserAttributesCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
  ListUsersInGroupCommand,
  type UserType,
} from '@aws-sdk/client-cognito-identity-provider';
import { parseYear } from './auth.js';
import { isCategory, ROLES, type Role } from './domain.js';
import type { PersonInput } from './admin.js';
import { filterValue } from './users.js';

const cognito = new CognitoIdentityProviderClient({});
const poolId = () => {
  const p = process.env.USER_POOL_ID;
  if (!p) throw new Error('USER_POOL_ID is not set');
  return p;
};

export interface PersonRecord {
  username: string;
  sub: string;
  email: string;
  name: string;
  roles: Role[];
  institution: string;
  programmeId?: string;
  studyYear?: number;
  category?: string;
  regNo?: string;
  enabled: boolean;
  /** CONFIRMED, FORCE_CHANGE_PASSWORD (invited, not signed in yet), RESET_REQUIRED, ... */
  status: string;
  createdAt?: string;
}

function toRecord(u: UserType, roles: Role[]): PersonRecord | undefined {
  const attr = (n: string) => u.Attributes?.find((a) => a.Name === n)?.Value;
  const sub = attr('sub');
  if (!sub || !u.Username) return undefined;
  const category = attr('custom:category');
  const year = parseYear(attr('custom:study_year'));
  return {
    username: u.Username, sub,
    email: (attr('email') ?? '').toLowerCase(),
    name: attr('name') ?? '',
    roles,
    institution: attr('custom:institution') ?? '',
    ...(attr('custom:programme') && { programmeId: attr('custom:programme') }),
    ...(year && { studyYear: year }),
    ...(isCategory(category) && { category }),
    ...(attr('custom:reg_no') && { regNo: attr('custom:reg_no') }),
    enabled: u.Enabled !== false,
    status: u.UserStatus ?? 'UNKNOWN',
    ...(u.UserCreateDate && { createdAt: new Date(u.UserCreateDate).toISOString() }),
  };
}

/** Everyone at an institution, with their roles. One paginated listing per role group. */
export async function listInstitutionPeople(institution: string): Promise<PersonRecord[]> {
  const bySub = new Map<string, PersonRecord>();
  for (const role of ROLES) {
    let NextToken: string | undefined;
    do {
      const r = await cognito.send(new ListUsersInGroupCommand({ UserPoolId: poolId(), GroupName: role, Limit: 60, NextToken }));
      for (const u of r.Users ?? []) {
        const rec = toRecord(u, [role]);
        if (!rec || rec.institution !== institution) continue;
        const existing = bySub.get(rec.sub);
        if (existing) existing.roles.push(role);
        else bySub.set(rec.sub, rec);
      }
      NextToken = r.NextToken;
    } while (NextToken);
  }
  return [...bySub.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function emailExists(email: string): Promise<boolean> {
  const r = await cognito.send(new ListUsersCommand({ UserPoolId: poolId(), Filter: `email = "${filterValue(email)}"`, Limit: 1 }));
  return (r.Users ?? []).length > 0;
}

const personAttributes = (p: PersonInput, institution: string) => [
  { Name: 'name', Value: p.name },
  { Name: 'custom:institution', Value: institution },
  ...(p.category ? [{ Name: 'custom:category', Value: p.category }] : []),
  ...(p.programmeId ? [{ Name: 'custom:programme', Value: p.programmeId }] : []),
  ...(p.studyYear ? [{ Name: 'custom:study_year', Value: String(p.studyYear) }] : []),
  ...(p.regNo ? [{ Name: 'custom:reg_no', Value: p.regNo }] : []),
];

export class AlreadyExists extends Error {}

/** Creates the account and emails a temporary password. */
export async function createPerson(p: PersonInput, institution: string): Promise<string> {
  try {
    const r = await cognito.send(new AdminCreateUserCommand({
      UserPoolId: poolId(), Username: p.email, DesiredDeliveryMediums: ['EMAIL'],
      UserAttributes: [{ Name: 'email', Value: p.email }, { Name: 'email_verified', Value: 'true' }, ...personAttributes(p, institution)],
    }));
    await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: poolId(), Username: r.User!.Username!, GroupName: p.role }));
    return r.User!.Attributes?.find((a) => a.Name === 'sub')?.Value ?? '';
  } catch (err) {
    if ((err as Error).name === 'UsernameExistsException') throw new AlreadyExists('An account with this email already exists');
    throw err;
  }
}

/** Applies a validated new state to an existing person: attributes, then the role group. */
export async function updatePerson(rec: PersonRecord, next: PersonInput, institution: string) {
  const set = personAttributes(next, institution).filter((a) => a.Name !== 'custom:institution');
  await cognito.send(new AdminUpdateUserAttributesCommand({ UserPoolId: poolId(), Username: rec.username, UserAttributes: set }));
  const drop = [
    !next.category && rec.category && 'custom:category',
    !next.programmeId && rec.programmeId && 'custom:programme',
    !next.studyYear && rec.studyYear && 'custom:study_year',
    !next.regNo && rec.regNo && 'custom:reg_no',
  ].filter(Boolean) as string[];
  if (drop.length) await cognito.send(new AdminDeleteUserAttributesCommand({ UserPoolId: poolId(), Username: rec.username, UserAttributeNames: drop }));
  if (!rec.roles.includes(next.role) || rec.roles.length > 1) {
    await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: poolId(), Username: rec.username, GroupName: next.role }));
    for (const r of rec.roles) if (r !== next.role)
      await cognito.send(new AdminRemoveUserFromGroupCommand({ UserPoolId: poolId(), Username: rec.username, GroupName: r }));
    await signOutEverywhere(rec.username); // new role takes effect at next sign-in
  }
}

export async function setStudyYear(rec: PersonRecord, year: number) {
  await cognito.send(new AdminUpdateUserAttributesCommand({
    UserPoolId: poolId(), Username: rec.username, UserAttributes: [{ Name: 'custom:study_year', Value: String(year) }],
  }));
}

async function signOutEverywhere(username: string) {
  await cognito.send(new AdminUserGlobalSignOutCommand({ UserPoolId: poolId(), Username: username }));
}

/** Disabling also signs the person out of every device, so a leaver can't keep using a saved session. */
export async function setEnabled(rec: PersonRecord, enabled: boolean) {
  if (enabled) await cognito.send(new AdminEnableUserCommand({ UserPoolId: poolId(), Username: rec.username }));
  else {
    await cognito.send(new AdminDisableUserCommand({ UserPoolId: poolId(), Username: rec.username }));
    await signOutEverywhere(rec.username);
  }
}

export async function resendInvite(rec: PersonRecord) {
  await cognito.send(new AdminCreateUserCommand({
    UserPoolId: poolId(), Username: rec.username, MessageAction: 'RESEND', DesiredDeliveryMediums: ['EMAIL'],
  }));
}

/** Runs async work over items with limited concurrency (Cognito admin APIs are rate limited). */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}
