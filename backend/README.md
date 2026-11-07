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

## College requirement sets

Institutions usually have their own logbook on top of Annexure A: more skills, adult/paediatric splits,
minimums per year of study, and record-only lists such as medications. Each one is a **requirement set** in
`data/requirement-sets/`:

- `<id>.json`: the institution's exact name (must match the users' `custom:institution`) and its programmes,
  each with the HPCSA category it leads to and its number of years
- `<id>.csv`: one row per college skill, with `hpcsa_skill_id` (the Annexure A skill it counts toward, blank for
  college-only skills), `record_only`, and a minimum column per programme year (`HCEMC_Y1`, `DIPEMC_Y1`…).
  A number is that year's minimum, `0` means offered with no minimum, and blank means not in that year's list.

`npm run requirements` rebuilds `src/requirement-sets.json` and checks every mapping.

Students on a programme log against their college list. Every entry is stamped with their year of study at the
time, so progress shows **this year's college target**, the **college total to graduation**, and the
**HPCSA minimums** (through the mapping). Students without a programme log against Annexure A directly.

`wcg-cec-2024` is the WCG College of Emergency Care logbook (2024/2025). It was built from
`requirements/college_logbook_requirements.csv`. Spelling variants across years are merged so a student's
counts carry over from year to year, and 14 judgement calls are marked `REVIEW:` in the `mapping_note`
column for a clinical lead to confirm before real data goes in.

## Reports

For lecturers and admins, limited to their own institution:

- **Cohort progress** (`reports.html`): every student's pace this year (on track, behind, at risk, no activity),
  filterable by programme and year; per-skill view of where the cohort is lagging; CSV export with one row per
  student per skill (college and HPCSA).
- **HPCSA progress summary** (`hpcsa_summary.html`): printable report in the shape of the PBEC mid-year
  progress report, including whether difficulties are anticipated, per Annexure A skill. Student names are
  left out unless the user chooses to include them.
- **Requirement gap check** (`requirements_gap.html`): college minimums added across all years, compared with
  the Annexure A minimum for each skill.

Pace compares progress with how far through the academic year it is (default 1 February to 30 November; set
`ACADEMIC_YEAR=MM-DD:MM-DD` on the Lambda to change it). The thresholds are in `src/progress.ts` and
`src/reports.ts`.

## Signing on the spot

Besides sending entries to a supervisor's queue by email, a student can get them signed there and then:

- **QR code** (`request_signature.html` → *Show QR code*): the student's phone shows a code; the supervisor scans it
  with their own phone camera, signs in with their own account if needed, and signs (`qr_sign.html`). The student's
  screen updates when it's done.
- **Hand-over** (`handover.html`): the supervisor signs in on the student's phone. Their session is kept in page
  memory only, never in browser storage, and is revoked as soon as they finish, cancel, go idle for 3 minutes or
  leave the page. The student's own session is untouched.

Both use a single-use sign request: a random 128-bit code that expires after 15 minutes and can only be claimed by a
supervisor or lecturer other than the student. Only its SHA-256 hash is stored (`PK = SIGNREQ#<hash>`, removed by
DynamoDB TTL a day after expiry). The code travels in the URL fragment, which browsers never send to servers, and the
signing pages set `referrer` to `no-referrer`. Claiming assigns the entries to that verifier in one transaction, so
two people can't claim the same code; signing then uses the normal queue routes and rules.

## Offline logging

Students often have no signal on scene. The student pages work offline:

- **The app is kept on the phone** by a service worker (`sw.js`, HTTPS only). It fetches from the network first,
  so updates arrive whenever there is signal, and falls back to the saved copy. Only the site's own files are
  cached; API and sign-in requests are never touched. Students can also add it to their home screen
  (`manifest.webmanifest`).
- **The skill list, entries and progress are saved per student** in the browser after each successful load, so the
  log form and dashboard work offline (the dashboard says how old the list is).
- **Entries logged without signal go into an outbox** on the phone (shown as "Saved on this phone") and upload
  automatically when signal returns: on page load, when the phone comes back online, and every 30 seconds.
- **No duplicates:** each queued entry carries a UUID and the time it was recorded. The server derives the entry
  id from them, so if a reply is lost and the phone uploads the same entry again, the server returns the existing
  entry instead of creating a second one.
- An entry the server rejects (e.g. a skill no longer in the programme) stays on the phone with the reason, for the
  student to delete. Losing signal never signs anyone out; only a real rejection from Cognito does.

Offline entries still need a supervisor's signature once uploaded. When you remove a page or file from the app,
change `VERSION` in `sw.js` so phones drop the old copy.

## Accounts and roles

Accounts are created by an administrator (no self sign-up). Each person is in one Cognito group:
`student`, `supervisor`, `lecturer` or `admin`. Profile attributes are set by the admin and **cannot be
changed by the user** (the web client has no attribute write access):

