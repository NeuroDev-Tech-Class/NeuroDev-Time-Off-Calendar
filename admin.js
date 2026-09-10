import { attemptLogin, logout, isAdmin } from "./auth.js";
import { db, doc, setDoc, getDoc, collection, getDocs, query, where, createBackup } from "./firebase.js";
import { CAMPUS_ID } from "./config.js";
import { Schedule } from "./scheduler.js";
import { showToast } from "./ui.js";
import {
  MONTH_NAMES,
  monthKey,
  isMonthKeyed,
  getMonthSlice,
  migrateFlatTimeOff,
  expandWeekdaysToDates,
  parseHolidayDates,
  weeksInMonth,
  planAutoFill,
} from "./dates.js";

// Compute national holidays for a given year and return an object mapping
// month (1-12) -> comma-separated day numbers.
function computeNationalHolidays(year) {
  function getNthWeekdayOfMonth(y, m, weekday, n) {
    const first = new Date(y, m - 1, 1);
    const firstWeekday = first.getDay();
    return 1 + ((7 + weekday - firstWeekday) % 7) + (n - 1) * 7;
  }

  function getLastWeekdayOfMonth(y, m, weekday) {
    const last = new Date(y, m, 0);
    const lastWeekday = last.getDay();
    return last.getDate() - ((7 + lastWeekday - weekday) % 7);
  }

  const janMLK = getNthWeekdayOfMonth(year, 1, 1, 3); // 3rd Monday
  const febPres = getNthWeekdayOfMonth(year, 2, 1, 3); // 3rd Monday
  const mayMemorial = getLastWeekdayOfMonth(year, 5, 1); // last Monday
  const sepLabor = getNthWeekdayOfMonth(year, 9, 1, 1); // first Monday
  const novThanks = getNthWeekdayOfMonth(year, 11, 4, 4); // 4th Thursday

  return {
    1: `1,${janMLK}`,
    2: `${febPres}`,
    3: "",
    4: "",
    5: `${mayMemorial}`,
    6: "19",
    7: "4,24",
    8: "",
    9: `${sepLabor}`,
    10: "",
    11: `${novThanks}`,
    12: "24,25,31",
  };
}

const COPY_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
const CHECK_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;

const SEASONAL_SHIFT_INFO = {
  summer: {
    shift_info: {
      Sunday: { a_shift: 10, b_shift: 10 },
      Monday: { a_shift: 8, b_shift: 8, c_shift: 5 },
      Tuesday: { a_shift: 7, b_shift: 7, c_shift: 4 },
      Wednesday: { a_shift: 7, b_shift: 7 },
      Thursday: { a_shift: 7, b_shift: 7, c_shift: 4.0 },
      Friday: { a_shift: 8, b_shift: 8, c_shift: 4 },
      Saturday: { a_shift: 11, b_shift: 11, c_shift: 4 },
    },
  },
  winter: {
    shift_info: {
      Sunday: { a_shift: 9, b_shift: 9 },
      Monday: { a_shift: 7, b_shift: 7, c_shift: 5 },
      Tuesday: { a_shift: 6, b_shift: 6, c_shift: 4 },
      Wednesday: { a_shift: 6, b_shift: 6 },
      Thursday: { a_shift: 6, b_shift: 6, c_shift: 4 },
      Friday: { a_shift: 8, b_shift: 8, c_shift: 4 },
      Saturday: { a_shift: 11, b_shift: 11, c_shift: 4 },
    },
  },
};

let mentorInfoData = {};
let timeOffAll = {}; // Month-keyed: { "2026-01": { "5": ["Sofia", "", ""] } }
let autoFilledAll = {}; // Same shape, but only the names auto-fill placed
let currentSchedule = null;
let scheduleDirty = false;
let calendarYear = 2026;
let calendarMonth = 0; // 0-indexed
let slotsAvailable = 3;

function calendarMonthKey() {
  return monthKey(calendarYear, calendarMonth + 1);
}

window.addEventListener("DOMContentLoaded", async () => {
  if (isAdmin()) {
    showAdminContent();
    await loadData();
  } else {
    showLoginModal();
  }

  document
    .querySelectorAll("#weekdays-unavailable input")
    .forEach((cb) => cb.addEventListener("change", updateRecurringDisplay));
});

window.addEventListener("beforeunload", (e) => {
  if (scheduleDirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});

function showLoginModal() {
  document.getElementById("login-modal").style.display = "flex";
  document.getElementById("admin-password").addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      handleLogin();
    }
  });
}

function showAdminContent() {
  document.getElementById("login-modal").style.display = "none";
  document.getElementById("admin-content").style.display = "block";
}

window.handleLogin = function () {
  const password = document.getElementById("admin-password").value;
  if (attemptLogin(password)) {
    showAdminContent();
    loadData();
  } else {
    document.getElementById("login-error").textContent = "Incorrect password";
  }
};

window.handleLogout = logout;

