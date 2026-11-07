/**
 * Creates a logbook account and emails the person a temporary password.
 *
 *   npm run create-user -- --email jane@college.ac.za --name "Jane Doe" --role student \
 *       --institution "WCG College of Emergency Care" --category ECA
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

const { values: a } = parseArgs({
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    role: { type: 'string' },
    institution: { type: 'string' },
    category: { type: 'string' },
    'reg-no': { type: 'string' },
    stage: { type: 'string' },
  },
});

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}
if (!a.email || !a.name || !a.role || !a.institution) fail('Required: --email --name --role --institution');
if (!(ROLES as readonly string[]).includes(a.role!)) fail(`--role must be one of ${ROLES.join(', ')}`);
if (a.role === 'student' && !(CATEGORIES as readonly string[]).includes(a.category ?? ''))
  fail(`Students need --category ${CATEGORIES.join(' | ')} (ECA = higher certificate, PARAMEDIC = diploma, ECP = degree)`);

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
];

const created = await cognito.send(
  new AdminCreateUserCommand({ UserPoolId: o.UserPoolId, Username: email, UserAttributes: attrs, DesiredDeliveryMediums: ['EMAIL'] }),
);
await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: o.UserPoolId, Username: created.User!.Username!, GroupName: a.role! }));
console.log(`Created ${a.role} ${email}; a temporary password has been emailed.`);
