export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const MONTH_KEY_PATTERN = /^\d{4}-\d{2}$/;

export function monthKey(year, month) {
  return `${year}-${String(month).padStart(2, "0")}`;
}

export function isMonthKeyed(data) {
  return Object.keys(data).every((key) => MONTH_KEY_PATTERN.test(key));
}

export function getMonthSlice(data, key) {
  if (isMonthKeyed(data)) return data[key] || {};
  return data;
}

export function migrateFlatTimeOff(data, key) {
  if (isMonthKeyed(data)) return data;
  return { [key]: data };
}

export function expandWeekdaysToDates(year, month, weekdays) {
  if (!weekdays || weekdays.length === 0) return [];
  const targetDays = weekdays.map((name) => WEEKDAY_NAMES.indexOf(name));
  const daysInMonth = new Date(year, month, 0).getDate();
  const dates = [];
  for (let day = 1; day <= daysInMonth; day++) {
    if (targetDays.includes(new Date(year, month - 1, day).getDay())) {
      dates.push(day);
    }
  }
  return dates;
}

export function normalizeSlots(slots, slotsAvailable) {
  const result = Array.from(slots || [], (v) => v || "");
  while (result.length < slotsAvailable) result.push("");
  return result;
}

export function planAutoFill({ mentors, year, month, slotsAvailable, monthData }) {
  const result = {};
  for (const [day, slots] of Object.entries(monthData || {})) {
    result[day] = Array.from(slots || [], (v) => v || "");
  }

  const placed = {};
  const skipped = new Set();

  const enabled = Object.keys(mentors || {})
    .filter((name) => mentors[name].auto_fill_calendar === true)
    .sort((a, b) => a.localeCompare(b));

  for (const name of enabled) {
    for (const day of expandWeekdaysToDates(year, month, mentors[name].weekdays)) {
      const slots = normalizeSlots(result[day], slotsAvailable);
      result[day] = slots;

      if (slots.includes(name)) continue;

      const free = slots.indexOf("");
      if (free === -1) {
        skipped.add(day);
        continue;
      }

      slots[free] = name;
      placed[day] = [...(placed[day] || []), name];
    }
  }

  return {
    monthData: result,
    placed,
    skipped: Array.from(skipped).sort((a, b) => a - b),
  };
}

export function parseHolidayDates(holidayStr, daysInMonth) {
  if (!holidayStr.trim()) return [];

  const dates = new Set();
  for (const part of holidayStr.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    if (trimmed.includes("-")) {
      const [start, end] = trimmed.split("-").map((s) => parseInt(s.trim()));
      if (!isNaN(start) && !isNaN(end) && start <= end) {
        for (let i = start; i <= end; i++) dates.add(i);
      }
    } else {
      const num = parseInt(trimmed);
      if (!isNaN(num)) dates.add(num);
    }
  }

  return Array.from(dates)
    .filter((d) => d >= 1 && d <= daysInMonth)
    .sort((a, b) => a - b);
}

export function weeksInMonth(year, month) {
  return new Date(year, month, 0).getDate() / 7;
}