async function loadData() {
  try {
    // Calendar config first: the timeOff migration needs to know the current month
    const configDoc = await getDoc(doc(db, "calendarConfig", CAMPUS_ID));
    if (configDoc.exists()) {
      const config = configDoc.data();
      slotsAvailable = config?.slotsAvailable || 3;
      calendarMonth = config?.targetMonth !== undefined ? config.targetMonth : 0;
      calendarYear = config?.targetYear || 2026;
    } else {
      slotsAvailable = 3;
      calendarMonth = 0;
      calendarYear = 2026;
    }
    document.getElementById("slots-available").value = slotsAvailable;

    document.getElementById("calendar-month").value = calendarMonth;
    document.getElementById("calendar-year").value = calendarYear;
    document.getElementById("schedule-year").value = calendarYear;
    document.getElementById("schedule-month").value = calendarMonth + 1;

    const mentorDoc = await getDoc(doc(db, "mentorInfo", CAMPUS_ID));
    if (mentorDoc.exists()) {
      mentorInfoData = mentorDoc.data().mentors || {};
    } else {
      mentorInfoData = {};
      await setDoc(doc(db, "mentorInfo", CAMPUS_ID), { mentors: mentorInfoData });
    }

    const timeOffDoc = await getDoc(doc(db, "timeOff", CAMPUS_ID));
    if (timeOffDoc.exists()) {
      timeOffAll = timeOffDoc.data().mentors || {};
      autoFilledAll = timeOffDoc.data().autoFilled || {};
      // One-time migration: legacy docs were keyed by bare day-of-month
      if (!isMonthKeyed(timeOffAll)) {
        timeOffAll = migrateFlatTimeOff(timeOffAll, calendarMonthKey());
        await saveTimeOffDoc();
        showToast("Time-off data migrated to month-based storage");
      }
    }

    populateMentorSelect();
    updateHolidays();
    await loadSavedSchedulesList();
  } catch (error) {
    console.error("Error loading data:", error);
    showToast("Error loading data");
  }
}

async function loadSavedSchedulesList() {
  try {
    const schedulesQuery = query(
      collection(db, "savedSchedules"),
      where("campusId", "==", CAMPUS_ID)
    );

    const snapshot = await getDocs(schedulesQuery);
    const schedules = [];

    snapshot.forEach((doc) => {
      const data = doc.data();
      schedules.push({ id: doc.id, month: data.month, year: data.year });
    });

    schedules.sort((a, b) => {
      if (b.year !== a.year) return b.year - a.year;
      return b.month - a.month;
    });

    displaySavedSchedulesList(schedules);

    if (!currentSchedule && schedules.length > 0) {
      await loadScheduleById(schedules[0].id, true);
    }
  } catch (error) {
    console.error("Error loading saved schedules:", error);
  }
}

function displaySavedSchedulesList(schedules) {
  const container = document.getElementById("saved-schedules-list");
  if (!container) return;

  if (schedules.length === 0) {
    container.innerHTML =
      '<p class="no-schedules">No saved schedules yet. Generate a schedule and save it to see it here.</p>';
    return;
  }

  container.innerHTML = schedules
    .map(
      (schedule) => `
    <div class="saved-schedule-item" onclick="loadScheduleById('${schedule.id}')">
      <div class="schedule-name">${MONTH_NAMES[schedule.month - 1]}</div>
      <div class="schedule-date">${schedule.year}</div>
    </div>
  `
    )
    .join("");
}

window.loadScheduleById = async function (scheduleId, silent = false) {
  if (scheduleDirty && !silent) {
    if (!confirm("You have unsaved schedule edits that will be lost. Load anyway?")) {
      return;
    }
  }

  try {
    const scheduleDoc = await getDoc(doc(db, "savedSchedules", scheduleId));

    if (!scheduleDoc.exists()) {
      if (!silent) showToast("Schedule not found");
      return;
    }

    const savedData = scheduleDoc.data();
    const schedule = savedData.schedule;

    schedule.assignedDays = (schedule.assignedDays || []).map((d) => ({
      ...d,
      dateInfo: new Date(d.dateInfo),
    }));
    // Older saved docs used m1/m2 instead of mentors
    schedule.mentors = schedule.mentors || schedule.m1 || [];

    currentSchedule = {
      id: scheduleId,
      year: savedData.year,
      month: savedData.month,
      schedule: schedule,
      validationMessages: savedData.validationMessages || [],
    };
    scheduleDirty = false;

    if (!silent) {
      showTab("view-schedule");
      showToast("Schedule loaded successfully");
    }

    displaySchedule();
  } catch (error) {
    console.error("Error loading schedule:", error);
    if (!silent) showToast("Error loading schedule");
  }
};

window.showTab = function (tabName) {
  document.querySelectorAll(".tab-content").forEach((tab) => {
    tab.classList.toggle("active", tab.id === tabName);
  });
  document.querySelectorAll(".tab-button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tabName);
  });
};

// Mentor Management Functions
function populateMentorSelect() {
  const select = document.getElementById("mentor-select");
  select.innerHTML = '<option value="new">+ Add New Mentor</option>';

  for (const name of Object.keys(mentorInfoData).sort((a, b) => a.localeCompare(b))) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    select.appendChild(option);
  }
}

// Both fields go in every write: setDoc replaces the whole document
async function saveTimeOffDoc() {
  await setDoc(doc(db, "timeOff", CAMPUS_ID), {
    mentors: timeOffAll,
    autoFilled: autoFilledAll,
  });
}

function getMentorPrefilledDates(mentorName, key) {
  const monthData = getMonthSlice(autoFilledAll, key);
  const dates = [];

  for (const [day, names] of Object.entries(monthData)) {
    if (Array.isArray(names) && names.includes(mentorName)) {
      dates.push(parseInt(day));
    }
  }

  return dates;
}

function getMentorRequestedDates(mentorName, key) {
  const monthData = getMonthSlice(timeOffAll, key);
  const dates = [];

  for (const [day, requests] of Object.entries(monthData)) {
    if (requests && Array.isArray(requests) && requests.includes(mentorName)) {
      dates.push(parseInt(day));
    }
  }

  return dates.sort((a, b) => a - b);
}

function updateRequestedDatesDisplay(mentorName) {
  const display = document.getElementById("hard-dates-display");
  const label = `${MONTH_NAMES[calendarMonth]} ${calendarYear}`;

  if (!mentorName) {
    display.textContent = `No dates requested for ${label}`;
    return;
  }

  const dates = getMentorRequestedDates(mentorName, calendarMonthKey());
  if (dates.length === 0) {
    display.textContent = `No dates requested for ${label}`;
    return;
  }

  const prefilled = getMentorPrefilledDates(mentorName, calendarMonthKey());
  display.textContent = `${label}: ${dates
    .map((d) => (prefilled.includes(d) ? `${d} (prefilled)` : `${d}`))
    .join(", ")}`;
}

