# Brief: migrate the Night Mentor Scheduler into the hub

**For:** a Claude Code session opened in `NeuroDev/neurodev-hub` (with read access to the sibling folder `../NeuroDev-Time-Off-Calendar`, which is where this brief and the old app live). All new code goes in `neurodev-hub`; nothing is built in the old repo.
**Confirmed by Topher 2026-09-17:** the scheduler becomes a module of the hub (`hub.neurodevlabs.com/schedule`), not its own Render service. Night mentors become ordinary hub accounts, and this module is the base for later features (see "What comes next").
**Owner:** Topher. **Written:** 2026-09-17. **Umbrella plan:** `../PROJECT.md`.

## Goal

Replace the static GitHub Pages + Firestore app in `../NeuroDev-Time-Off-Calendar` with a module inside this repo: FastAPI + Postgres (`schedule` schema) on the backend, React pages under `/schedule` on the frontend, using the hub's existing Google staff login. When done, Firestore project `timeoffcalendar-1d3ab` can be retired.

**Behaviour must not change** except where listed under "Deliberate changes". This tool produces real people's work schedules every month.

## Read first (in this order)

1. `../NeuroDev-Time-Off-Calendar/README.md` and `SCHEDULE_MANAGEMENT.md` — the spec for the rules.
2. `../NeuroDev-Time-Off-Calendar/scheduler.js` (457 lines) and `dates.js` (129) — the pure logic to port.
3. `../NeuroDev-Time-Off-Calendar/tests/scheduler.test.js` and `tests/dates.test.js` — port these first.
4. `../NeuroDev-Time-Off-Calendar/admin.js` (1375), `calendar.js`, `firebase.js`, `config.js` — UI behaviour and Firestore shapes.
5. This repo: `README.md`, `backend/app/routers/links.py` (router pattern), `backend/app/dependencies/auth.py`, `backend/alembic/env.py`, `backend/tests/conftest.py`, `frontend/src/pages/ManageLinksPage.tsx` (UI pattern), `frontend/src/index.css` (button/field classes).

## Hard rules for this repo

- Test-first. Write the failing test, watch it fail, implement. `pytest`, `ruff check`, `mypy`, and frontend `lint` / `typecheck` / `test` / `build` must all pass before every commit. CI runs the same.
- This database is shared with the live, paid IDEA Inventory. Only touch the `core`, `hub`, and new `schedule` schemas. Never touch `public`. Add `schedule` to `OWNED_SCHEMAS` in `backend/alembic/env.py` and to `app/database.py`.
- Migrations are additive Alembic revisions after `0001`. Never edit `0001`.
- No new paid Render services. The scheduler ships inside `hub-backend` and `hub-frontend`.
- UX rules (audience includes neurodivergent staff): one primary action per screen, status as a word not only a colour, no modal stacking, no `window.confirm`/`alert`, errors persist until dismissed, visible "Saved" receipt, 44px targets, plain language, respect `prefers-reduced-motion`.
- Work on a branch `scheduler`, small commits, open a PR to `main`. Do not deploy, do not change DNS, do not delete anything in Firebase.
- Ask Topher rather than guess when the old code and the docs disagree. Record the answer in a "Decisions" section at the bottom of this file.

## Work plan

### Step 1 — Port the pure logic (no DB, no HTTP)

Create `backend/app/schedule/dates.py` and `backend/app/schedule/engine.py`. Port `tests/dates.test.js` and `tests/scheduler.test.js` to `backend/tests/schedule/` **first**, one JS test to one pytest test with the same name and the same fixtures, then make them pass. Rules to preserve exactly:

- Hard rules: no assignment on a requested day off; none on a recurring unavailable weekday; one shift per mentor per day; max 80 hours per 14-day pay period; pay periods are counted from January 1 and do not align with months, including across a month boundary.
- Phases: preferred weekdays first, then equal-rate distribution toward each mentor's target (weekly hours x days-in-month / 7), then force-fill by fewest hours with each forced shift flagged in the validation log, then final stats with a warning when more than 5 hours off target.
- "No scheduling" days (lists and ranges like `4,15,20-22`) produce no shifts.
- The JS tests run with `TZ=America/Denver`. Use `datetime.date` everywhere in Python so there is no timezone dependence; add one test proving a month boundary and a DST week give the same result as the JS expectations.
- If the algorithm uses randomness or object key order for tie-breaking, make it deterministic (sort by name) and say so in Decisions.

### Step 2 — Schema (`schedule`), migration `0002`

