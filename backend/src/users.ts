import {
  AdminListGroupsForUserCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
  ListUsersInGroupCommand,
  type UserType,
} from '@aws-sdk/client-cognito-identity-provider';
import { parseGroups, parseYear } from './auth.js';
import { isCategory, type Caller } from './domain.js';

const cognito = new CognitoIdentityProviderClient({});
const poolId = () => {
  const p = process.env.USER_POOL_ID;
  if (!p) throw new Error('USER_POOL_ID is not set');
  return p;
};

/** Cognito ListUsers filter values are double-quoted; strip anything that could break out of the quotes. */
export function filterValue(v: string) {
  return v.replace(/["\\]/g, '');
}

async function findOne(filter: string): Promise<Caller | undefined> {
  const r = await cognito.send(new ListUsersCommand({ UserPoolId: poolId(), Filter: filter, Limit: 2 }));
  const users = (r.Users ?? []).filter((u) => u.Enabled !== false);
  if (users.length !== 1) return undefined;
  return toCaller(users[0]);
}

async function toCaller(u: UserType): Promise<Caller | undefined> {
  if (!u.Username) return undefined;
  const g = await cognito.send(new AdminListGroupsForUserCommand({ UserPoolId: poolId(), Username: u.Username }));
  return profileOf(u, parseGroups((g.Groups ?? []).map((x) => x.GroupName ?? '')));
}

export function profileOf(u: UserType, roles: Caller['roles']): Caller | undefined {
  const attr = (n: string) => u.Attributes?.find((a) => a.Name === n)?.Value;
  const sub = attr('sub');
  if (!sub) return undefined;
  const category = attr('custom:category');
  const year = parseYear(attr('custom:study_year'));
  return {
    sub,
    email: (attr('email') ?? '').toLowerCase(),
    name: attr('name') ?? attr('email') ?? 'Unknown',
    roles,
    institution: attr('custom:institution') ?? '',
    ...(isCategory(category) && { category }),
    ...(attr('custom:reg_no') && { regNo: attr('custom:reg_no') }),
    ...(attr('custom:programme') && { programmeId: attr('custom:programme') }),
    ...(year && { studyYear: year }),
  };
}

/** All enabled students at an institution (Cognito can't filter on custom attributes, so filter here). */
export async function listStudents(institution: string): Promise<Caller[]> {
  const out: Caller[] = [];
  let NextToken: string | undefined;
  do {
    const r = await cognito.send(new ListUsersInGroupCommand({ UserPoolId: poolId(), GroupName: 'student', Limit: 60, NextToken }));
    for (const u of r.Users ?? []) {
      if (u.Enabled === false) continue;
      const p = profileOf(u, ['student']);
      if (p && p.institution === institution) out.push(p);
    }
    NextToken = r.NextToken;
  } while (NextToken);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export const findUserByEmail = (email: string) => findOne(`email = "${filterValue(email.trim().toLowerCase())}"`);
export const findUserBySub = (sub: string) => findOne(`sub = "${filterValue(sub)}"`);
