# Logbook backend (AWS serverless)

The backend for the clinical skills logbook: students log skills, a named supervisor or lecturer signs them
under their own login, and progress is counted against the HPCSA Professional Board for Emergency Care
minimums (letter of 14 March 2021, Annexure A).

```
Browser (V2 pages) ──Cognito sign-in──▶ Amazon Cognito user pool
        │                                      │ ID token (JWT)
        └──HTTPS + token──▶ API Gateway HTTP API ──JWT check──▶ Lambda (Node 22) ──▶ DynamoDB
```

Everything is defined in AWS CDK (`lib/logbook-stack.ts`) and deploys to **af-south-1 (Cape Town)** by
default so student data stays in South Africa.

## The core loop

| Step | Who | What happens |
|---|---|---|
| Log | Student | Saves a patient encounter or skills session with the Annexure A skills and counts performed. Status `DRAFT`. |
| Request | Student | Picks entries and enters a supervisor's or lecturer's email. The API checks that person has a verifier account. Status `AWAITING_SIGNATURE`. |
| Sign | Supervisor / lecturer | Sees it in their queue, unticks anything not witnessed, adds their registration number and attests. Status `SIGNED` (immutable). Unticked skills are kept as `NOT_WITNESSED`. |
| Return | Supervisor / lecturer | Sends it back with a reason. Status `RETURNED`; the student can fix, delete or re-send it. |
| Progress | Student, lecturer | Only `VERIFIED` skills on signed entries count. Each signed encounter counts as one patient seen. |

Rules enforced on the server: students can't sign their own entries; only the requested verifier can sign;
an entry can be signed once; lecturers only see students at their own institution; concurrent edits are
rejected rather than overwritten.

## Accounts and roles

Accounts are created by an administrator (no self sign-up). Each person is in one Cognito group:
`student`, `supervisor`, `lecturer` or `admin`. Profile attributes are set by the admin and **cannot be
changed by the user** (the web client has no attribute write access):

- `custom:institution` — the training institution
- `custom:category` — students only: `ECA` (higher certificate), `PARAMEDIC` (diploma) or `ECP` (degree)
- `custom:reg_no` — HPCSA registration number (pre-fills the signature form for verifiers)

## Deploy

You need an AWS account, Node 20+, and AWS credentials on your machine (`aws configure` or SSO).
**af-south-1 is an opt-in region**: enable it once in the AWS console under *Account → AWS Regions*.

```bash
cd backend
npm install
npx cdk bootstrap            # once per account/region
npm run deploy               # deploys, then writes ../js/config.js
```

`npm run deploy` writes `js/config.js` with the API URL and Cognito IDs (public values, safe to commit).
Serve the `V2` folder from any static host (your current Apache host works; just upload `js/` and `css/live.css` too).

For production, lock CORS to your site and use a separate stage:

```bash
npx cdk deploy -c stage=prod -c 'allowedOrigins=["https://logbook.example.ac.za"]' --outputs-file cdk-outputs.json
npx tsx scripts/write-frontend-config.ts --stage prod
```

The `prod` stage turns on DynamoDB deletion protection and keeps the user pool if the stack is deleted.
The table is always kept and has point-in-time recovery.

## Create users

```bash
npm run create-user -- --email jane@college.ac.za --name "Jane Doe" --role student \
  --institution "WCG College of Emergency Care" --category ECA
npm run create-user -- --email b.jones@ems.gov.za --name "B. Jones" --role supervisor \
  --institution "WCG College of Emergency Care" --reg-no PA1234567
```

Cognito emails a temporary password; the login page makes them choose a new one on first sign-in.

## API

All routes need the Cognito **ID token** in the `Authorization` header.

| Route | Role | Purpose |
|---|---|---|
| `GET /me` | any | Your profile from the token |
| `GET /catalogue` | any | Annexure A skills with minimums for your category |
| `GET /entries` | student | Your entries, newest first |
| `POST /entries` | student | Create an entry `{kind, performedOn, setting, encounterRef?, notes?, skills:[{skillId,count}]}` |
| `DELETE /entries/{entryId}` | student | Delete a draft or returned entry |
| `POST /entries/request-signature` | student | `{entryIds:[…], verifierEmail}` (up to 25 at once, all-or-nothing) |
| `GET /progress[?studentSub=]` | student, lecturer, admin | Progress against Annexure A |
| `GET /queue` | supervisor, lecturer | Entries awaiting your signature |
| `GET /queue/{studentSub}/{entryId}` | supervisor, lecturer | One entry in your queue |
| `POST /queue/{studentSub}/{entryId}/sign` | supervisor, lecturer | `{witnessedSkillIds:[…], regNo, comment?}` |
| `POST /queue/{studentSub}/{entryId}/return` | supervisor, lecturer | `{reason}` |

## Data

One DynamoDB table. Entries: `PK=STUDENT#<sub>`, `SK=ENTRY#<entryId>`. While an entry awaits a signature
it is also indexed on `GSI1` by `VERIFIER#<sub>` so each verifier's queue is a single query.

The skill catalogue is generated from `data/hpcsa_2021_annexure_a.csv` into `src/catalogue.json`
(`npm run catalogue`). Skill ids are slugs of the HPCSA wording, so keep the names stable once real data
exists. "Total number of patients seen" is derived from signed encounters, not logged directly.

Encounter references are free text limited to 60 characters; the form tells students not to enter patient
names, ID numbers or contact details (POPIA).

## Develop and test

```bash
npm test          # unit + API tests against in-memory DynamoDB/Cognito mocks
npm run typecheck
npm run synth     # renders the CloudFormation template without deploying
```

## Not in this first slice

Admin user management UI, institution/cohort reports for the HPCSA, QR-code and hand-over signing,
peer sign-off, the paper-scan verification flow, offline logging, and audit export. The data model keeps
the signer, registration number and timestamps on every signed entry so these can be built on top.
