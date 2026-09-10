# Schedule Management System

## Overview

The scheduler generates monthly schedules for mentors based on their
availability, preferred days, and target hours, distributing hours at an equal
rate so everyone approaches their target together.

## Scheduling Rules

### Hard Rules (Must Be Followed)

1. **80-Hour Pay Period Limit**: No mentor can work more than 80 hours in a
   2-week pay period
2. **No Working Requested Days Off**: Days marked on the time-off calendar for
   the month being generated are strictly honored
3. **No Working Unavailable Weekdays**: Recurring weekdays marked in the
   mentor profile are never scheduled
4. **One Shift Per Day**: Each mentor can only work one shift per day

### Scheduling Phases

1. **Preferred Weekdays First**: Mentors with a preferred weekday get
   scheduled on that day every week (unless a hard rule prevents it)
2. **Equal Rate Distribution**: Hours are given at the same rate to all
   mentors until everyone reaches their target
3. **Force Fill**: Remaining shifts are filled by whoever legally can work
   them (fewest assigned hours first) and flagged in the validation log
4. **Final Statistics**: Each mentor's assigned-vs-target hours are logged,
   with a warning marker when more than 5 hours off target

## Mentor Settings

- **Hours Wanted**: weekly target; monthly target = weekly x (days in
  month / 7)
- **Weekdays Unavailable**: recurring weekly days off - enforced by the
  scheduler directly, independent of the calendar
- **Preferred Weekday**: the weekday the mentor wants every week
- **Requested Days Off**: specific dates picked on the employee calendar for
  a specific month
- **Show on calendar**: unchecked mentors do not appear in the employee
  calendar dropdowns. This affects display only
- **Include in scheduling**: unchecked mentors are skipped by schedule
  generation. Independent of "Show on calendar"
- **Prefill unavailable weekdays**: when checked, "Clear Current Month &
  Auto-Fill" writes this mentor's recurring days off onto the employee
  calendar so employees can see the day is taken. Purely a visibility aid -
  the scheduler enforces those weekdays either way

## Pay Periods

- Pay periods are 14 days, counted from January 1 of each year
- They do NOT align with calendar months
- The 80-hour limit is enforced per actual pay period, including across a
  month boundary

## Saved Schedules

### Generate Schedule Tab

- Saved schedules are listed below the generation form, newest first
- Click any schedule card to load it into the View Schedule tab

### View Schedule Tab

- Click "Save Schedule" to persist the current schedule (one per month;
  saving overwrites that month's existing schedule)
- Click any mentor name on the calendar to reassign that shift; edits are
  in-memory until saved, and unsaved edits prompt a warning before they would
  be lost

### Database Structure

- **Collection**: `savedSchedules`
- **Document ID**: `{CAMPUS_ID}_{month}_{year}` (e.g. "St. George_1_2026")
- **Fields**:
  - `campusId`, `name` fields as before, plus `year`, `month`, `generatedAt`
  - `schedule.mentors`: `{ name, hoursWantedPerWeek, unavailableDates,
    unavailableWeekdays, preferredWeekday }`
  - `schedule.assignedDays`: `{ dateInfo (ISO string), shifts,
    mentorsOnShift: { shiftName: { name } | null } }`
  - `schedule.holidays`: `{ shift_info, dates }`
  - `validationMessages`: generation log
- Older documents that stored `m1`/`m2`/`pay1`/`pay2` still load; the extra
  fields are ignored and the next save writes the new shape

## Future Enhancements

- Delete button for individual saved schedules
- Export schedules to PDF or Excel
- Duplicate schedule to another month
- Schedule comparison view
- Firestore security rules and real authentication