function updateRecurringDisplay() {
  const display = document.getElementById("recurring-dates-display");
  if (!display) return;

  const checked = Array.from(
    document.querySelectorAll("#weekdays-unavailable input:checked")
  ).map((cb) => cb.value);

  if (checked.length === 0) {
    display.textContent = "None";
    return;
  }

  const label = `${MONTH_NAMES[calendarMonth]} ${calendarYear}`;
  display.innerHTML = checked
    .map((weekday) => {
      const dates = expandWeekdaysToDates(calendarYear, calendarMonth + 1, [weekday]);
      return `<div>Every ${weekday} (${label}: ${dates.join(", ")})</div>`;
    })
    .join("");
}

window.loadMentorInfo = function () {
  const select = document.getElementById("mentor-select");
  const mentorName = select.value;

  if (mentorName === "new") {
    document.getElementById("mentor-name").value = "";
    document.getElementById("hours-wanted").value = "";
    document.getElementById("preferred-weekday").value = "";
    document.getElementById("show-on-calendar").checked = true;
    document.getElementById("include-in-scheduling").checked = true;
    document.getElementById("auto-fill-calendar").checked = false;
    updateRequestedDatesDisplay(null);

    document
      .querySelectorAll("#weekdays-unavailable input")
      .forEach((cb) => (cb.checked = false));

    document.getElementById("delete-btn").disabled = true;
  } else {
    const mentor = mentorInfoData[mentorName];
    document.getElementById("mentor-name").value = mentorName;
    document.getElementById("hours-wanted").value = mentor.hours_wanted || 0;

    updateRequestedDatesDisplay(mentorName);

    document.getElementById("preferred-weekday").value =
      mentor.preferred_weekdays && mentor.preferred_weekdays.length > 0
        ? mentor.preferred_weekdays[0]
        : "";

    document.getElementById("show-on-calendar").checked =
      mentor.show_on_calendar !== undefined ? mentor.show_on_calendar : true;
    document.getElementById("include-in-scheduling").checked =
      mentor.include_in_scheduling !== false;
    document.getElementById("auto-fill-calendar").checked =
      mentor.auto_fill_calendar === true;

    document.querySelectorAll("#weekdays-unavailable input").forEach((cb) => {
      cb.checked = Boolean(mentor.weekdays && mentor.weekdays.includes(cb.value));
    });

    document.getElementById("delete-btn").disabled = false;
  }

  updateRecurringDisplay();
};

window.saveMentorInfo = async function () {
  const name = document.getElementById("mentor-name").value.trim();
  if (!name) {
    showToast("Name field cannot be empty");
    return;
  }

  const hoursWanted = parseInt(document.getElementById("hours-wanted").value) || 0;
  const preferredWeekday = document.getElementById("preferred-weekday").value;
  const showOnCalendar = document.getElementById("show-on-calendar").checked;
  const includeInScheduling = document.getElementById("include-in-scheduling").checked;
  const autoFillCalendar = document.getElementById("auto-fill-calendar").checked;

  const weekdays = Array.from(
    document.querySelectorAll("#weekdays-unavailable input:checked")
  ).map((cb) => cb.value);

  mentorInfoData[name] = {
    weekdays: weekdays,
    preferred_weekdays: preferredWeekday ? [preferredWeekday] : [],
    hard_dates: getMentorRequestedDates(name, calendarMonthKey()),
    hours_wanted: hoursWanted,
    show_on_calendar: showOnCalendar,
    include_in_scheduling: includeInScheduling,
    auto_fill_calendar: autoFillCalendar,
  };

  try {
    await setDoc(doc(db, "mentorInfo", CAMPUS_ID), { mentors: mentorInfoData });
    showToast("Mentor information saved successfully");
    populateMentorSelect();
    document.getElementById("mentor-select").value = name;
    updateRequestedDatesDisplay(name);
    updateRecurringDisplay();
  } catch (error) {
    console.error("Error saving mentor info:", error);
    showToast("Error saving mentor information");
  }
};

window.deleteMentor = async function () {
  const select = document.getElementById("mentor-select");
  const mentorName = select.value;

  if (mentorName === "new") {
    showToast("No mentor selected to delete");
    return;
  }

  if (!confirm(`Are you sure you want to delete ${mentorName}? This cannot be undone.`)) {
    return;
  }

  delete mentorInfoData[mentorName];

  try {
    await setDoc(doc(db, "mentorInfo", CAMPUS_ID), { mentors: mentorInfoData });
    showToast(`${mentorName} has been deleted successfully`);
    populateMentorSelect();
    document.getElementById("mentor-select").value = "new";
    loadMentorInfo();
  } catch (error) {
    console.error("Error deleting mentor:", error);
    showToast("Error deleting mentor");
  }
};

// Schedule Generation Functions
window.updateHolidays = function () {
  const month = parseInt(document.getElementById("schedule-month").value);
  const year =
    parseInt(document.getElementById("schedule-year").value) || new Date().getFullYear();
  const holidaysMap = computeNationalHolidays(year);
  document.getElementById("holidays").value = holidaysMap[month] || "";
};

