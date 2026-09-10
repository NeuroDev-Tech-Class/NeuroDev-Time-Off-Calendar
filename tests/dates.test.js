import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MONTH_NAMES,
  monthKey,
  isMonthKeyed,
  getMonthSlice,
  migrateFlatTimeOff,
  expandWeekdaysToDates,
  normalizeSlots,
  parseHolidayDates,
  weeksInMonth,
  planAutoFill,
} from "../dates.js";

test("monthKey formats 1-based month with zero padding", () => {
  assert.equal(monthKey(2026, 1), "2026-01");
  assert.equal(monthKey(2026, 12), "2026-12");
});

test("MONTH_NAMES has 12 entries starting with January", () => {
  assert.equal(MONTH_NAMES.length, 12);
  assert.equal(MONTH_NAMES[0], "January");
  assert.equal(MONTH_NAMES[11], "December");
});

test("isMonthKeyed detects new vs legacy flat shape", () => {
  assert.equal(isMonthKeyed({ "2026-01": { 5: ["Sofia"] } }), true);
  assert.equal(isMonthKeyed({ 5: ["Sofia"], 12: ["Emma"] }), false);
  assert.equal(isMonthKeyed({}), true);
});

test("getMonthSlice returns the month's data from keyed shape", () => {
  const data = { "2026-01": { 5: ["Sofia"] }, "2026-02": { 3: ["Emma"] } };
  assert.deepEqual(getMonthSlice(data, "2026-01"), { 5: ["Sofia"] });
  assert.deepEqual(getMonthSlice(data, "2026-03"), {});
});

test("getMonthSlice treats legacy flat data as the requested month", () => {
  const flat = { 5: ["Sofia", "", ""] };
  assert.deepEqual(getMonthSlice(flat, "2026-01"), flat);
});

test("migrateFlatTimeOff wraps flat data under the given month key", () => {
  const flat = { 5: ["Sofia", "", ""] };
  assert.deepEqual(migrateFlatTimeOff(flat, "2026-01"), {
    "2026-01": { 5: ["Sofia", "", ""] },
  });
});

test("migrateFlatTimeOff leaves keyed data untouched", () => {
  const keyed = { "2026-01": { 5: ["Sofia"] } };
  assert.deepEqual(migrateFlatTimeOff(keyed, "2026-02"), keyed);
});

test("expandWeekdaysToDates finds all matching days in a month", () => {
  assert.deepEqual(expandWeekdaysToDates(2026, 8, ["Wednesday"]), [5, 12, 19, 26]);
  assert.deepEqual(expandWeekdaysToDates(2026, 1, ["Sunday"]), [4, 11, 18, 25]);
  assert.deepEqual(expandWeekdaysToDates(2026, 1, []), []);
});

test("expandWeekdaysToDates merges multiple weekdays sorted", () => {
  const result = expandWeekdaysToDates(2026, 8, ["Wednesday", "Saturday"]);
  assert.deepEqual(result, [1, 5, 8, 12, 15, 19, 22, 26, 29]);
});

test("normalizeSlots pads to slot count and clears holes", () => {
  assert.deepEqual(normalizeSlots(["Sofia"], 3), ["Sofia", "", ""]);
  assert.deepEqual(normalizeSlots(["Sofia", undefined, "Emma"], 3), ["Sofia", "", "Emma"]);
  assert.deepEqual(normalizeSlots(undefined, 3), ["", "", ""]);
  assert.deepEqual(normalizeSlots(["A", "B", "C", "D"], 3), ["A", "B", "C", "D"]);
});

test("parseHolidayDates parses lists and ranges within the month", () => {
  assert.deepEqual(parseHolidayDates("24,25,31", 31), [24, 25, 31]);
  assert.deepEqual(parseHolidayDates("3-5", 31), [3, 4, 5]);
  assert.deepEqual(parseHolidayDates("", 31), []);
});

test("parseHolidayDates rejects days outside the month", () => {
  assert.deepEqual(parseHolidayDates("0,35,-5", 31), []);
  assert.deepEqual(parseHolidayDates("30-35", 31), [30, 31]);
  assert.deepEqual(parseHolidayDates("29,30", 28), []);
});

