/**
 * On-the-spot signing. A student turns selected entries into a single-use sign request and shows its code as a
 * QR (or hands their phone over). Whoever claims it must be a supervisor or lecturer; claiming assigns the
 * entries to them, after which they sign through the normal queue routes.
 *
 * Only a SHA-256 hash of the code is stored, so a database read can't be replayed as a valid code.
 */
import { createHash, randomBytes } from 'node:crypto';
import { canRequestSignature, HttpError, type Caller, type Entry } from './domain.js';

export const SIGN_REQUEST_TTL_MINUTES = 15;
export const MAX_ENTRIES_PER_SIGN_REQUEST = 25;

export interface SignRequest {
  tokenHash: string;
  studentSub: string;
  studentName: string;
  institution: string;
  entryIds: string[];
  createdAt: string;
  expiresAt: string;
  status: 'OPEN' | 'CLAIMED';
  claimedBy?: { sub: string; name: string; at: string };
}

/** 128 random bits, URL-safe. Shown once to the student; never stored. */
export const newToken = () => randomBytes(16).toString('base64url');
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export function validateToken(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(raw)) throw new HttpError(400, 'That signing code is not valid');
  return raw;
}

export function buildSignRequest(student: Caller, entries: Entry[], token: string, now: Date): SignRequest {
  if (!entries.length) throw new HttpError(400, 'Choose at least one entry');
  if (entries.length > MAX_ENTRIES_PER_SIGN_REQUEST) throw new HttpError(400, `At most ${MAX_ENTRIES_PER_SIGN_REQUEST} entries at a time`);
  for (const e of entries) {
    if (e.studentSub !== student.sub) throw new HttpError(404, 'Entry not found');
    if (!canRequestSignature(e)) throw new HttpError(409, `The entry from ${e.performedOn} is already ${e.status.toLowerCase().replace('_', ' ')}`);
  }
  return {
    tokenHash: hashToken(token),
    studentSub: student.sub,
    studentName: student.name,
    institution: student.institution,
    entryIds: entries.map((e) => e.entryId),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SIGN_REQUEST_TTL_MINUTES * 60_000).toISOString(),
    status: 'OPEN',
  };
}

/** Checks a claim and works out the entry changes. Throws with a message the supervisor can act on. */
export function planClaim(req: SignRequest | undefined, entries: (Entry | undefined)[], verifier: Caller, now: Date) {
  if (!req) throw new HttpError(404, 'That signing code is not valid. Ask the student to show a new one.');
  if (!verifier.roles.some((r) => r === 'supervisor' || r === 'lecturer'))
    throw new HttpError(403, 'Only a supervisor or lecturer can sign. Sign in with your own account.');
  if (req.studentSub === verifier.sub) throw new HttpError(403, 'You cannot sign your own entries');
  if (req.status !== 'OPEN') throw new HttpError(409, req.claimedBy?.sub === verifier.sub
    ? 'You have already opened this code. Find the entries in your sign-off queue.'
    : 'This code has already been used. Ask the student to show a new one.');
  if (now.toISOString() >= req.expiresAt) throw new HttpError(410, 'This code has expired. Ask the student to show a new one.');
  const at = now.toISOString();
  const changes = entries.map((before, i) => {
    if (!before || !canRequestSignature(before))
      throw new HttpError(409, `One of the entries has changed since the code was made (${req.entryIds[i]}). Ask the student for a new code.`);
    const after: Entry = {
      ...before,
      status: 'AWAITING_SIGNATURE',
      updatedAt: at,
      request: { verifierSub: verifier.sub, verifierName: verifier.name, verifierEmail: verifier.email, requestedAt: at },
    };
    return { before, after };
  });
  const claimed: SignRequest = { ...req, status: 'CLAIMED', claimedBy: { sub: verifier.sub, name: verifier.name, at } };
  return { claimed, changes };
}