window.generateSchedule = async function () {
  const year = parseInt(document.getElementById("schedule-year").value);
  const month = parseInt(document.getElementById("schedule-month").value);

  if (!year || year < 2020 || year > 2100) {
    showToast("Please enter a valid year");
    return;
  }

  if (!month || month < 1 || month > 12) {
    showToast("Please select a valid month");
    return;
  }

  if (scheduleDirty) {
    if (!confirm("You have unsaved schedule edits that will be lost. Generate anyway?")) {
      return;
    }
  }

  const daysInMonth = new Date(year, month, 0).getDate();
  const holidayDates = parseHolidayDates(
    document.getElementById("holidays").value,
    daysInMonth
  );
  const noMentorDays = parseHolidayDates(
    document.getElementById("no-mentor-days").value,
    daysInMonth
  );

  // Requested days off come from the calendar slice for the month being generated
  const scheduleKey = monthKey(year, month);
  for (const [name, info] of Object.entries(mentorInfoData)) {
    info.hard_dates = getMentorRequestedDates(name, scheduleKey);
  }

  const statusDiv = document.getElementById("generation-status");
  statusDiv.textContent = "Generating schedule...";
  statusDiv.className = "status-message info";

  try {
    const holidays = {
      shift_info: {
        holiday_a_shift: 9,
        holiday_b_shift: 9,
      },
      dates: holidayDates,
    };

    const schedule = new Schedule(
      year,
      month,
      SEASONAL_SHIFT_INFO,
      mentorInfoData,
      holidays,
      noMentorDays
    );

    currentSchedule = {
      year: year,
      month: month,
      schedule: schedule,
      validationMessages: schedule.validationMessages || [],
    };
    scheduleDirty = false;

    statusDiv.textContent = "Schedule generated successfully!";
    statusDiv.className = "status-message success";

    showTab("view-schedule");
    displaySchedule();

    showToast("Schedule generated! Click 'Save Schedule' to save it.");
  } catch (error) {
    console.error("Error generating schedule:", error);
    statusDiv.textContent = `Error: ${error.message}`;
    statusDiv.className = "status-message error";
    showToast("Error generating schedule");
  }
};