```
schedule.mentors            id, account_id (FK core.accounts, nullable until they first sign in), campus,
                            display_name, hours_wanted, unavailable_weekdays int[], preferred_weekdays int[],
                            show_on_calendar, include_in_scheduling, auto_fill_calendar, is_active
schedule.time_off           id, mentor_id, campus, day (date), source 'requested'|'prefill', created_at
                            UNIQUE (mentor_id, day)
schedule.calendar_config    campus PK, target_year, target_month, slots_per_day
schedule.shift_definitions  id, campus, season, weekday, shift_code, start_time, end_time, hours
                            (seeded from SEASONAL_SHIFT_INFO in admin.js)
schedule.holidays           id, campus, day (date), name   (seeded per year from computeNationalHolidays;
                            St. George includes Utah state holidays)
schedule.schedules          id, campus, year, month, status 'draft'|'saved', no_scheduling_days int[],
                            validation_log jsonb, generated_at, saved_at, saved_by  UNIQUE (campus, year, month)
schedule.assignments        id, schedule_id, day (date), shift_code, mentor_id (nullable = unfilled),
                            hours, forced bool, manually_edited bool
```

`campus` is a short text key (`stg`, `ral`) on every table. Only `stg` has data today; nothing may assume a single campus.

### Step 3 — API (`backend/app/routers/schedule.py`, prefix `/api/v1/schedule`)

Any signed-in staff: read calendar config, read the month's time-off grid, add/remove **their own** time off (respecting `slots_per_day`), read the saved schedule.
Admin only (`get_current_admin`): mentor CRUD, calendar config, clear-month-and-auto-fill (skips full days and reports them), generate (returns a draft plus validation log, does not save), reassign a shift, save schedule, list saved schedules.
Mentors are matched to accounts by email on first sign-in; admins can link manually.

### Step 4 — Frontend

Routes inside the existing hub app: `/schedule` (month calendar, mark my days off), `/schedule/view` (saved schedule, hours summary), `/schedule/admin` (tabs: Mentors, Generate, View/Edit, Calendar). Keep the copy-week-as-image button. Unsaved manual edits warn before leaving (inline banner, not a browser dialog). Add a "Night Mentor Schedule" link card via a data migration that updates the existing starter link's URL to `/schedule`.

### Step 5 — Import script

`backend/scripts/import_firestore_schedule.py`: reads a JSON export of `timeOff`, `mentorInfo`, `calendarConfig`, `savedSchedules` (Topher will supply the export from Firebase project `timeoffcalendar-1d3ab`; write `scripts/export_firestore_schedule.mjs` using `firebase-admin` so he can produce it). Idempotent, `--dry-run` prints one line per row (`create` / `skip` / `conflict`), handles the legacy bare day-of-month keys described in the old README, keeps `autoFilled` entries as `source='prefill'`. A second dry run after a real run must show only `skip`.

### Step 6 — Parity check

A test that loads a real exported month (fixture with names replaced by `Mentor A`...), runs the Python engine, and asserts the hard rules hold and hours per mentor are within the same tolerance as the saved JS schedule for that month.

## What comes next (design for it, do not build it)

Topher plans to grow this module once the port is live: mentors see their own schedule, get notified, and swap shifts among themselves. Build the port so those are additions, not rewrites:

- Every `schedule.mentors` row links to a `core.accounts` row (matched by email on first sign-in). "Who am I" always comes from the signed-in account, never from a picked name.
- `schedule.assignments` is one row per shift per day with a real `mentor_id`, so "my upcoming shifts" is a simple query. **Include a read-only "My shifts" list on `/schedule` in this port**; it is cheap and is the first thing mentors will want.
- Keep a change history: `schedule.assignment_changes` (assignment_id, from_mentor_id, to_mentor_id, changed_by, reason, created_at), written on every manual reassignment. Swaps will later be a request/approve flow that ends in the same write.
- Any reassignment, manual now or a swap later, must go through one service function that re-checks the hard rules (80h pay period, days off, unavailable weekdays, one shift a day) for both mentors and returns the violations. Write and test that function now; the admin "reassign" action uses it.
- Notifications are out of scope, but emit a domain event (a plain function call such as `on_schedule_saved(schedule)` / `on_assignment_changed(change)`) at the two obvious points so email or in-app notices can hook in later.

Do not build swap requests, notifications, or mentor-to-mentor messaging in this PR.

## Deliberate changes (approved)

- Sign-in replaces the pick-your-name dropdown and the client-side admin password in `auth.js`.
- Multi-campus columns from day one; holidays and shift hours become data, not code.
- Add `schedule.holiday_history` view or query so admins can see who worked recent holidays (fairness); do not change the algorithm for it yet.

## Out of scope

Deployment, DNS, deleting Firestore data, changing the scheduling algorithm, Raleigh data entry.

## Done means

All checks green; PR open; `docs/scheduler-cutover.md` written with the exact cutover steps for Topher (export, dry run, import, one month in parallel, then archive the old repo).

## Decisions