- `custom:institution` — the training institution
- `custom:category` — students only: `ECA` (higher certificate), `PARAMEDIC` (diploma) or `ECP` (degree)
- `custom:reg_no` — HPCSA registration number (pre-fills the signature form for verifiers)
- `custom:programme` — students on a college programme, e.g. `WCG-DIPEMC` (sets institution and category)
- `custom:study_year` — the student's current year of study

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

## Managing people

Institution administrators manage their own institution's people in the browser at `admin_users.html`:

- add students, supervisors and lecturers one at a time, or **import a class list** from CSV (checked row by
  row before anything is created; a template is downloadable on the page)
- edit names, roles, programme, year of study and HPCSA registration numbers
- **move students to the next year** in bulk (final-year students are skipped)
- disable leavers (signs them out everywhere; their entries are kept), re-enable, resend invitations
- see a log of recent changes and who made them (stored as `AUDIT#<institution>` items in the table)

Admins can't create or change administrator accounts, change their own account, or touch other institutions.
New administrators are created by the platform operator with the command below.

### Invitation emails: use Amazon SES before importing classes

Cognito's built-in email sender only allows a small number of emails a day, which one class import can use up.
For a pilot, verify a sender address in Amazon SES (and request production access), then deploy with it:

```bash
npx cdk deploy -c sesFromEmail=logbook@yourcollege.ac.za -c sesRegion=<region where the address is verified> --outputs-file cdk-outputs.json
```

## Create users from the command line

```bash
npm run create-user -- --email jane@college.ac.za --name "Jane Doe" --role student \
  --programme WCG-DIPEMC --year 1
npm run create-user -- --email lee@college.ac.za --name "L. Lecturer" --role lecturer \
  --institution "WCG College of Emergency Care" --reg-no PA7654321
npm run create-user -- --email b.jones@ems.gov.za --name "B. Jones" --role supervisor \
  --institution "WCG College of Emergency Care" --reg-no PA1234567
npm run set-year -- --email jane@college.ac.za --year 2     # at the start of each academic year
```

Students at an institution without a requirement set use `--institution "…" --category ECA|PARAMEDIC|ECP`
instead of `--programme`.

Cognito emails a temporary password; the login page makes them choose a new one on first sign-in.

## API

All routes need the Cognito **ID token** in the `Authorization` header.

| Route | Role | Purpose |
|---|---|---|
| `GET /me` | any | Your profile from the token |
| `GET /catalogue` | any | The skills you log against: your college programme's list, or Annexure A |
| `GET /entries` | student | Your entries, newest first |
| `POST /entries` | student | Create an entry `{kind, performedOn, setting, encounterRef?, notes?, skills:[{skillId,count}]}`; offline uploads add `{clientId, recordedAt}` and are idempotent |
| `DELETE /entries/{entryId}` | student | Delete a draft or returned entry |
| `POST /entries/request-signature` | student | `{entryIds:[…], verifierEmail}` (up to 25 at once, all-or-nothing) |
| `POST /entries/sign-requests` | student | `{entryIds}` → single-use signing code (15 minutes) |
| `POST /sign-requests/claim` | supervisor, lecturer | `{token}`: assigns the entries to you for signing |
| `GET /progress[?studentSub=]` | student, lecturer, admin | `{hpcsa, college}` progress |
| `GET /reports/cohort[?programme=&year=&detail=1]` | lecturer, admin | Cohort pace, lagging skills, export rows |
| `GET /reports/hpcsa-summary?programme=` | lecturer, admin | PBEC-style progress summary |
| `GET /reports/gap` | lecturer, admin | College requirements vs Annexure A |
| `GET /admin/people` | admin | Everyone at your institution with roles and status |
| `POST /admin/people` | admin | Add a person (sends an invitation) |
| `POST /admin/people/import` | admin | `{rows, dryRun}`, up to 50 rows per request |
| `POST /admin/people/promote` | admin | `{subs}`: move students to their next year |
| `POST /admin/people/{sub}` | admin | Change name, role, programme, year, registration number |
| `POST /admin/people/{sub}/enabled` | admin | `{enabled}`: disable or re-enable |
| `POST /admin/people/{sub}/resend-invite` | admin | Resend the invitation email |
| `GET /admin/audit` | admin | Recent changes |
| `GET /queue` | supervisor, lecturer | Entries awaiting your signature |
| `GET /queue/{studentSub}/{entryId}` | supervisor, lecturer | One entry in your queue |
| `POST /queue/{studentSub}/{entryId}/sign` | supervisor, lecturer | `{witnessedSkillIds:[…], regNo, comment?}` |
| `POST /queue/{studentSub}/{entryId}/return` | supervisor, lecturer | `{reason}` |

## Data

One DynamoDB table. Entries: `PK=STUDENT#<sub>`, `SK=ENTRY#<entryId>`. While an entry awaits a signature
it is also indexed on `GSI1` by `VERIFIER#<sub>` so each verifier's queue is a single query. Every entry is
indexed on `GSI2` by `INST#<institution>` so a cohort report is a single query.

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

## Not built yet

Peer sign-off, the paper-scan verification flow, and audit export. The data model keeps the signer, registration
number and timestamps on every signed entry so these can be built on top.
