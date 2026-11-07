/**
 * Creates a logbook account and emails the person a temporary password.
 *
 *   npm run create-user -- --email jane@college.ac.za --name "Jane Doe" --role student \
 *       --programme WCG-DIPEMC --year 1
 *     (programme sets the institution and HPCSA category; see src/requirement-sets.json)
 *   npm run create-user -- --email sam@other.ac.za --name "Sam" --role student \
 *       --institution "Other College" --category ECA          (no college requirement set: HPCSA only)
 *   npm run create-user -- --email b.jones@ems.gov.za --name "B. Jones" --role supervisor \
 *       --institution "WCG College of Emergency Care" --reg-no PA1234567
 */
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { parseArgs } from 'node:util';
import { CATEGORIES } from '../src/catalogue-types.js';
import { ROLES } from '../src/domain.js';
import { readOutputs } from './outputs.js';
import { getProgramme, requirementSets } from '../src/requirements.js';

const { values: a } = parseArgs({
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    role: { type: 'string' },
    institution: { type: 'string' },
    category: { type: 'string' },
    'reg-no': { type: 'string' },
    programme: { type: 'string' },
    year: { type: 'string' },
    stage: { type: 'string' },
  },
});

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}
if (a.programme) {
  const p = getProgramme(a.programme) ?? fail(`Unknown --programme. Known: ${requirementSets.flatMap((s) => s.programmes.map((x) => x.id)).join(', ')}`);
  if (a.role !== 'student') fail('--programme is only for students');
  const y = Number(a.year);
  if (!Number.isInteger(y) || y < 1 || y > p.programme.years) fail(`--year must be 1 to ${p.programme.years} for ${p.programme.name}`);
  if (a.institution && a.institution !== p.set.institution) fail(`--institution must match the programme's institution "${p.set.institution}" (or leave it out)`);
  a.institution = p.set.institution;
  if (a.category && a.category !== p.programme.category) fail(`${p.programme.name} leads to ${p.programme.category}; leave --category out`);
  a.category = p.programme.category;
}
if (!a.email || !a.name || !a.role || !a.institution) fail('Required: --email --name --role and --institution (or --programme for students)');
if (!(ROLES as readonly string[]).includes(a.role!)) fail(`--role must be one of ${ROLES.join(', ')}`);
if (a.role === 'student' && !(CATEGORIES as readonly string[]).includes(a.category ?? ''))
  fail(`Students need --programme, or --category ${CATEGORIES.join(' | ')} (ECA = higher certificate, PARAMEDIC = diploma, ECP = degree)`);
const known = [...new Set(requirementSets.map((s) => s.institution))];
if (a.role !== 'student' && known.length && !known.includes(a.institution!))
  console.warn(`Note: "${a.institution}" has no requirement set loaded (known: ${known.join(', ')}). Reports match on the exact institution name.`);

const o = readOutputs(a.stage);
const cognito = new CognitoIdentityProviderClient({ region: o.Region });
const email = a.email!.trim().toLowerCase();

const attrs = [
  { Name: 'email', Value: email },
  { Name: 'email_verified', Value: 'true' },
  { Name: 'name', Value: a.name! },
  { Name: 'custom:institution', Value: a.institution! },
  ...(a.category ? [{ Name: 'custom:category', Value: a.category }] : []),
  ...(a['reg-no'] ? [{ Name: 'custom:reg_no', Value: a['reg-no'] }] : []),
  ...(a.programme ? [{ Name: 'custom:programme', Value: a.programme }, { Name: 'custom:study_year', Value: String(Number(a.year)) }] : []),
];

const created = await cognito.send(
  new AdminCreateUserCommand({ UserPoolId: o.UserPoolId, Username: email, UserAttributes: attrs, DesiredDeliveryMediums: ['EMAIL'] }),
);
await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: o.UserPoolId, Username: created.User!.Username!, GroupName: a.role! }));
console.log(`Created ${a.role} ${email}; a temporary password has been emailed.`);
