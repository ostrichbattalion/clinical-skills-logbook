import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { HttpError, isCategory, ROLES, type Caller, type Role } from './domain.js';

/**
 * Cognito group claims arrive from the HTTP API JWT authorizer either as an array or as a
 * bracketed, space-separated string such as "[student lecturer]".
 */
export function parseGroups(raw: unknown): Role[] {
  let list: string[] = [];
  if (Array.isArray(raw)) list = raw.map(String);
  else if (typeof raw === 'string') list = raw.replace(/^\[|\]$/g, '').split(/[\s,]+/);
  return list.filter((g): g is Role => (ROLES as readonly string[]).includes(g));
}

/** Builds the caller from the verified Cognito ID token claims (signature is already checked by API Gateway). */
export function callerFromEvent(event: APIGatewayProxyEventV2WithJWTAuthorizer): Caller {
  const claims = event.requestContext.authorizer?.jwt?.claims ?? {};
  if (claims.token_use !== 'id') throw new HttpError(401, 'Send the Cognito ID token');
  const sub = String(claims.sub ?? '');
  if (!sub) throw new HttpError(401, 'Not signed in');
  const category = claims['custom:category'];
  return {
    sub,
    email: String(claims.email ?? '').toLowerCase(),
    name: String(claims.name ?? claims.email ?? 'Unknown'),
    roles: parseGroups(claims['cognito:groups']),
    institution: String(claims['custom:institution'] ?? ''),
    ...(isCategory(category) && { category }),
    ...(claims['custom:reg_no'] && { regNo: String(claims['custom:reg_no']) }),
  };
}

export function requireRole(caller: Caller, ...roles: Role[]) {
  if (!roles.some((r) => caller.roles.includes(r)))
    throw new HttpError(403, `This needs one of these roles: ${roles.join(', ')}`);
}