- 2026-09-17 (Topher): campus lives on `schedule.mentors` only, not on `core.accounts`. `/schedule` uses the signed-in person's mentor row; staff without one see "ask an admin to add you". Admin pages get a campus switcher.
- 2026-09-17 (Topher): create `core.campuses` now (`stg` St. George, `ral` Raleigh); schedule tables FK to it.
- 2026-09-17 (Topher): frontend tests cover pure logic only (vitest, node); behaviour coverage is the backend pytest suite. No jsdom/testing-library added.
- 2026-09-17 (Topher): review after each step of this brief; one `scheduler` branch, one PR.
- 2026-09-17 (Topher): drafts are persisted. Generate upserts a `draft` row for the month; one draft and one saved schedule may coexist per month (UNIQUE on campus, year, month, status). Reassign edits either through one validated service function and writes `assignment_changes`. "Save" promotes the draft (old saved row deleted, draft becomes `saved`) and fires `on_schedule_saved`.
- Engine: mentors are processed in display-name order (the JS relied on object key order). Same hard rules, same phases.
- Weekdays are stored as `int[]`, 0 = Sunday .. 6 = Saturday (matches the JS `getDay()` values in the old data and the Sun..Sat display). The engine still takes weekday names; the service layer converts.
- Season stays code (May, June, July = summer). Shift hours and holidays become rows. Holiday shifts are `shift_definitions` rows with `season = 'holiday'`, `weekday = NULL`, codes `holiday_a_shift` / `holiday_b_shift`, 9h each.
- `shift_definitions.start_time` / `end_time` are seeded from the old calendar header strings (`shiftTimesByDay`) and `hours` from `SEASONAL_SHIFT_INFO`. They do not agree today (Sunday shows 1:00-10:00 but stores 10h). Times are display labels only; hours drive the schedule. Flagged to Topher.
- `mentorInfo.hard_dates` is not migrated; `schedule.time_off` is the only source of requested days off.
- `schedule.schedules.mentor_snapshot` (jsonb) keeps each mentor's target and days off as generated, because the old hours table deliberately read the snapshot rather than the live mentor row.
- Deleting a mentor sets `is_active = false`; assignments keep pointing at them.
- Unsaved edits: inline banner plus in-page tab guard. `beforeunload` only guards a tab close or reload. React Router here is `BrowserRouter`, so `useBlocker` is unavailable and nav links are not blocked.
- Parity (Step 6) first runs against a fixture produced by the old JS engine from the JS test data (true port check, no Firestore needed). A second fixture from a real anonymised export is added when Topher supplies it.
- `time_off` slot limit: a POST on a day that already has `slots_per_day` entries returns 409 "That day is full."
- `html2canvas` becomes an npm dependency instead of a CDN script.
- Mentors link to `core.accounts` (as this brief says); `core.people` in PROJECT.md does not exist yet.
- Validation log lines keep the old text verbatim, including the ✓ / ✗ / ⚠ markers, so admins see the log they are used to.
- Reassign: the service check blocks a reassignment that breaks a hard rule (409 with the reason). Because the old app allowed any edit, admins can pass `override: true`; the violation is then written into the change history's reason, e.g. "Emma agreed to cover (override: requested day off)". Flagged to Topher.
- Generate uses the holidays table for the month unless the request sends `holiday_days` explicitly (an empty list means no holidays). Drafts are replaced on regenerate; saving deletes the previous saved month.
- Import: a mentor name that appears only in time off or a saved schedule (not in `mentorInfo`) gets an inactive, unscheduled mentor row and a `conflict` line, so old assignments keep their name; later runs report it as `skip`. Saved schedules print one line each with the shift count rather than one per assignment. Assignment dates in the export are UTC instants from the admin's browser, so the importer converts them with `--timezone` (default America/Denver).
- Export: `scripts/export_firestore_schedule.mjs` pins `firebase-admin` 13 (14 needs Node 22; the WSL here has Node 18) and reads the service account from `GOOGLE_APPLICATION_CREDENTIALS`. It has its own `scripts/package.json` so the hub frontend does not carry the dependency.
- Parity (done 2026-09-18): the real export supplied by Topher gave two full-snapshot months, September and October 2026, anonymised to `Mentor A`..`G`. The Python engine reproduces the old JS engine on both shift for shift (`tests/schedule/test_parity.py`, fixtures built by `make_js_parity_fixture.mjs`). The saved October schedule differs from the engine's output, so it was hand-edited; the saved months are held only to a tolerance. Months before August 2026 have no mentor snapshot in Firestore, so after import their hours tables show no targets.
- Local dev: Windows has Python 3.14, which the pinned SQLAlchemy does not support, so the backend venv lives in WSL (`backend/.venv`, gitignored) and Postgres runs from `docker compose up postgres` on port 5434.