// Display Schedule
function displaySchedule() {
  if (!currentSchedule) {
    document.getElementById("schedule-display").innerHTML =
      "<p>No schedule generated yet. Go to 'Generate Schedule' tab to create one.</p>";
    return;
  }

  const { year, month, schedule } = currentSchedule;

  document.getElementById("schedule-info").innerHTML = `
    <h2>${MONTH_NAMES[month - 1]} ${year}</h2>
  `;

  const container = document.getElementById("schedule-display");
  container.innerHTML = "";

  const validationDiv = document.getElementById("validation-messages");
  const validationSummary = document.getElementById("validation-summary");

  if (validationDiv && validationSummary) {
    if (currentSchedule.validationMessages && currentSchedule.validationMessages.length > 0) {
      validationDiv.innerHTML = currentSchedule.validationMessages
        .map((msg) => {
          const escapedMsg = msg.replace(/</g, "&lt;").replace(/>/g, "&gt;");
          if (msg.startsWith("✓")) {
            return `<div class="validation-success">${escapedMsg}</div>`;
          } else if (msg.startsWith("⚠") || msg.startsWith("Found") || msg.includes("WARNING")) {
            return `<div class="validation-warning">${escapedMsg}</div>`;
          } else if (msg.startsWith("  ")) {
            return `<div class="validation-detail">${escapedMsg}</div>`;
          } else if (msg.trim() === "") {
            return '<div style="height: 0.5rem;"></div>';
          } else {
            return `<div class="validation-info">${escapedMsg}</div>`;
          }
        })
        .join("");
      validationSummary.style.display = "block";
    } else {
      validationDiv.innerHTML =
        '<div class="validation-info">Validation information not available for this schedule. Generate a new schedule to see validation details.</div>';
      validationSummary.style.display = "block";
    }
  }

  const table = document.createElement("div");
  table.className = "schedule-table";

  const headerRow = document.createElement("div");
  headerRow.className = "schedule-header-row";

  const daysOfWeek = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const shiftTimesByDay = {
    Sunday: "A&B 1:00-10:00",
    Monday: "A&B 3:00-10:00\nC 3:00-8:00",
    Tuesday: "A&B 3:45-10:00\nC 3:45-8:00",
    Wednesday: "A&B 3:45-10:00",
    Thursday: "A&B 3:45-10:00\nC 3:45-8:00",
    Friday: "A&B 3:45-12:00\nC 3:45-8:00",
    Saturday: "A&B 1:00-12:00\nC 1:00-5:00",
  };

  daysOfWeek.forEach((day) => {
    const header = document.createElement("div");
    header.className = "schedule-header";

    const dayName = document.createElement("div");
    dayName.className = "header-day-name";
    dayName.textContent = day;
    header.appendChild(dayName);

    const times = document.createElement("div");
    times.className = "header-shift-times";
    times.textContent = shiftTimesByDay[day];
    header.appendChild(times);

    headerRow.appendChild(header);
  });
  table.appendChild(headerRow);

  const firstDay = new Date(year, month - 1, 1).getDay();
  const daysInMonth = new Date(year, month, 0).getDate();

  // Week membership is tracked per row so each row's copy button can rebuild
  // that week (including adjacent-month days) for the screenshot
  const prevMonthYear = month === 1 ? year - 1 : year;
  const prevMonthNum = month === 1 ? 12 : month - 1;
  const nextMonthYear = month === 12 ? year + 1 : year;
  const nextMonthNum = month === 12 ? 1 : month + 1;
  const prevMonthTotalDays = new Date(prevMonthYear, prevMonthNum, 0).getDate();
  let currentWeekDays = [];

  function appendWeekToTable(row, weekDays) {
    const weekData = { weekDays: [...weekDays] };
    const copyBtn = document.createElement("button");
    copyBtn.className = "copy-week-btn";
    copyBtn.type = "button";
    copyBtn.title = "Copy week as image";
    copyBtn.setAttribute("aria-label", "Copy week as image");
    copyBtn.innerHTML = COPY_ICON_SVG;
    copyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      captureWeekImage(weekData, copyBtn);
    });
    row.appendChild(copyBtn);
    table.appendChild(row);
  }

  let currentRow = document.createElement("div");
  currentRow.className = "schedule-row";

  for (let i = 0; i < firstDay; i++) {
    const prevDay = prevMonthTotalDays - firstDay + i + 1;
    currentWeekDays.push({ day: prevDay, month: prevMonthNum, year: prevMonthYear, isOtherMonth: true });
    const emptyCell = document.createElement("div");
    emptyCell.className = "schedule-cell empty";
    currentRow.appendChild(emptyCell);
  }

  const noMentorDays = schedule.noMentorDays || [];

  for (let day = 1; day <= daysInMonth; day++) {
    const assignedDay = schedule.assignedDays.find((d) => d.dateInfo.getDate() === day);

    const cell = document.createElement("div");
    cell.className = "schedule-cell";

    const isNoMentorDay = noMentorDays.includes(day);
    if (isNoMentorDay) {
      cell.classList.add("no-mentor-day");
    }

    const isHoliday =
      !isNoMentorDay &&
      schedule.holidays && schedule.holidays.dates && schedule.holidays.dates.includes(day);
    if (isHoliday) {
      cell.classList.add("holiday");
    }

    const dateLabel = document.createElement("div");
    dateLabel.className = "schedule-date";
    dateLabel.textContent = day;
    cell.appendChild(dateLabel);

    if (isNoMentorDay) {
      const noMentorLabel = document.createElement("div");
      noMentorLabel.className = "no-mentor-label";
      noMentorLabel.textContent = "No Scheduling";
      cell.appendChild(noMentorLabel);
    } else if (assignedDay) {
      const shiftsDiv = document.createElement("div");
      shiftsDiv.className = "schedule-shifts";

      const shiftOrder = ["a_shift", "b_shift", "c_shift", "holiday_a_shift", "holiday_b_shift"];
      const sortedShifts = Object.entries(assignedDay.mentorsOnShift).sort((a, b) => {
        const indexA = shiftOrder.indexOf(a[0]);
        const indexB = shiftOrder.indexOf(b[0]);
        return (indexA === -1 ? 999 : indexA) - (indexB === -1 ? 999 : indexB);
      });

      for (const [shift, mentor] of sortedShifts) {
        const shiftDiv = document.createElement("div");
        shiftDiv.className = "schedule-shift";
        const shiftLabel = shift.replace("_shift", "").replace("holiday_", "").toUpperCase();

        const mentorSpan = document.createElement("span");
        mentorSpan.className = "editable-mentor";
        mentorSpan.style.cursor = "pointer";
        mentorSpan.style.textDecoration = "underline";

        if (mentor) {
          mentorSpan.textContent = mentor.name;
          mentorSpan.onclick = () => showMentorDropdown(mentorSpan, day, shift, mentor.name);
        } else {
          mentorSpan.textContent = "(Empty)";
          mentorSpan.style.color = "#999";
          mentorSpan.style.fontStyle = "italic";
          mentorSpan.onclick = () => showMentorDropdown(mentorSpan, day, shift, null);
        }

        shiftDiv.textContent = `${shiftLabel} - `;
        shiftDiv.appendChild(mentorSpan);
        shiftsDiv.appendChild(shiftDiv);
      }
      cell.appendChild(shiftsDiv);
    }

    currentWeekDays.push({ day, month, year, isOtherMonth: false });
    currentRow.appendChild(cell);

    if ((firstDay + day) % 7 === 0) {
      appendWeekToTable(currentRow, currentWeekDays);
      currentRow = document.createElement("div");
      currentRow.className = "schedule-row";
      currentWeekDays = [];
    }
  }

  if (currentRow.children.length > 0) {
    let nextDay = 1;
    while (currentRow.children.length < 7) {
      currentWeekDays.push({ day: nextDay, month: nextMonthNum, year: nextMonthYear, isOtherMonth: true });
      const emptyCell = document.createElement("div");
      emptyCell.className = "schedule-cell empty";
      currentRow.appendChild(emptyCell);
      nextDay++;
    }
    appendWeekToTable(currentRow, currentWeekDays);
  }

  container.appendChild(table);

  const legend = document.createElement("div");
  legend.className = "schedule-legend";
  legend.innerHTML = `
    <p><strong>A shift</strong> = dinner | <strong>B shift</strong> = meds | <strong>C shift</strong> = errands</p>
  `;
  container.appendChild(legend);

  updateHoursSummary();
}

// Load a saved schedule for an adjacent month (used by week screenshots)
async function loadScheduleForMonth(year, month) {
  try {
    const docSnap = await getDoc(doc(db, "savedSchedules", `${CAMPUS_ID}_${month}_${year}`));
    if (docSnap.exists()) {
      const schedule = docSnap.data().schedule;
      schedule.mentors = schedule.mentors || schedule.m1 || [];
      return schedule;
    }
  } catch (error) {
    console.error("Failed to load adjacent month schedule:", error);
  }
  return null;
}

