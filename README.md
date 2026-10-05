# Clinical Skills Logbook

A proof-of-concept web platform for recording and verifying the practical clinical
skills of emergency-care students — the digital replacement for a paper skills
logbook. Built from the perspective of someone who has been both the student
carrying the logbook and the lecturer signing it off.

> Status: interactive front-end prototype (static HTML/CSS/JS). All data shown is
> mock/placeholder data — no real student or patient information.

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

- Back this with a real datastore (Supabase / PostgreSQL) and authentication.
- Move signatures and QR verification to a secure, auditable record.
- Align the data model with health-interoperability standards (HL7 FHIR).
