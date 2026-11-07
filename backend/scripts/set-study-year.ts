/**
 * Moves a student to another year of study (e.g. at the start of the academic year). Entries already logged keep
 * the year they were logged in.
 *   npm run set-year -- --email jane@college.ac.za --year 2
 */
import { AdminUpdateUserAttributesCommand, CognitoIdentityProviderClient, ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider';
import { parseArgs } from 'node:util';
import { getProgramme } from '../src/requirements.js';
import { readOutputs } from './outputs.js';

const { values: a } = parseArgs({ options: { email: { type: 'string' }, year: { type: 'string' }, stage: { type: 'string' } } });
const fail = (m: string): never => { console.error(m); process.exit(1); };
if (!a.email || !a.year) fail('Required: --email --year');
const o = readOutputs(a.stage);
const cognito = new CognitoIdentityProviderClient({ region: o.Region });
const email = a.email!.trim().toLowerCase().replace(/["\\]/g, '');
const r = await cognito.send(new ListUsersCommand({ UserPoolId: o.UserPoolId, Filter: `email = "${email}"`, Limit: 2 }));
const u = r.Users?.length === 1 ? r.Users[0] : fail(`No single user with email ${email}`);
const programmeId = u.Attributes?.find((x) => x.Name === 'custom:programme')?.Value;
const p = getProgramme(programmeId) ?? fail(`${email} has no programme set`);
const y = Number(a.year);
if (!Number.isInteger(y) || y < 1 || y > p.programme.years) fail(`--year must be 1 to ${p.programme.years} for ${p.programme.name}`);
await cognito.send(new AdminUpdateUserAttributesCommand({ UserPoolId: o.UserPoolId, Username: u.Username!, UserAttributes: [{ Name: 'custom:study_year', Value: String(y) }] }));
console.log(`${email} is now in year ${y} of ${p.programme.name}. They need to sign in again for it to take effect.`);