// Build a static (non-interactive) schedule cell for the week screenshot
function buildStaticDayCell(day, scheduleData, isOtherMonth) {
  const cell = document.createElement("div");
  cell.className = "schedule-cell" + (isOtherMonth && !scheduleData ? " empty" : "");

  if (isOtherMonth) {
    cell.style.opacity = "0.65";
    if (!scheduleData) return cell;
  }

  const dateLabel = document.createElement("div");
  dateLabel.className = "schedule-date";
  dateLabel.textContent = day;
  cell.appendChild(dateLabel);

  if (!scheduleData || !scheduleData.assignedDays) return cell;

  if ((scheduleData.noMentorDays || []).includes(day)) {
    cell.classList.add("no-mentor-day");
    const noMentorLabel = document.createElement("div");
    noMentorLabel.className = "no-mentor-label";
    noMentorLabel.textContent = "No Scheduling";
    cell.appendChild(noMentorLabel);
    return cell;
  }

  const assignedDay = scheduleData.assignedDays.find((d) => {
    const dateInfo = d.dateInfo || d.date;
    const dayNum =
      typeof dateInfo?.getDate === "function" ? dateInfo.getDate() : new Date(dateInfo).getDate();
    return dayNum === day;
  });

  if (scheduleData.holidays?.dates?.includes(day)) {
    cell.classList.add("holiday");
  }

  if (assignedDay) {
    const shiftsDiv = document.createElement("div");
    shiftsDiv.className = "schedule-shifts";

    const shiftOrder = ["a_shift", "b_shift", "c_shift", "holiday_a_shift", "holiday_b_shift"];
    const sortedShifts = Object.entries(assignedDay.mentorsOnShift || {}).sort((a, b) => {
      const indexA = shiftOrder.indexOf(a[0]);
      const indexB = shiftOrder.indexOf(b[0]);
      return (indexA === -1 ? 999 : indexA) - (indexB === -1 ? 999 : indexB);
    });

    for (const [shift, mentor] of sortedShifts) {
      const shiftDiv = document.createElement("div");
      shiftDiv.className = "schedule-shift";
      const shiftLabel = shift.replace("_shift", "").replace("holiday_", "").toUpperCase();
      if (mentor) {
        shiftDiv.textContent = `${shiftLabel} - ${mentor.name}`;
      } else {
        shiftDiv.textContent = `${shiftLabel} - (Empty)`;
        shiftDiv.style.color = "#999";
        shiftDiv.style.fontStyle = "italic";
      }
      shiftsDiv.appendChild(shiftDiv);
    }
    cell.appendChild(shiftsDiv);
  }

  return cell;
}

// Build the off-screen DOM element used for screenshot capture
function buildWeekScreenshot(weekInfo, prevScheduleData, nextScheduleData) {
  const { year, month } = currentSchedule;

  const container = document.createElement("div");
  container.style.cssText =
    "position:fixed;left:-9999px;top:0;z-index:-1;background:#fff;font-family:sans-serif;";

  const title = document.createElement("div");
  title.style.cssText =
    "text-align:center;font-weight:bold;font-size:15px;padding:8px 12px;background:#495057;color:white;";
  title.textContent = `${MONTH_NAMES[month - 1]} ${year}`;
  container.appendChild(title);

  const table = document.createElement("div");
  table.className = "schedule-table";
  table.style.margin = "0";
  table.style.borderRadius = "0";
  table.style.borderTop = "none";

  // Clone the on-page header row so shift times match exactly
  const origHeader = document.querySelector(".schedule-table .schedule-header-row");
  if (origHeader) {
    table.appendChild(origHeader.cloneNode(true));
  }

  const weekRow = document.createElement("div");
  weekRow.className = "schedule-row";
  weekRow.style.borderBottom = "none";

  weekInfo.weekDays.forEach((dayInfo) => {
    let cell;
    if (dayInfo.isOtherMonth) {
      const isPrevMonth =
        dayInfo.year < year || (dayInfo.year === year && dayInfo.month < month);
      const adjSchedule = isPrevMonth ? prevScheduleData : nextScheduleData;
      cell = buildStaticDayCell(dayInfo.day, adjSchedule, true);
    } else {
      cell = buildStaticDayCell(dayInfo.day, currentSchedule.schedule, false);
    }
    weekRow.appendChild(cell);
  });

  table.appendChild(weekRow);
  container.appendChild(table);
  return container;
}

// Capture a single week as an image and write to clipboard (fallback: download)
async function captureWeekImage(weekInfo, btn) {
  if (!window.html2canvas) {
    showToast("Screenshot library not loaded. Please refresh the page.");
    return;
  }

  if (btn) {
    btn.classList.add("copying");
    btn.innerHTML = CHECK_ICON_SVG;
  }

  try {
    const { month, year } = currentSchedule;

    let prevScheduleData = null;
    let nextScheduleData = null;

    const hasPrevMonth = weekInfo.weekDays.some(
      (d) => d.isOtherMonth && (d.year < year || (d.year === year && d.month < month))
    );
    const hasNextMonth = weekInfo.weekDays.some(
      (d) => d.isOtherMonth && (d.year > year || (d.year === year && d.month > month))
    );

    if (hasPrevMonth) {
      const pYear = month === 1 ? year - 1 : year;
      const pMonth = month === 1 ? 12 : month - 1;
      prevScheduleData = await loadScheduleForMonth(pYear, pMonth);
    }
    if (hasNextMonth) {
      const nYear = month === 12 ? year + 1 : year;
      const nMonth = month === 12 ? 1 : month + 1;
      nextScheduleData = await loadScheduleForMonth(nYear, nMonth);
    }

    const screenshotEl = buildWeekScreenshot(weekInfo, prevScheduleData, nextScheduleData);
    screenshotEl.style.width = "1200px";
    document.body.appendChild(screenshotEl);

    let canvas;
    try {
      canvas = await window.html2canvas(screenshotEl, {
        scale: 2,
        useCORS: true,
        logging: false,
        backgroundColor: "#ffffff",
      });
    } finally {
      screenshotEl.remove();
    }

    let copied = false;
    if (navigator.clipboard?.write && window.ClipboardItem) {
      try {
        await new Promise((resolve, reject) => {
          canvas.toBlob(async (blob) => {
            try {
              if (!blob) {
                reject(new Error("Canvas toBlob returned null"));
                return;
              }
              await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
              copied = true;
              resolve();
            } catch (e) {
              reject(e);
            }
          }, "image/png");
        });
      } catch (error) {
        console.warn("Clipboard write failed, downloading instead:", error);
      }
    }

    if (copied) {
      showToast("Week copied to clipboard!");
    } else {
      const link = document.createElement("a");
      link.download = `schedule-${MONTH_NAMES[month - 1]}-${year}-week.png`;
      link.href = canvas.toDataURL("image/png");
      link.click();
      showToast("Downloaded week as image");
    }
  } catch (error) {
    console.error("Failed to capture week image:", error);
    showToast("Failed to capture image. Please try again.");
  } finally {
    if (btn) {
      btn.classList.remove("copying");
      btn.innerHTML = COPY_ICON_SVG;
    }
  }
}

