# Clinical Skills Logbook

A proof-of-concept web platform for recording and verifying the practical clinical
skills of emergency-care students — the digital replacement for a paper skills
logbook. Built from the perspective of someone who has been both the student
carrying the logbook and the lecturer signing it off.

> Status: the core loop (sign in → log skills → request signature → supervisor signs →
> progress against HPCSA minimums) runs on a real AWS serverless backend in `backend/`.
> Other pages are still front-end mock-ups with placeholder data. With no backend
> configured, the wired pages show a demo notice and the login page offers demo shortcuts.

## The problem it solves

Paramedic and emergency-care students must log hundreds of supervised skills and
patient encounters, each signed off by a lecturer, supervisor or peer. On paper
this is slow, easy to lose, hard to audit, and painful to report on. This project
digitises that workflow.

## What it does

- **Role-based dashboards** — separate views for students, lecturers, supervisors
  and administrators.
- **Encounter & skill logging** — record a patient encounter or a single skill
  against the official skill reference list.
- **Signature capture & verification** — lecturer, supervisor and peer sign-off
  forms, plus a *rapid verification* view for confirming a logged skill at a glance.
- **QR code identification** — each record carries a QR code for quick lookup.
- **Offline-friendly student view** — a lightweight PWA-style dashboard the student
  can use on scene.

## Backend

`backend/` is an AWS CDK app: Cognito sign-in, an API Gateway HTTP API, one Lambda
function and a DynamoDB table, deployed to af-south-1 (Cape Town). The skill catalogue
and minimums come from HPCSA PBEC Annexure A (March 2021). See
[backend/README.md](backend/README.md) for deploy steps, roles and the API.

Pages wired to it: `login`, `log_new_encounter`, `log_single_skill`,
`student_pwa_dashboard`, `request_signature`, `lecturer_dashboard` (sign-off queue),
`supervisor_sig_form` and `skills_tracker`, plus the institution reports `reports` (cohort progress and
CSV export), `hpcsa_summary` (printable PBEC progress report) and `requirements_gap`. Students on a college
programme log against their college logbook list (the WCG CEC logbook is loaded), mapped to HPCSA Annexure A.
Institution administrators manage people at `admin_users.html`. Shared browser code is in `js/api.js`.

## Structure

```
V2/
├── index.html                 # entry / landing
├── login.html
├── student_pwa_dashboard.html # student view
├── lecturer_dashboard.html
├── admin_dashboard.html
├── log_new_encounter.html
├── log_single_skill.html
├── skills_tracker.html
├── rapid_verification.html    # fast sign-off confirmation
├── digital_qr_code.html
├── *_sig_form.html            # lecturer / supervisor / peer signature forms
├── skill_reference_list.html
└── css/style.css
```

## Why I built it

I teach emergency-care students and manage the systems they learn on. This project
is where my clinical background and my IT studies meet: it is a real clinical
workflow, modelled by someone who has lived both sides of it. It is the direction
I want to take my career — health informatics and clinical systems.

## Roadmap

- ~~Back this with a real datastore and authentication~~ (done: AWS Cognito + DynamoDB).
- ~~Institution and cohort reports for the HPCSA~~ (done: cohort view, export, PBEC summary, gap check).
- QR-code / hand-over signing and peer sign-off on the same auditable record.
- ~~Admin screens for managing users and cohorts~~ (done: `admin_users.html`, with class-list import and year moves).
- Align the data model with health-interoperability standards (HL7 FHIR).
