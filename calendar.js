import { db, doc, setDoc, getDoc, onSnapshot } from "./firebase.js";
import { CAMPUS_ID } from "./config.js";
import { showToast, updateDayStyles } from "./ui.js";
import {
  MONTH_NAMES,
  monthKey,
  isMonthKeyed,
  getMonthSlice,
  migrateFlatTimeOff,
  normalizeSlots,
} from "./dates.js";

let mentorInfoData = {};
let mentors = []; // Names shown in the dropdowns (show_on_calendar !== false)
let slotsAvailable = 3;
let targetMonth = 0; // 0 = Jan
let targetYear = 2026;
let timeOffAll = {}; // Month-keyed: { "2026-01": { "5": ["Sofia", "", ""] } }
let timeOffData = {}; // Slice for the target month
let autoFilledAll = {}; // Admin's prefill record - carried through, never edited here

function currentMonthKey() {
  return monthKey(targetYear, targetMonth + 1);
}

// Both fields go in every write: setDoc replaces the whole document
async function saveTimeOffDoc() {
  await setDoc(doc(db, "timeOff", CAMPUS_ID), {
    mentors: timeOffAll,
    autoFilled: autoFilledAll,
  });
}

async function loadMentorList() {
  try {
    const docSnap = await getDoc(doc(db, "mentorInfo", CAMPUS_ID));
    if (docSnap.exists()) {
      mentorInfoData = docSnap.data()?.mentors || {};
      mentors = Object.keys(mentorInfoData)
        .filter((name) => mentorInfoData[name].show_on_calendar !== false)
        .sort((a, b) => a.localeCompare(b));
    } else {
      console.warn("No mentor info document found in Firebase");
    }
  } catch (error) {
    console.error("Error loading mentor list:", error);
  }
}

async function loadTimeOffData() {
  try {
    const docSnap = await getDoc(doc(db, "timeOff", CAMPUS_ID));
    if (docSnap.exists()) {
      timeOffAll = docSnap.data()?.mentors || {};
      autoFilledAll = docSnap.data()?.autoFilled || {};
      // One-time migration: legacy docs were keyed by bare day-of-month
      if (!isMonthKeyed(timeOffAll)) {
        timeOffAll = migrateFlatTimeOff(timeOffAll, currentMonthKey());
        await saveTimeOffDoc();
      }
      timeOffData = getMonthSlice(timeOffAll, currentMonthKey());
    }
  } catch (error) {
    console.error("Error loading time off data:", error);
  }
}

async function loadSlotsConfig() {
  try {
    const docSnap = await getDoc(doc(db, "calendarConfig", CAMPUS_ID));
    if (docSnap.exists()) {
      const config = docSnap.data();
      slotsAvailable = config?.slotsAvailable || 3;
      targetMonth = config?.targetMonth !== undefined ? config.targetMonth : 0;
      targetYear = config?.targetYear || 2026;
    }
  } catch (error) {
    console.error("Error loading calendar config:", error);
  }
}

export async function createCalendar() {
  await loadMentorList();
  await loadSlotsConfig();
  await loadTimeOffData();

  const calendar = document.getElementById("calendar");
  calendar.innerHTML = "";

  document.getElementById("campus-name").textContent = `${CAMPUS_ID}`;
  document.getElementById(
    "month-name"
  ).textContent = `${MONTH_NAMES[targetMonth]} ${targetYear}`;

  const daysInMonth = new Date(targetYear, targetMonth + 1, 0).getDate();
  const firstDay = new Date(targetYear, targetMonth, 1).getDay();

  ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].forEach((day) => {
    const header = document.createElement("div");
    header.className = "header";
    header.textContent = day;
    calendar.appendChild(header);
  });

  for (let i = 0; i < firstDay; i++) {
    const emptyCell = document.createElement("div");
    emptyCell.className = "empty";
    calendar.appendChild(emptyCell);
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const dayDiv = document.createElement("div");
    dayDiv.className = "day";

    const dateLabel = document.createElement("div");
    dateLabel.className = "date";
    dateLabel.textContent = day;
    dayDiv.appendChild(dateLabel);

    for (let i = 0; i < slotsAvailable; i++) {
      const select = document.createElement("select");
      const stored = (timeOffData[day] && timeOffData[day][i]) || "";
      // A stored name may be hidden from the calendar, renamed or deleted;
      // without an option for it the value silently resets to empty
      const names = stored && !mentors.includes(stored) ? [...mentors, stored] : mentors;
      select.innerHTML =
        '<option value="">-</option>' +
        names.map((emp) => `<option value="${emp}">${emp}</option>`).join("");
      select.onchange = () => saveTimeOff(day, i, select);
      if (stored) {
        select.value = stored;
      }
      dayDiv.appendChild(select);
    }

    calendar.appendChild(dayDiv);
  }

  updateDayStyles();
}

async function saveTimeOff(day, index, select) {
  const name = select.value;
  const previous = (timeOffData[day] && timeOffData[day][index]) || "";
  const dayDiv = select.parentElement;
  const selects = dayDiv.querySelectorAll("select");

  for (let i = 0; i < selects.length; i++) {
    if (i !== index && selects[i].value === name && name !== "") {
      showToast(`${name} already claimed a slot for this day.`);
      select.value = previous;
      return;
    }
  }

  try {
    timeOffData[day] = normalizeSlots(timeOffData[day], slotsAvailable);
    timeOffData[day][index] = name;
    timeOffAll[currentMonthKey()] = timeOffData;

    await saveTimeOffDoc();

    showToast("Saved!");
    updateDayStyles();
  } catch (error) {
    console.error("Error saving time-off data:", error);
    showToast("Could not save. Please try again.");
    select.value = previous;
  }
}

onSnapshot(doc(db, "timeOff", CAMPUS_ID), (docSnap) => {
  if (docSnap.exists()) {
    timeOffAll = migrateFlatTimeOff(docSnap.data()?.mentors || {}, currentMonthKey());
    autoFilledAll = docSnap.data()?.autoFilled || {};
    timeOffData = getMonthSlice(timeOffAll, currentMonthKey());
    createCalendar();
  }
});