// Recalculate the hours summary from current calendar assignments
function updateHoursSummary() {
  const summaryContainer = document.getElementById("hours-summary");
  if (!summaryContainer || !currentSchedule || !currentSchedule.schedule) return;

  const schedule = currentSchedule.schedule;
  const mentorData = {};

  // The schedule's mentor snapshot first: its days off are accurate for the
  // schedule's month, while mentorInfoData reflects the current calendar month
  for (const mentor of schedule.mentors || []) {
    mentorData[mentor.name] = {
      totalHours: 0,
      hoursWantedPerWeek: mentor.hoursWantedPerWeek || mentor.hoursWanted || 0,
      daysOff: [...(mentor.unavailableDates || mentor.hardDates || [])],
    };
  }

  for (const [name, info] of Object.entries(mentorInfoData)) {
    if (info.include_in_scheduling === false) continue;
    if (!mentorData[name]) {
      mentorData[name] = {
        totalHours: 0,
        hoursWantedPerWeek: info.hours_wanted || 0,
        daysOff: [...(info.hard_dates || [])],
      };
    }
  }

  for (const day of schedule.assignedDays || []) {
    for (const [shift, mentor] of Object.entries(day.mentorsOnShift || {})) {
      if (mentor && mentor.name) {
        if (!mentorData[mentor.name]) {
          mentorData[mentor.name] = {
            totalHours: 0,
            hoursWantedPerWeek: mentorInfoData[mentor.name]?.hours_wanted || 0,
            daysOff: [],
          };
        }
        mentorData[mentor.name].totalHours += day.shifts[shift] || 0;
      }
    }
  }

  const numWeeks = weeksInMonth(currentSchedule.year, currentSchedule.month);

  let summaryHTML =
    '<div class="schedule-summary"><h4>Hours Summary</h4><table><tr><th>Mentor</th><th>Total Hours</th><th>Weekly Target</th><th>Monthly Target</th><th>Difference</th><th>Days Off</th></tr>';

  for (const name of Object.keys(mentorData).sort()) {
    const data = mentorData[name];
    const monthlyTarget = (data.hoursWantedPerWeek * numWeeks).toFixed(1);
    const diff = data.totalHours - parseFloat(monthlyTarget);
    const diffStr = diff >= 0 ? `+${diff.toFixed(1)}` : diff.toFixed(1);
    const diffClass = Math.abs(diff) > 5 ? 'style="color: orange; font-weight: bold;"' : "";

    summaryHTML += `
      <tr>
        <td>${name}</td>
        <td>${data.totalHours.toFixed(1)}</td>
        <td>${data.hoursWantedPerWeek}</td>
        <td>${monthlyTarget}</td>
        <td ${diffClass}>${diffStr}</td>
        <td>${data.daysOff.sort((a, b) => a - b).join(", ") || "None"}</td>
      </tr>
    `;
  }

  summaryHTML += "</table></div>";
  summaryContainer.innerHTML = summaryHTML;
}

// Dropdown for editing mentor assignments on the schedule
function showMentorDropdown(span, day, shift, currentName) {
  const select = document.createElement("select");
  select.style.fontSize = "inherit";
  select.style.fontFamily = "inherit";

  const emptyOption = document.createElement("option");
  emptyOption.value = "";
  emptyOption.textContent = "(Empty)";
  if (!currentName) {
    emptyOption.selected = true;
  }
  select.appendChild(emptyOption);

  Object.keys(mentorInfoData)
    .sort((a, b) => a.localeCompare(b))
    .forEach((name) => {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    if (name === currentName) {
      option.selected = true;
    }
    select.appendChild(option);
  });

  // Removing a focused select re-fires blur mid-removal; guard against reentry
  let restored = false;
  const restoreSpan = () => {
    if (restored) return;
    restored = true;
    select.onblur = null;
    span.style.display = "inline";
    select.remove();
  };

  select.onchange = () => {
    const newName = select.value || null;
    // Restore the span before the async update so blur can't strand a hidden span
    restoreSpan();

    if (newName) {
      span.textContent = newName;
      span.style.color = "";
      span.style.fontStyle = "";
    } else {
      span.textContent = "(Empty)";
      span.style.color = "#999";
      span.style.fontStyle = "italic";
    }
    span.onclick = () => showMentorDropdown(span, day, shift, newName);

    updateScheduleMentor(day, shift, newName);
  };

  select.onblur = restoreSpan;

  span.style.display = "none";
  span.parentNode.insertBefore(select, span.nextSibling);
  select.focus();
}

function updateScheduleMentor(day, shift, newName) {
  if (!currentSchedule || !currentSchedule.schedule) return;

  const assignedDay = currentSchedule.schedule.assignedDays.find(
    (d) => d.dateInfo.getDate() === day
  );
  if (assignedDay && assignedDay.mentorsOnShift) {
    assignedDay.mentorsOnShift[shift] = newName ? { name: newName } : null;
  }

  scheduleDirty = true;
  showToast("Schedule updated (unsaved)");
  updateHoursSummary();
}

