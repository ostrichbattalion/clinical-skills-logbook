import {
  AdminListGroupsForUserCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
  type UserType,
} from '@aws-sdk/client-cognito-identity-provider';
import { parseGroups } from './auth.js';
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
  const attr = (n: string) => u.Attributes?.find((a) => a.Name === n)?.Value;
  const sub = attr('sub');
  if (!sub || !u.Username) return undefined;
  const g = await cognito.send(new AdminListGroupsForUserCommand({ UserPoolId: poolId(), Username: u.Username }));
  const category = attr('custom:category');
  return {
    sub,
    email: (attr('email') ?? '').toLowerCase(),
    name: attr('name') ?? attr('email') ?? 'Unknown',
    roles: parseGroups((g.Groups ?? []).map((x) => x.GroupName ?? '')),
    institution: attr('custom:institution') ?? '',
    ...(isCategory(category) && { category }),
    ...(attr('custom:reg_no') && { regNo: attr('custom:reg_no') }),
  };
}

export const findUserByEmail = (email: string) => findOne(`email = "${filterValue(email.trim().toLowerCase())}"`);
export const findUserBySub = (sub: string) => findOne(`sub = "${filterValue(sub)}"`);
