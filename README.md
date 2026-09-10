# NeuroDev Time-Off Calendar

## Overview

Static site (plain ES modules, no build step) backed by Firebase Firestore.
Employees mark days they cannot work on a shared calendar; an admin portal
manages mentor profiles and generates monthly shift schedules from that data.

## Pages

### Employee Calendar (index.html)

- Employees pick their name in a slot dropdown on days they cannot work
- Data syncs in real time via Firestore snapshots

### Admin Portal (admin.html)

- Password protected (password set in `auth.js`)
- **Mentor Management**: name, hours wanted per week, recurring weekdays
  unavailable, preferred weekday, whether they appear on the employee calendar,
  whether they are included when generating schedules (two independent
  settings), and whether their recurring weekdays are prefilled onto the
  employee calendar.
  Requested days off are shown read-only, pulled from the calendar for the
  currently configured month; prefilled ones are marked as such.
- **Generate Schedule**: pick year/month, adjust holidays (defaults computed
  per year), optionally list "no scheduling" days (facility closed - no shifts
  at all; accepts lists and ranges like `4,15,20-22`), generate. Requested
  days off for that specific month are honored.
- **View Schedule**: calendar display with per-shift assignments, click any
  name to reassign, hours summary table, validation log. Hovering a week row
  shows a copy button that captures that week as an image to the clipboard
  (falls back to a PNG download). Manual edits are kept
  in memory until you click "Save Schedule"; leaving the page with unsaved
  edits prompts a warning.
- **Calendar Management**: set the month/year the employee calendar shows,
  number of slots per day, and "Clear Current Month & Auto-Fill", which wipes
  the month's entries and then prefills the recurring days off of every mentor
  with prefill enabled. A day whose slots are already full is skipped and
  reported. Prefilling is a visibility aid for employees - the scheduler blocks
  recurring weekdays whether or not the calendar is prefilled.

## Scheduling rules

See `SCHEDULE_MANAGEMENT.md` for the full algorithm. In short:

1. Hard rules: no assignments on requested days off, none on unavailable
   weekdays, one shift per day, max 80 hours per 14-day pay period
2. Pay periods are 14 days counted from January 1 (not month-aligned)
3. Preferred weekdays are assigned first, then hours are distributed at an
   equal rate toward each mentor's weekly target, then remaining shifts are
   force-filled and flagged

## Firebase Collections

### `timeOff/{CAMPUS_ID}`

Employee time-off selections, keyed by month, then day-of-month, with one
array entry per slot:

```
{
  mentors: {
    "2026-01": {
      "5": ["Sofia", "", ""],
      "12": ["Aidri", "Emma", ""]
    }
  },
  autoFilled: {
    "2026-01": { "12": ["Emma"] }   // placed by Clear & Auto-Fill, not requested
  }
}
```

`autoFilled` records which names the prefill put on the calendar, so the admin
portal can tell them apart from real employee requests. Both pages write the
whole document, so every write carries both fields.

Legacy documents keyed by bare day-of-month are migrated automatically the
first time either page loads them.

### `mentorInfo/{CAMPUS_ID}`

```
{
  mentors: {
    "Aidri": {
      hours_wanted: 30,
      weekdays: ["Monday"],          // recurring weekly days off
      preferred_weekdays: ["Sunday"],
      hard_dates: [1, 2, 3],         // requested days off (from the calendar)
      show_on_calendar: true,        // appears in employee-calendar dropdowns
      include_in_scheduling: true,   // eligible for generated schedules
      auto_fill_calendar: false      // prefill `weekdays` onto the calendar
    }
  }
}
```

### `calendarConfig/{CAMPUS_ID}`

`{ targetMonth, targetYear, slotsAvailable }` - which month the employee
calendar displays and how many request slots each day has.

### `savedSchedules/{CAMPUS_ID}_{month}_{year}`

One document per generated month. See `SCHEDULE_MANAGEMENT.md`.

## Configuration

- **Admin password**: `ADMIN_PASSWORD` in `auth.js`
- **Shift hours**: `SEASONAL_SHIFT_INFO` in `admin.js`
- **Holidays**: `computeNationalHolidays` in `admin.js`
- **Campus**: `CAMPUS_ID` in `config.js`

## Tests

Pure logic (scheduler rules, date helpers) is covered by Node's built-in test
runner - no dependencies to install:

```
npm test
```

Run from WSL (or anywhere Node 18+ is available).

## Known limitations

- Client-side password auth only; Firestore security rules should be added
  before treating the data as protected
- Holidays are hardcoded for the St. George campus (includes Utah state
  holidays)