// Save current schedule to database
window.saveCurrentSchedule = async function () {
  if (!currentSchedule || !currentSchedule.schedule) {
    showToast("No schedule to save");
    return;
  }

  const saveBtn = document.getElementById("save-schedule-btn");
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving...";
  }

  try {
    const schedule = currentSchedule.schedule;
    const docId = `${CAMPUS_ID}_${currentSchedule.month}_${currentSchedule.year}`;

    const serializable = {
      campusId: CAMPUS_ID,
      year: currentSchedule.year,
      month: currentSchedule.month,
      generatedAt: new Date().toISOString(),
      schedule: {
        mentors: (schedule.mentors || []).map((m) => ({
          name: m.name,
          hoursWantedPerWeek: m.hoursWantedPerWeek || m.hoursWanted || 0,
          unavailableDates: m.unavailableDates || m.hardDates || [],
          unavailableWeekdays: m.unavailableWeekdays || [],
          preferredWeekday: m.preferredWeekday || null,
        })),
        assignedDays: (schedule.assignedDays || []).map((d) => ({
          dateInfo:
            typeof d.dateInfo === "string" ? d.dateInfo : d.dateInfo.toISOString(),
          shifts: d.shifts,
          mentorsOnShift: Object.fromEntries(
            Object.entries(d.mentorsOnShift || {}).map(([shift, mentor]) => [
              shift,
              mentor ? { name: mentor.name } : null,
            ])
          ),
        })),
        holidays: schedule.holidays || { shift_info: {}, dates: [] },
        noMentorDays: schedule.noMentorDays || [],
      },
      validationMessages: currentSchedule.validationMessages || [],
    };

    await setDoc(doc(db, "savedSchedules", docId), serializable);

    currentSchedule.id = docId;
    scheduleDirty = false;

    await loadSavedSchedulesList();

    showToast(`Schedule saved: ${MONTH_NAMES[currentSchedule.month - 1]} ${currentSchedule.year}`);
  } catch (error) {
    console.error("Error saving schedule:", error);
    showToast("Error saving schedule");
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save Schedule";
    }
  }
};

// Calendar Management Functions
window.updateCalendarDate = async function () {
  const month = parseInt(document.getElementById("calendar-month").value);
  const year = parseInt(document.getElementById("calendar-year").value);

  if (isNaN(year) || year < 2020 || year > 2100) {
    showToast("Please enter a valid year between 2020 and 2100");
    return;
  }

  try {
    const configDoc = await getDoc(doc(db, "calendarConfig", CAMPUS_ID));
    const existingConfig = configDoc.exists() ? configDoc.data() : {};

    await setDoc(doc(db, "calendarConfig", CAMPUS_ID), {
      ...existingConfig,
      targetMonth: month,
      targetYear: year,
    });

    calendarMonth = month;
    calendarYear = year;

    document.getElementById("schedule-year").value = year;
    document.getElementById("schedule-month").value = month + 1;
    updateHolidays();

    // Refresh month-dependent displays in the mentor form
    const selected = document.getElementById("mentor-select").value;
    updateRequestedDatesDisplay(selected === "new" ? null : selected);
    updateRecurringDisplay();

    showToast(
      "Calendar date updated successfully. Refresh the main calendar page to see changes."
    );
  } catch (error) {
    console.error("Error updating calendar date:", error);
    showToast("Error updating calendar date");
  }
};

window.updateSlots = async function () {
  const slots = parseInt(document.getElementById("slots-available").value);
  if (isNaN(slots) || slots < 1 || slots > 10) {
    showToast("Please enter a valid number between 1 and 10");
    return;
  }

  try {
    const configDoc = await getDoc(doc(db, "calendarConfig", CAMPUS_ID));
    const existingConfig = configDoc.exists() ? configDoc.data() : {};

    await setDoc(doc(db, "calendarConfig", CAMPUS_ID), {
      ...existingConfig,
      slotsAvailable: slots,
    });
    slotsAvailable = slots;
    showToast("Slots updated successfully. Refresh the main calendar page to see changes.");
  } catch (error) {
    console.error("Error updating slots:", error);
    showToast("Error updating slots");
  }
};

window.clearCalendar = async function () {
  const label = `${MONTH_NAMES[calendarMonth]} ${calendarYear}`;
  if (
    !confirm(
      `Are you sure you want to clear all time-off entries for ${label} and prefill the unavailable weekdays of mentors with prefill enabled? Other months are not affected.`
    )
  ) {
    return;
  }

  const statusDiv = document.getElementById("calendar-status");
  statusDiv.textContent = "Clearing calendar...";
  statusDiv.className = "status-message info";
  statusDiv.style.display = "block";

  try {
    await createBackup(timeOffAll, "manual-clear");

    const key = calendarMonthKey();
    const { monthData, placed, skipped } = planAutoFill({
      mentors: mentorInfoData,
      year: calendarYear,
      month: calendarMonth + 1,
      slotsAvailable,
      monthData: {},
    });

    timeOffAll[key] = monthData;
    autoFilledAll[key] = placed;
    await saveTimeOffDoc();

    const filledDays = Object.keys(placed).length;
    let message = `Time-off entries for ${label} cleared.`;
    message +=
      filledDays > 0
        ? ` Prefilled ${filledDays} day${filledDays === 1 ? "" : "s"}.`
        : " No mentors have prefill enabled.";
    if (skipped.length > 0) {
      message += ` No free slot on: ${skipped.join(", ")}.`;
    }

    statusDiv.textContent = message;
    statusDiv.className = "status-message success";

    const selected = document.getElementById("mentor-select").value;
    updateRequestedDatesDisplay(selected === "new" ? null : selected);

    setTimeout(() => {
      statusDiv.style.display = "none";
    }, 6000);
  } catch (error) {
    console.error("Error clearing calendar:", error);
    statusDiv.textContent = `Error: ${error.message}`;
    statusDiv.className = "status-message error";
  }
};