test("weeksInMonth is days/7", () => {
  assert.equal(weeksInMonth(2026, 2), 4);
  assert.ok(Math.abs(weeksInMonth(2026, 1) - 31 / 7) < 1e-9);
});

// Wednesdays in August 2026 are the 5th, 12th, 19th and 26th
const AUG = { year: 2026, month: 8 };

test("planAutoFill places an enabled mentor on each matching weekday", () => {
  const result = planAutoFill({
    mentors: { Emma: { auto_fill_calendar: true, weekdays: ["Wednesday"] } },
    ...AUG,
    slotsAvailable: 3,
    monthData: {},
  });

  for (const day of [5, 12, 19, 26]) {
    assert.deepEqual(result.monthData[day], ["Emma", "", ""]);
  }
  assert.equal(result.monthData[6], undefined);
  assert.deepEqual(result.placed, {
    5: ["Emma"],
    12: ["Emma"],
    19: ["Emma"],
    26: ["Emma"],
  });
  assert.deepEqual(result.skipped, []);
});

test("planAutoFill ignores mentors without the flag or without weekdays", () => {
  const result = planAutoFill({
    mentors: {
      OptedOut: { auto_fill_calendar: false, weekdays: ["Wednesday"] },
      NoFlag: { weekdays: ["Wednesday"] },
      NoWeekdays: { auto_fill_calendar: true, weekdays: [] },
    },
    ...AUG,
    slotsAvailable: 3,
    monthData: {},
  });

  assert.deepEqual(result.monthData, {});
  assert.deepEqual(result.placed, {});
  assert.deepEqual(result.skipped, []);
});

test("planAutoFill uses the first empty slot and pads short days", () => {
  const result = planAutoFill({
    mentors: { Emma: { auto_fill_calendar: true, weekdays: ["Wednesday"] } },
    ...AUG,
    slotsAvailable: 3,
    monthData: { 5: ["Sofia", "", ""], 12: ["Sofia"] },
  });

  assert.deepEqual(result.monthData[5], ["Sofia", "Emma", ""]);
  assert.deepEqual(result.monthData[12], ["Sofia", "Emma", ""]);
});

test("planAutoFill skips days with no free slot and reports them", () => {
  const result = planAutoFill({
    mentors: { Emma: { auto_fill_calendar: true, weekdays: ["Wednesday"] } },
    ...AUG,
    slotsAvailable: 2,
    monthData: { 5: ["Sofia", "Aidri"] },
  });

  assert.deepEqual(result.monthData[5], ["Sofia", "Aidri"]);
  assert.deepEqual(result.skipped, [5]);
  assert.equal(result.placed[5], undefined);
  assert.deepEqual(result.placed[12], ["Emma"]);
});

test("planAutoFill never duplicates a name already on the day", () => {
  const result = planAutoFill({
    mentors: { Emma: { auto_fill_calendar: true, weekdays: ["Wednesday"] } },
    ...AUG,
    slotsAvailable: 3,
    monthData: { 5: ["Emma", "", ""] },
  });

  assert.deepEqual(result.monthData[5], ["Emma", "", ""]);
  assert.equal(result.placed[5], undefined);
  assert.deepEqual(result.skipped, []);
});

test("planAutoFill fills multiple mentors in alphabetical order", () => {
  const result = planAutoFill({
    mentors: {
      Zoe: { auto_fill_calendar: true, weekdays: ["Wednesday"] },
      Aidri: { auto_fill_calendar: true, weekdays: ["Wednesday"] },
    },
    ...AUG,
    slotsAvailable: 3,
    monthData: {},
  });

  assert.deepEqual(result.monthData[5], ["Aidri", "Zoe", ""]);
  assert.deepEqual(result.placed[5], ["Aidri", "Zoe"]);
});

test("planAutoFill does not mutate the month data it is given", () => {
  const monthData = { 5: ["Sofia", "", ""] };
  planAutoFill({
    mentors: { Emma: { auto_fill_calendar: true, weekdays: ["Wednesday"] } },
    ...AUG,
    slotsAvailable: 3,
    monthData,
  });

  assert.deepEqual(monthData, { 5: ["Sofia", "", ""] });
});
