import { attemptLogin, checkAdminAuth, logout, isAdmin } from "./auth.js";
import { db, doc, setDoc, getDoc, onSnapshot, collection, getDocs, query, where } from "./firebase.js";
import { CAMPUS_ID } from "./config.js";
import { Schedule } from "./scheduler.js";
import { showToast } from "./ui.js";

// Configuration data
// Compute national holidays for a given year and return an object mapping
// month (1-12) -> comma-separated day numbers (same format as before).
function computeNationalHolidays(year) {
  // Helpers to compute nth weekday (weekday: 0=Sun..6=Sat)
  function getNthWeekdayOfMonth(y, m, weekday, n) {
    // m is 1-based month
    const first = new Date(y, m - 1, 1);
    const firstWeekday = first.getDay();
    let day = 1 + ((7 + weekday - firstWeekday) % 7) + (n - 1) * 7;
    return day;
  }

  function getLastWeekdayOfMonth(y, m, weekday) {
    const last = new Date(y, m, 0); // last day of month
    const lastWeekday = last.getDay();
    let day = last.getDate() - ((7 + lastWeekday - weekday) % 7);
    return day;
  }

  const janMLK = getNthWeekdayOfMonth(year, 1, 1, 3); // 3rd Monday
  const febPres = getNthWeekdayOfMonth(year, 2, 1, 3); // 3rd Monday
  const mayMemorial = getLastWeekdayOfMonth(year, 5, 1); // last Monday
  const sepLabor = getNthWeekdayOfMonth(year, 9, 1, 1); // first Monday
  const novThanks = getNthWeekdayOfMonth(year, 11, 4, 4); // 4th Thursday (weekday 4)

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

const SEASONAL_SHIFT_INFO = {
  summer: {
    dates: {
      start: "2024-05-01 00:00:00",
      end: "2024-07-31 00:00:00",
    },
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
    dates: {
      start: "2024-08-01 00:00:00",
      end: "2025-04-30 00:00:00",
    },
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
let timeOffData = {};
let currentSchedule = null;

// Initialize on load
window.addEventListener("DOMContentLoaded", async () => {
  if (isAdmin()) {
    showAdminContent();
    await loadData();
  } else {
    showLoginModal();
  }
});

function showLoginModal() {
  document.getElementById("login-modal").style.display = "flex";
  document
    .getElementById("admin-password")
    .addEventListener("keypress", (e) => {
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

// Load data from Firebase
async function loadData() {
  try {
    // Load mentor info
    const mentorDoc = await getDoc(doc(db, "mentorInfo", CAMPUS_ID));
    if (mentorDoc.exists()) {
      mentorInfoData = mentorDoc.data().mentors || {};
    } else {
      // Initialize with empty data
      mentorInfoData = {};
      await setDoc(doc(db, "mentorInfo", CAMPUS_ID), {
        mentors: mentorInfoData,
      });
    }

    // Load time-off data
    const timeOffDoc = await getDoc(doc(db, "timeOff", CAMPUS_ID));
    if (timeOffDoc.exists()) {
      timeOffData = timeOffDoc.data().mentors || {};
    }

    populateMentorSelect();

    // Load calendar config
    const configDoc = await getDoc(doc(db, "calendarConfig", CAMPUS_ID));
    if (configDoc.exists()) {
      const config = configDoc.data();
      document.getElementById("slots-available").value =
        config?.slotsAvailable || 3;

      const calendarMonth =
        config?.targetMonth !== undefined ? config.targetMonth : 0;
      const calendarYear = config?.targetYear || 2026;

      // Set calendar management fields
      document.getElementById("calendar-month").value = calendarMonth;
      document.getElementById("calendar-year").value = calendarYear;

      // Default schedule generation to calendar month/year
      document.getElementById("schedule-year").value = calendarYear;
      document.getElementById("schedule-month").value = calendarMonth + 1; // Display months are 1-indexed
    } else {
      document.getElementById("slots-available").value = 3;
      document.getElementById("calendar-month").value = 0;
      document.getElementById("calendar-year").value = 2026;
      document.getElementById("schedule-year").value = 2026;
      document.getElementById("schedule-month").value = 1;
    }

    updateHolidays();

    // Load list of all saved schedules
    await loadSavedSchedulesList();
  } catch (error) {
    console.error("Error loading data:", error);
    showToast("Error loading data");
  }
}

// Load list of all saved schedules
async function loadSavedSchedulesList() {
  try {
    const schedulesQuery = query(
      collection(db, 'savedSchedules'),
      where('campusId', '==', CAMPUS_ID)
    );
    
    const snapshot = await getDocs(schedulesQuery);
    const schedules = [];
    
    snapshot.forEach(doc => {
      const data = doc.data();
      schedules.push({
        id: doc.id,
        month: data.month,
        year: data.year,
        generatedAt: data.generatedAt
      });
    });
    
    // Sort by year and month (newest first)
    schedules.sort((a, b) => {
      if (b.year !== a.year) return b.year - a.year;
      return b.month - a.month;
    });
    
    displaySavedSchedulesList(schedules);
    
    // Auto-load most recent schedule if no schedule is currently loaded
    if (!currentSchedule && schedules.length > 0) {
      await loadScheduleById(schedules[0].id, true);
    }
  } catch (error) {
    console.error('Error loading saved schedules:', error);
  }
}

// Display saved schedules list
function displaySavedSchedulesList(schedules) {
  const container = document.getElementById('saved-schedules-list');
  if (!container) return;
  
  if (schedules.length === 0) {
    container.innerHTML = '<p class=\"no-schedules\">No saved schedules yet. Generate a schedule and save it to see it here.</p>';
    return;
  }
  
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  
  const list = schedules.map(schedule => `
    <div class=\"saved-schedule-item\" onclick=\"loadScheduleById('${schedule.id}')\">
      <div class=\"schedule-name\">${monthNames[schedule.month - 1]}</div>
      <div class=\"schedule-date\">${schedule.year}</div>
    </div>
  `).join('');
  
  container.innerHTML = list;
}

// Load a specific schedule by ID
window.loadScheduleById = async function(scheduleId, silent = false) {
  try {
    const scheduleDoc = await getDoc(doc(db, 'savedSchedules', scheduleId));
    
    if (!scheduleDoc.exists()) {
      if (!silent) showToast('Schedule not found');
      return;
    }
    
    const savedData = scheduleDoc.data();
    const schedule = savedData.schedule;
    
    // Reconstruct dates from ISO strings
    if (schedule.pay1) {
      schedule.pay1 = schedule.pay1.map(d => ({
        ...d,
        dateInfo: new Date(d.dateInfo)
      }));
    }
    if (schedule.pay2) {
      schedule.pay2 = schedule.pay2.map(d => ({
        ...d,
        dateInfo: new Date(d.dateInfo)
      }));
    }
    if (schedule.assignedDays) {
      schedule.assignedDays = schedule.assignedDays.map(d => ({
        ...d,
        dateInfo: new Date(d.dateInfo)
      }));
    }
    
    currentSchedule = {
      id: scheduleId,
      year: savedData.year,
      month: savedData.month,
      schedule: schedule,
      validationMessages: savedData.validationMessages || []
    };
    
    // Only switch tabs and show toast if not silent
    if (!silent) {
      showTab('view-schedule');
      showToast('Schedule loaded successfully');
    }
    
    // Always display the schedule
    displaySchedule();
  } catch (error) {
    console.error('Error loading schedule:', error);
    if (!silent) showToast('Error loading schedule');
  }
};

// Tab switching
window.showTab = function (tabName, event) {
  const tabs = document.querySelectorAll(".tab-content");
  tabs.forEach((tab) => (tab.style.display = "none"));

  const buttons = document.querySelectorAll(".tab-button");
  buttons.forEach((btn) => btn.classList.remove("active"));

  document.getElementById(tabName).style.display = "block";
  
  // If called from button click, update active button
  if (event && event.target) {
    event.target.classList.add("active");
  } else {
    // If called programmatically, find and activate the corresponding button
    buttons.forEach((btn) => {
      if (btn.getAttribute('onclick')?.includes(tabName)) {
        btn.classList.add("active");
      }
    });
  }
};

// Mentor Management Functions
function populateMentorSelect() {
  const select = document.getElementById("mentor-select");
  select.innerHTML = '<option value="new">+ Add New Mentor</option>';

  for (const name of Object.keys(mentorInfoData)) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    select.appendChild(option);
  }
}

window.loadMentorInfo = function () {
  const select = document.getElementById("mentor-select");
  const mentorName = select.value;

  if (mentorName === "new") {
    // Clear form for new mentor
    document.getElementById("mentor-name").value = "";
    document.getElementById("hours-wanted").value = "";
    document.getElementById("hard-dates-display").textContent =
      "No dates selected";
    document.getElementById("preferred-weekday").value = "";
    document.getElementById("auto-fill-calendar").checked = false;

    const checkboxes = document.querySelectorAll("#weekdays-unavailable input");
    checkboxes.forEach((cb) => (cb.checked = false));

    document.getElementById("delete-btn").disabled = true;
  } else {
    const mentor = mentorInfoData[mentorName];
    document.getElementById("mentor-name").value = mentorName;
    document.getElementById("hours-wanted").value = mentor.hours_wanted || 0;

    // Display hard dates from time-off calendar
    const mentorTimeOffDates = getMentorTimeOffDates(mentorName);
    document.getElementById("hard-dates-display").textContent =
      mentorTimeOffDates.length > 0
        ? mentorTimeOffDates.join(", ")
        : "No dates selected";

    document.getElementById("preferred-weekday").value =
      mentor.preferred_weekdays && mentor.preferred_weekdays.length > 0
        ? mentor.preferred_weekdays[0]
        : "";

    document.getElementById("auto-fill-calendar").checked =
      mentor.auto_fill_calendar || false;

    document.getElementById("show-on-calendar").checked =
      mentor.show_on_calendar !== undefined ? mentor.show_on_calendar : true;

    const checkboxes = document.querySelectorAll("#weekdays-unavailable input");
    checkboxes.forEach((cb) => {
      cb.checked = mentor.weekdays && mentor.weekdays.includes(cb.value);
    });

    document.getElementById("delete-btn").disabled = false;
  }
};

function getMentorTimeOffDates(mentorName) {
  const dates = [];
  
  // Get dates from calendar
  for (const [day, requests] of Object.entries(timeOffData)) {
    if (requests && Array.isArray(requests) && requests.includes(mentorName)) {
      dates.push(parseInt(day));
    }
  }
  
  // Also add dates based on unavailable weekdays from mentor profile
  const mentor = mentorInfoData[mentorName];
  if (mentor && mentor.weekdays && mentor.weekdays.length > 0) {
    // Get the year and month from the schedule generation form
    const year = parseInt(document.getElementById("schedule-year").value) || 2026;
    const month = parseInt(document.getElementById("schedule-month").value) || 1;
    
    const weekdayMap = {
      "Sunday": 0,
      "Monday": 1,
      "Tuesday": 2,
      "Wednesday": 3,
      "Thursday": 4,
      "Friday": 5,
      "Saturday": 6
    };
    
    // Find all dates in the month that match the unavailable weekdays
    const daysInMonth = new Date(year, month, 0).getDate();
    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(year, month - 1, day);
      const dayOfWeek = date.getDay();
      
      for (const weekday of mentor.weekdays) {
        if (weekdayMap[weekday] === dayOfWeek) {
          if (!dates.includes(day)) {
            dates.push(day);
          }
          break;
        }
      }
    }
  }
  
  dates.sort((a, b) => a - b);
  return dates;
}

window.saveMentorInfo = async function () {
  const name = document.getElementById("mentor-name").value.trim();
  if (!name) {
    showToast("Name field cannot be empty");
    return;
  }

  const hoursWanted =
    parseInt(document.getElementById("hours-wanted").value) || 0;
  const preferredWeekday = document.getElementById("preferred-weekday").value;
  const autoFillCalendar =
    document.getElementById("auto-fill-calendar").checked;
  const showOnCalendar =
    document.getElementById("show-on-calendar").checked;

  const weekdays = [];
  const checkboxes = document.querySelectorAll(
    "#weekdays-unavailable input:checked"
  );
  checkboxes.forEach((cb) => weekdays.push(cb.value));

  // Get hard dates from time-off calendar
  const hardDates = getMentorTimeOffDates(name);

  mentorInfoData[name] = {
    weekdays: weekdays,
    preferred_weekdays: preferredWeekday ? [preferredWeekday] : [],
    weekday_behavior: ["Re"],
    hard_dates: hardDates,
    hours_wanted: hoursWanted,
    soft_dates: [],
    auto_fill_calendar: autoFillCalendar,
    show_on_calendar: showOnCalendar,
  };

  try {
    await setDoc(doc(db, "mentorInfo", CAMPUS_ID), { mentors: mentorInfoData });
    showToast("Mentor information saved successfully");
    populateMentorSelect();
    document.getElementById("mentor-select").value = name;
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

  if (
    !confirm(
      `Are you sure you want to delete ${mentorName}? This cannot be undone.`
    )
  ) {
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
  const year = parseInt(document.getElementById("schedule-year").value) || new Date().getFullYear();
  const holidaysMap = computeNationalHolidays(year);
  const holidays = holidaysMap[month] || "";
  document.getElementById("holidays").value = holidays;
};

window.generateSchedule = async function () {
  const year = parseInt(document.getElementById("schedule-year").value);
  const month = parseInt(document.getElementById("schedule-month").value);
  const holidayDates = parseHolidayDates(
    document.getElementById("holidays").value
  );

  if (!year || year < 2020 || year > 2100) {
    showToast("Please enter a valid year");
    return;
  }

  if (!month || month < 1 || month > 12) {
    showToast("Please select a valid month");
    return;
  }

  // Update mentor hard_dates with time-off data
  for (const [name, info] of Object.entries(mentorInfoData)) {
    info.hard_dates = getMentorTimeOffDates(name);
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
      15, // Pay period length
      SEASONAL_SHIFT_INFO,
      mentorInfoData,
      holidays
    );

    currentSchedule = {
      year: year,
      month: month,
      schedule: schedule,
      validationMessages: schedule.validationMessages || []
    };

    // Helper function to serialize mentorsOnShift object
    const serializeMentorsOnShift = (mentorsOnShift) => {
      const serialized = {};
      for (const [shift, mentor] of Object.entries(mentorsOnShift || {})) {
        if (mentor && typeof mentor === 'object' && mentor.name) {
          // It's a Mentor object
          serialized[shift] = {
            name: mentor.name,
            hoursWantedPerWeek: mentor.hoursWantedPerWeek || mentor.hoursWanted || 0,
            hoursWanted: mentor.hoursWanted || mentor.hoursWantedPerWeek || 0,
            hardDates: mentor.hardDates || mentor.unavailableDates || [],
            unavailableDates: mentor.unavailableDates || mentor.hardDates || [],
            unavailableWeekdays: mentor.unavailableWeekdays || [],
            softDates: mentor.softDates || [],
            hoursPay: mentor.hoursPay || mentor.hoursAssigned || 0,
            hoursAssigned: mentor.hoursAssigned || mentor.hoursPay || 0,
            daysLeft: mentor.daysLeft || 0,
            preferredWeekdays: mentor.preferredWeekdays || [],
            preferredWeekday: mentor.preferredWeekday || null
          };
        } else {
          // It's null or already serialized
          serialized[shift] = mentor;
        }
      }
      return serialized;
    };

    // Helper function to serialize a mentor
    const serializeMentor = (m) => ({
      name: m.name,
      hoursWantedPerWeek: m.hoursWantedPerWeek || m.hoursWanted || 0,
      hoursWanted: m.hoursWanted || m.hoursWantedPerWeek || 0,
      hardDates: m.hardDates || m.unavailableDates || [],
      unavailableDates: m.unavailableDates || m.hardDates || [],
      unavailableWeekdays: m.unavailableWeekdays || [],
      softDates: m.softDates || [],
      hoursPay: m.hoursPay || m.hoursAssigned || 0,
      hoursAssigned: m.hoursAssigned || m.hoursPay || 0,
      daysLeft: m.daysLeft || 0,
      preferredWeekdays: m.preferredWeekdays || [],
      preferredWeekday: m.preferredWeekday || null
    });

    // Save schedule to Firebase for persistence (serialize the schedule object)
    const serializableSchedule = {
      year: year,
      month: month,
      schedule: {
        m1: schedule.m1.map(serializeMentor),
        m2: schedule.m2.map(serializeMentor),
        lenP1: schedule.lenP1 || 15,
        numWeeksInMonth: schedule.numWeeksInMonth,
        pay1: schedule.pay1.map(d => ({
          dateInfo: (d.dateInfo || d.date).toISOString(),
          weekday: d.weekday,
          season: d.season,
          shifts: d.shifts,
          mentorsOnShift: serializeMentorsOnShift(d.mentorsOnShift || d.assignments),
          totalHours: d.totalHours,
          assignedHours: d.assignedHours
        })),
        pay2: schedule.pay2.map(d => ({
          dateInfo: (d.dateInfo || d.date).toISOString(),
          weekday: d.weekday,
          season: d.season,
          shifts: d.shifts,
          mentorsOnShift: serializeMentorsOnShift(d.mentorsOnShift || d.assignments),
          totalHours: d.totalHours,
          assignedHours: d.assignedHours
        })),
        assignedDays: schedule.assignedDays.map(d => ({
          dateInfo: (d.dateInfo || d.date).toISOString(),
          weekday: d.weekday,
          season: d.season,
          shifts: d.shifts,
          mentorsOnShift: serializeMentorsOnShift(d.mentorsOnShift || d.assignments),
          totalHours: d.totalHours,
          assignedHours: d.assignedHours
        })),
        holidays: schedule.holidays || { shift_info: {}, dates: [] }
      },
      validationMessages: schedule.validationMessages || []
    };
    
    statusDiv.textContent = "Schedule generated successfully!";
    statusDiv.className = "status-message success";

    // Auto-switch to View Schedule tab
    showTab('view-schedule');
    
    // Display the schedule
    displaySchedule();
    
    showToast("Schedule generated! Click 'Save Schedule' to save it.");
  } catch (error) {
    console.error("Error generating schedule:", error);
    statusDiv.textContent = `Error: ${error.message}`;
    statusDiv.className = "status-message error";
    showToast("Error generating schedule");
  }
};

function parseHolidayDates(holidayStr) {
  if (!holidayStr.trim()) return [];

  const dates = new Set();
  const parts = holidayStr.split(",");

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    if (trimmed.includes("-")) {
      const [start, end] = trimmed.split("-").map((s) => parseInt(s.trim()));
      if (!isNaN(start) && !isNaN(end) && start <= end) {
        for (let i = start; i <= end; i++) {
          dates.add(i);
        }
      }
    } else {
      const num = parseInt(trimmed);
      if (!isNaN(num)) {
        dates.add(num);
      }
    }
  }

  return Array.from(dates).sort((a, b) => a - b);
}

// Display Schedule
function displaySchedule() {
  if (!currentSchedule) {
    document.getElementById("schedule-display").innerHTML =
      "<p>No schedule generated yet. Go to 'Generate Schedule' tab to create one.</p>";
    return;
  }

  const { year, month, schedule } = currentSchedule;
  const monthNames = [
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

  document.getElementById("schedule-info").innerHTML = `
    <h2>${monthNames[month - 1]} ${year}</h2>
  `;

  const container = document.getElementById("schedule-display");
  container.innerHTML = "";
  
  // Always show validation summary section when schedule exists
  const validationDiv = document.getElementById('validation-messages');
  const validationSummary = document.getElementById('validation-summary');
  
  if (validationDiv && validationSummary) {
    if (currentSchedule.validationMessages && currentSchedule.validationMessages.length > 0) {
      const messages = currentSchedule.validationMessages.map(msg => {
        // Format different types of messages
        const escapedMsg = msg.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        if (msg.startsWith('✓')) {
          return `<div class="validation-success">${escapedMsg}</div>`;
        } else if (msg.startsWith('⚠') || msg.startsWith('Found') || msg.includes('WARNING')) {
          return `<div class="validation-warning">${escapedMsg}</div>`;
        } else if (msg.startsWith('  ')) {
          return `<div class="validation-detail">${escapedMsg}</div>`;
        } else if (msg.trim() === '') {
          return '<div style="height: 0.5rem;"></div>';
        } else {
          return `<div class="validation-info">${escapedMsg}</div>`;
        }
      }).join('');
      validationDiv.innerHTML = messages;
      validationSummary.style.display = 'block';
    } else {
      // Show a message indicating validation info is not available
      validationDiv.innerHTML = '<div class="validation-info">Validation information not available for this schedule. Generate a new schedule to see validation details.</div>';
      validationSummary.style.display = 'block';
    }
  }

  // Create calendar-style display
  const table = document.createElement("div");
  table.className = "schedule-table";

  // Header row with days of week and shift times
  const headerRow = document.createElement("div");
  headerRow.className = "schedule-header-row";

  const daysOfWeek = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];
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

  // Get first day of month and total days
  const firstDay = new Date(year, month - 1, 1).getDay();
  const daysInMonth = new Date(year, month, 0).getDate();

  // Create calendar grid
  let currentRow = document.createElement("div");
  currentRow.className = "schedule-row";

  // Empty cells before first day
  for (let i = 0; i < firstDay; i++) {
    const emptyCell = document.createElement("div");
    emptyCell.className = "schedule-cell empty";
    currentRow.appendChild(emptyCell);
  }

  // Fill in days
  for (let day = 1; day <= daysInMonth; day++) {
    const assignedDay = schedule.assignedDays.find((d) => {
      const dateInfo = d.dateInfo || d.date;
      const dayNum = typeof dateInfo.getDate === 'function' ? dateInfo.getDate() : new Date(dateInfo).getDate();
      return dayNum === day;
    });

    const cell = document.createElement("div");
    cell.className = "schedule-cell";

    // Check if it's a holiday
    const isHoliday = schedule.holidays && schedule.holidays.dates && schedule.holidays.dates.includes(day);
    if (isHoliday) {
      cell.classList.add("holiday");
    }

    const dateLabel = document.createElement("div");
    dateLabel.className = "schedule-date";
    dateLabel.textContent = day;
    cell.appendChild(dateLabel);

    if (assignedDay) {
      // Display shift information without time ranges (times are in header)
      const shiftsDiv = document.createElement("div");
      shiftsDiv.className = "schedule-shifts";

      // Sort shifts in order: a_shift, b_shift, c_shift, holiday_a_shift, holiday_b_shift
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
        
        // Create clickable mentor name or "(Empty)" for null shifts
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

    currentRow.appendChild(cell);

    // Start new row after Saturday
    if ((firstDay + day) % 7 === 0) {
      table.appendChild(currentRow);
      currentRow = document.createElement("div");
      currentRow.className = "schedule-row";
    }
  }

  // Add remaining row if it has cells
  if (currentRow.children.length > 0) {
    table.appendChild(currentRow);
  }

  container.appendChild(table);

  // Add legend
  const legend = document.createElement("div");
  legend.className = "schedule-legend";
  legend.innerHTML = `
    <p><strong>A shift</strong> = dinner | <strong>B shift</strong> = meds | <strong>C shift</strong> = errands</p>
  `;
  container.appendChild(legend);

  // Add hours summary after legend and shift descriptions
  updateHoursSummary();
}

// Function to recalculate and update hours summary based on current assignments
function updateHoursSummary() {
  if (!currentSchedule || !currentSchedule.schedule) return;
  
  const schedule = currentSchedule.schedule;
  
  // Calculate actual hours from assigned shifts by counting from the calendar
  const mentorData = {};
  
  // Initialize all mentors from mentorInfoData (the source of truth for mentor info)
  for (const [name, info] of Object.entries(mentorInfoData)) {
    mentorData[name] = {
      totalHours: 0,
      hoursWantedPerWeek: info.hours_wanted || 0,
      daysOff: [...(info.hard_dates || [])]
    };
  }
  
  // Also initialize from schedule.m1 in case there are mentors not in mentorInfoData
  const allMentors = schedule.m1 || [];
  for (const mentor of allMentors) {
    if (!mentorData[mentor.name]) {
      mentorData[mentor.name] = {
        totalHours: 0,
        hoursWantedPerWeek: mentor.hoursWantedPerWeek || mentor.hoursWanted || 0,
        daysOff: [...(mentor.hardDates || mentor.unavailableDates || [])]
      };
    }
  }
  
  // Count hours from actual assignments on the calendar
  const assignedDays = schedule.assignedDays || [];
  for (const day of assignedDays) {
    const mentorsOnShift = day.mentorsOnShift || day.assignments || {};
    
    for (const [shift, mentor] of Object.entries(mentorsOnShift)) {
      if (mentor && mentor.name) {
        // Initialize if mentor wasn't already tracked
        if (!mentorData[mentor.name]) {
          mentorData[mentor.name] = {
            totalHours: 0,
            hoursWantedPerWeek: mentor.hoursWantedPerWeek || mentor.hoursWanted || mentorInfoData[mentor.name]?.hours_wanted || 0,
            daysOff: []
          };
        }
        const shiftHours = day.shifts[shift] || 0;
        mentorData[mentor.name].totalHours += shiftHours;
      }
    }
  }
  
  // Calculate number of weeks in this month for target calculation
  const year = currentSchedule.year;
  const month = currentSchedule.month;
  const daysInMonth = new Date(year, month, 0).getDate();
  const numWeeksInMonth = daysInMonth / 7;
  
  // Update the summary table
  let summary = document.querySelector(".schedule-summary");
  
  // Create the summary div if it doesn't exist
  if (!summary) {
    summary = document.createElement("div");
    summary.className = "schedule-summary";
    const container = document.getElementById("schedule-display");
    if (container) {
      container.appendChild(summary);
    } else {
      return;
    }
  }
  
  let summaryHTML =
    "<h4>Hours Summary</h4><table><tr><th>Mentor</th><th>Total Hours</th><th>Weekly Target</th><th>Monthly Target</th><th>Difference</th><th>Days Off</th></tr>";

  // Sort mentors by name
  const sortedMentorNames = Object.keys(mentorData).sort();

  // Build table rows in sorted order
  for (const name of sortedMentorNames) {
    const data = mentorData[name];
    const monthlyTarget = (data.hoursWantedPerWeek * numWeeksInMonth).toFixed(1);
    const diff = data.totalHours - parseFloat(monthlyTarget);
    const diffStr = diff >= 0 ? `+${diff.toFixed(1)}` : diff.toFixed(1);
    const diffClass = Math.abs(diff) > 5 ? 'style="color: orange; font-weight: bold;"' : '';
    
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

  summaryHTML += "</table>";
  summary.innerHTML = summaryHTML;
}

// Function to show dropdown for editing mentor assignments
function showMentorDropdown(span, day, shift, currentName) {
  // Create dropdown
  const select = document.createElement("select");
  select.style.fontSize = "inherit";
  select.style.fontFamily = "inherit";
  
  // Add "(Empty)" option first
  const emptyOption = document.createElement("option");
  emptyOption.value = "";
  emptyOption.textContent = "(Empty)";
  if (currentName === null || currentName === "") {
    emptyOption.selected = true;
  }
  select.appendChild(emptyOption);
  
  // Add all mentors to dropdown
  const mentorNames = Object.keys(mentorInfoData);
  mentorNames.forEach(name => {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    if (name === currentName) {
      option.selected = true;
    }
    select.appendChild(option);
  });
  
  // Handle selection
  select.onchange = async () => {
    const newName = select.value;
    await updateScheduleMentor(day, shift, newName || null);
    
    // Update display
    if (newName) {
      span.textContent = newName;
      span.style.color = "";
      span.style.fontStyle = "";
      span.onclick = () => showMentorDropdown(span, day, shift, newName);
    } else {
      span.textContent = "(Empty)";
      span.style.color = "#999";
      span.style.fontStyle = "italic";
      span.onclick = () => showMentorDropdown(span, day, shift, null);
    }
  };
  
  // Handle clicking away
  select.onblur = () => {
    span.style.display = "inline";
    select.remove();
  };
  
  // Replace span with dropdown temporarily
  span.style.display = "none";
  span.parentNode.insertBefore(select, span.nextSibling);
  select.focus();
}

// Update mentor assignment in the schedule
async function updateScheduleMentor(day, shift, newName) {
  if (!currentSchedule || !currentSchedule.schedule) return;
  
  // Helper to get day number from a date (handles both Date objects and ISO strings)
  const getDayNum = (d) => {
    const dateInfo = d.dateInfo || d.date;
    if (typeof dateInfo === 'string') {
      return new Date(dateInfo).getDate();
    } else if (typeof dateInfo.getDate === 'function') {
      return dateInfo.getDate();
    }
    return null;
  };
  
  // Create a new mentor object
  const createMentorObj = (name) => {
    if (!name) return null;
    return {
      name: name,
      hoursWantedPerWeek: mentorInfoData[name]?.hours_wanted || 0,
      hoursWanted: mentorInfoData[name]?.hours_wanted || 0,
      hardDates: mentorInfoData[name]?.hard_dates || [],
      unavailableDates: mentorInfoData[name]?.hard_dates || [],
      unavailableWeekdays: mentorInfoData[name]?.weekdays || [],
      softDates: [],
      hoursPay: 0,
      hoursAssigned: 0,
      daysLeft: 0,
      preferredWeekdays: mentorInfoData[name]?.preferred_weekdays || [],
      preferredWeekday: mentorInfoData[name]?.preferred_weekdays?.[0] || null
    };
  };
  
  // Update the assignment in all arrays that might contain this day
  const updateDay = (dayObj) => {
    if (!dayObj || !dayObj.mentorsOnShift) return;
    
    if (newName === null || newName === "") {
      dayObj.mentorsOnShift[shift] = null;
    } else {
      // Always create a fresh mentor object to avoid reference issues
      dayObj.mentorsOnShift[shift] = createMentorObj(newName);
    }
  };
  
  // Find and update in assignedDays
  const assignedDay = currentSchedule.schedule.assignedDays.find(d => getDayNum(d) === day);
  if (assignedDay) {
    updateDay(assignedDay);
  }
  
  // Find and update in pay1
  const pay1Day = currentSchedule.schedule.pay1?.find(d => getDayNum(d) === day);
  if (pay1Day) {
    updateDay(pay1Day);
  }
  
  // Find and update in pay2
  const pay2Day = currentSchedule.schedule.pay2?.find(d => getDayNum(d) === day);
  if (pay2Day) {
    updateDay(pay2Day);
  }
  
  // Save and update UI
  await saveCurrentSchedule();
  showToast("Schedule updated");
  updateHoursSummary();
}

// Save current schedule to database
window.saveCurrentSchedule = async function() {
  if (!currentSchedule || !currentSchedule.schedule) {
    showToast('No schedule to save');
    return;
  }

  const saveBtn = document.getElementById('save-schedule-btn');
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
  }

  try {
    const schedule = currentSchedule.schedule;
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'];

    // Generate document ID from campus_month_year
    const docId = `${CAMPUS_ID}_${currentSchedule.month}_${currentSchedule.year}`;

    // Helper to remove undefined values
    function removeUndefined(obj) {
      if (Array.isArray(obj)) {
        return obj.map(item => removeUndefined(item));
      }
      if (obj !== null && typeof obj === 'object') {
        const cleaned = {};
        for (const [key, value] of Object.entries(obj)) {
          if (value !== undefined) {
            cleaned[key] = removeUndefined(value);
          }
        }
        return cleaned;
      }
      return obj;
    }

    function serializeMentor(m) {
      return removeUndefined({
        name: m.name,
        hoursWanted: m.hoursWanted,
        autoFillCalendar: m.autoFillCalendar,
        hardDates: m.hardDates,
        softDates: m.softDates,
        hoursPay: m.hoursPay,
        daysLeft: m.daysLeft,
        preferredWeekdays: m.preferredWeekdays,
        weekdays: m.weekdays
      });
    }

    function serializeMentorsOnShift(mentorsObj) {
      const serialized = {};
      for (const [shift, mentors] of Object.entries(mentorsObj)) {
        if (Array.isArray(mentors)) {
          serialized[shift] = mentors.map(serializeMentor);
        } else if (mentors && typeof mentors === 'object') {
          serialized[shift] = serializeMentor(mentors);
        } else {
          serialized[shift] = mentors;
        }
      }
      return serialized;
    }

    // Helper to convert date to ISO string (handles both Date objects and strings)
    function toISOString(dateInfo) {
      if (!dateInfo) return null;
      if (typeof dateInfo === 'string') return dateInfo;
      if (typeof dateInfo.toISOString === 'function') return dateInfo.toISOString();
      return new Date(dateInfo).toISOString();
    }

    const serializableSchedule = removeUndefined({
      campusId: CAMPUS_ID,
      year: currentSchedule.year,
      month: currentSchedule.month,
      generatedAt: new Date().toISOString(),
      schedule: {
        m1: schedule.m1.map(serializeMentor),
        m2: schedule.m2.map(serializeMentor),
        lenP1: schedule.lenP1,
        lenP2: schedule.lenP2,
        pay1: schedule.pay1.map(d => removeUndefined({
          dateInfo: toISOString(d.dateInfo || d.date),
          weekday: d.weekday,
          season: d.season,
          shifts: d.shifts,
          mentorsOnShift: serializeMentorsOnShift(d.mentorsOnShift || {}),
          totalHours: d.totalHours,
          assignedHours: d.assignedHours
        })),
        pay2: schedule.pay2.map(d => removeUndefined({
          dateInfo: toISOString(d.dateInfo || d.date),
          weekday: d.weekday,
          season: d.season,
          shifts: d.shifts,
          mentorsOnShift: serializeMentorsOnShift(d.mentorsOnShift || {}),
          totalHours: d.totalHours,
          assignedHours: d.assignedHours
        })),
        assignedDays: schedule.assignedDays.map(d => removeUndefined({
          dateInfo: toISOString(d.dateInfo || d.date),
          weekday: d.weekday,
          season: d.season,
          shifts: d.shifts,
          mentorsOnShift: serializeMentorsOnShift(d.mentorsOnShift || {}),
          totalHours: d.totalHours,
          assignedHours: d.assignedHours
        })),
        holidays: schedule.holidays || { shift_info: {}, dates: [] }
      },
      validationMessages: currentSchedule.validationMessages || []
    });

    await setDoc(doc(db, 'savedSchedules', docId), serializableSchedule);
    
    // Update current schedule with the ID
    currentSchedule.id = docId;

    // Reload the saved schedules list
    await loadSavedSchedulesList();

    const monthName = monthNames[currentSchedule.month - 1];
    showToast(`Schedule saved: ${monthName} ${currentSchedule.year}`);
  } catch (error) {
    console.error('Error saving schedule:', error);
    showToast('Error saving schedule');
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Schedule';
    }
  }
};

// Auto-fill mentor dates on calendar
async function autoFillMentorDates(mentorName, unavailableWeekdays) {
  if (unavailableWeekdays.length === 0) return;

  // Load calendar config to get current month/year
  const configDoc = await getDoc(doc(db, "calendarConfig", CAMPUS_ID));
  let year = 2026;
  let month = 0; // 0 = January

  if (configDoc.exists()) {
    const config = configDoc.data();
    year = config.targetYear || year;
    month = config.targetMonth !== undefined ? config.targetMonth : month;
  }

  const weekdayMap = {
    Sunday: 0,
    Monday: 1,
    Tuesday: 2,
    Wednesday: 3,
    Thursday: 4,
    Friday: 5,
    Saturday: 6,
  };

  // Get all dates in the month that match the unavailable weekdays
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const datesToFill = [];

  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(year, month, day);
    const dayOfWeek = date.getDay();

    for (const weekday of unavailableWeekdays) {
      if (weekdayMap[weekday] === dayOfWeek) {
        datesToFill.push(day);
        break;
      }
    }
  }

  // Update timeOffData for these dates
  for (const day of datesToFill) {
    if (!timeOffData[day]) {
      timeOffData[day] = [];
    }

    // Add mentor to next available slot (don't exceed slots limit)
    // The slots limit will be checked when saving, but we should respect it during auto-fill
    if (!timeOffData[day].includes(mentorName)) {
      timeOffData[day].push(mentorName);
    }
  }
}

// Calendar Management Functions
window.updateCalendarDate = async function () {
  const month = parseInt(document.getElementById("calendar-month").value);
  const year = parseInt(document.getElementById("calendar-year").value);

  if (isNaN(year) || year < 2020 || year > 2100) {
    showToast("Please enter a valid year between 2020 and 2100");
    return;
  }

  try {
    // Load existing config
    const configDoc = await getDoc(doc(db, "calendarConfig", CAMPUS_ID));
    const existingConfig = configDoc.exists() ? configDoc.data() : {};

    // Update with new month/year while preserving other settings
    const updatedConfig = {
      ...existingConfig,
      targetMonth: month,
      targetYear: year,
    };

    await setDoc(doc(db, "calendarConfig", CAMPUS_ID), updatedConfig);

    // Update the schedule generation defaults
    document.getElementById("schedule-year").value = year;
    document.getElementById("schedule-month").value = month + 1;
    updateHolidays();

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
    // Load existing config
    const configDoc = await getDoc(doc(db, "calendarConfig", CAMPUS_ID));
    const existingConfig = configDoc.exists() ? configDoc.data() : {};

    // Update with new slots while preserving other settings
    const updatedConfig = {
      ...existingConfig,
      slotsAvailable: slots,
    };

    await setDoc(doc(db, "calendarConfig", CAMPUS_ID), updatedConfig);
    showToast(
      "Slots updated successfully. Refresh the main calendar page to see changes."
    );
  } catch (error) {
    console.error("Error updating slots:", error);
    showToast("Error updating slots");
  }
};

window.clearCalendar = async function () {
  if (
    !confirm(
      "Are you sure you want to clear ALL time-off entries? This will auto-fill based on mentors with auto-fill enabled."
    )
  ) {
    return;
  }

  const statusDiv = document.getElementById("calendar-status");
  statusDiv.textContent = "Clearing calendar...";
  statusDiv.className = "status-message info";
  statusDiv.style.display = "block";

  try {
    // Clear all time-off data
    timeOffData = {};

    // Auto-fill for mentors with auto-fill enabled
    for (const [name, info] of Object.entries(mentorInfoData)) {
      if (
        info.auto_fill_calendar &&
        info.weekdays &&
        info.weekdays.length > 0
      ) {
        await autoFillMentorDates(name, info.weekdays);
      }
    }

    // Save to Firebase (save once after all auto-fills)
    await setDoc(doc(db, "timeOff", CAMPUS_ID), { mentors: timeOffData });

    statusDiv.textContent = "Calendar cleared and auto-filled successfully!";
    statusDiv.className = "status-message success";

    setTimeout(() => {
      statusDiv.style.display = "none";
    }, 3000);
  } catch (error) {
    console.error("Error clearing calendar:", error);
    statusDiv.textContent = `Error: ${error.message}`;
    statusDiv.className = "status-message error";
  }
};

export { displaySchedule };
