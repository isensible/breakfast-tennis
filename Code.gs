/**
 * Breakfast Tennis court bookings — Google Apps Script backend.
 *
 * Data lives in three tabs of the spreadsheet this script is bound to:
 *   Settings: book-ahead days, courts, booking lengths, start-time step, weekly session times
 *   Bookings: Date | Court | Start | Finish | Minutes | Booker | Updated | Updated by | ID
 *   Bookers:  Name
 * All three are created automatically on first use. Other tabs are never touched.
 *
 * A court can hold several bookings in one session (e.g. 06:00–07:00 then 07:00–08:30),
 * and a booking may start before or finish after the session's published times,
 * as long as it overlaps the session.
 */

const LOOKBACK_DAYS = 56;     // how far back the app loads bookings
const SETTINGS = 'Settings';
const BOOKINGS = 'Bookings';
const BOOKERS = 'Bookers';
const BOOKINGS_HEADER = ['Date', 'Court', 'Start', 'Finish', 'Minutes', 'Booker', 'Updated', 'Updated by', 'ID'];
const BOOKERS_HEADER = ['Name'];
const COL = { date: 0, court: 1, start: 2, finish: 3, minutes: 4, booker: 5, updated: 6, by: 7, id: 8 };

// Defaults written to a new Settings tab. Edit the tab, not these.
const DEFAULT_SETTINGS = [
  ['Setting', 'Value', ''],
  ['Book ahead days', '9', ''],
  ['Courts', '14', ''],
  ['Booking lengths (minutes)', '60, 90, 120', ''],
  ['Start time step (minutes)', '30', ''],
  ['', '', ''],
  ['Day', 'Start', 'Finish'],
  ['Wednesday', '06:30', '08:00'],
  ['Friday', '06:30', '08:00'],
  ['Sunday', '07:00', '08:30'],
];
const DEFAULT_LENGTHS = [60, 90, 120];
const DEFAULT_STEP = 30;
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ---------- web app ----------

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Breakfast Tennis Courts')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Run once from the editor to create the tabs and grant permissions. */
function setup() {
  settingsSheet_();
  bookingsSheet_();
  sheet_(BOOKERS, BOOKERS_HEADER);
}

// ---------- API called from the page ----------

function getData() {
  const config = readConfig_();
  const today = today_();
  const since = addDays_(today, -LOOKBACK_DAYS);
  const bookings = readBookings_().filter(b => b.date >= since);
  return { today: today, config: config, bookers: readBookers_(), bookings: bookings };
}

/**
 * Create or update one booking.
 * b = { id (omit for new), date: 'yyyy-mm-dd', court: n, start: 'hh:mm', minutes: n, booker: name }
 */
function saveBooking(b) {
  return withLock_(() => {
    const config = readConfig_();
    const date = String(b.date || '');
    const court = Number(b.court);
    const start = time_(b.start);
    const minutes = Number(b.minutes);
    const booker = String(b.booker || '').trim();
    const id = String(b.id || '');

    const session = validateDateCourt_(config, date, court);
    if (!start) throw new Error('Pick a start time.');
    if (config.lengths.indexOf(minutes) === -1) throw new Error('Booking length must be ' + config.lengths.join(', ') + ' minutes.');
    if (readBookers_().indexOf(booker) === -1) throw new Error((booker || 'That name') + ' is not on the booker list.');

    const s = toMin_(start), e = s + minutes;
    if (e > 24 * 60) throw new Error('A booking can’t run past midnight.');
    if (!(s < toMin_(session.end) && e > toMin_(session.start))) {
      throw new Error('That booking doesn’t overlap the ' + session.start + '–' + session.end + ' session.');
    }
    const clash = readBookings_().filter(o =>
      o.date === date && o.court === court && o.id !== id && toMin_(o.start) < e && s < toMin_(o.end))[0];
    if (clash) throw new Error('Court ' + court + ' is already booked ' + clash.start + '–' + clash.end + ' by ' + clash.booker + '.');

    const sh = bookingsSheet_();
    const row = id ? findRowById_(sh, id) : 0;
    if (id && !row) throw new Error('That booking was deleted by someone else.');
    const values = [date, court, start, fromMin_(e), minutes, booker, new Date(), userEmail_(), id || newId_()];
    if (row) sh.getRange(row, 1, 1, values.length).setValues([values]);
    else sh.appendRow(values);
  });
}

function deleteBooking(id) {
  return withLock_(() => {
    const sh = bookingsSheet_();
    const row = findRowById_(sh, String(id));
    if (row) sh.deleteRow(row);
  });
}

function addBooker(name) {
  return withLock_(() => {
    name = String(name || '').trim().replace(/\s+/g, ' ');
    if (!name) throw new Error('Enter a name.');
    if (name.length > 40) throw new Error('Keep names under 40 characters.');
    const existing = readBookers_().map(s => s.toLowerCase());
    if (existing.indexOf(name.toLowerCase()) !== -1) throw new Error(name + ' is already on the list.');
    sheet_(BOOKERS, BOOKERS_HEADER).appendRow([name]);
  });
}

function removeBooker(name) {
  return withLock_(() => {
    const sh = sheet_(BOOKERS, BOOKERS_HEADER);
    const n = sh.getLastRow() - 1;
    if (n < 1) return;
    const names = sh.getRange(2, 1, n, 1).getValues();
    for (let i = names.length - 1; i >= 0; i--) {
      if (String(names[i][0]).trim() === name) sh.deleteRow(i + 2);
    }
    // Existing bookings keep the name, so past and upcoming courts still show who booked them.
  });
}

// ---------- bookings tab ----------

function bookingsSheet_() {
  const sh = sheet_(BOOKINGS, BOOKINGS_HEADER);
  const header = sh.getRange(1, 1, 1, 3).getDisplayValues()[0];
  if (String(header[2]).trim().toLowerCase() !== 'start') {
    throw new Error('The Bookings tab is in an older layout. Rename or delete that tab, then reload: the app will create a new one.');
  }
  return sh;
}

/** All bookings as plain objects. Rows typed in by hand without an ID are given one. */
function readBookings_() {
  const sh = bookingsSheet_();
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  const rows = sh.getRange(2, 1, n, BOOKINGS_HEADER.length).getDisplayValues();
  const out = [];
  rows.forEach((r, i) => {
    const date = normDate_(r[COL.date]);
    const court = Number(r[COL.court]);
    const start = time_(r[COL.start]);
    let minutes = Number(r[COL.minutes]);
    if (!minutes && start && time_(r[COL.finish])) minutes = toMin_(time_(r[COL.finish])) - toMin_(start);
    if (!date || !court || !start || !(minutes > 0)) return; // skip incomplete rows
    let id = String(r[COL.id]).trim();
    if (!id) { id = newId_(); sh.getRange(i + 2, COL.id + 1).setValue(id); }
    out.push({
      id: id, date: date, court: court, start: start,
      end: fromMin_(toMin_(start) + minutes), minutes: minutes,
      booker: String(r[COL.booker]).trim(),
    });
  });
  return out;
}

function findRowById_(sh, id) {
  const n = sh.getLastRow() - 1;
  if (n < 1 || !id) return 0;
  const ids = sh.getRange(2, COL.id + 1, n, 1).getDisplayValues();
  for (let i = 0; i < ids.length; i++) if (String(ids[i][0]).trim() === id) return i + 2;
  return 0;
}

function newId_() { return Utilities.getUuid().slice(0, 8); }

// ---------- settings ----------

function settingsSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SETTINGS);
  if (!sh) {
    sh = ss.insertSheet(SETTINGS, 0);
    sh.getRange(1, 1, 30, 3).setNumberFormat('@'); // keep times and lists as plain text
    sh.getRange(1, 1, DEFAULT_SETTINGS.length, 3).setValues(DEFAULT_SETTINGS);
    sh.getRange('A1:B1').setFontWeight('bold');
    sh.getRange('A7:C7').setFontWeight('bold');
    sh.getRange('E7').setValue('One row per session day. Times are 24-hour hh:mm. The list ends at the first blank row.')
      .setFontStyle('italic').setFontColor('#666666');
    sh.autoResizeColumns(1, 3);
  }
  return sh;
}

/**
 * Reads the Settings tab by its labels, so rows can move around.
 * Missing optional settings fall back to defaults. Throws a plain-English
 * error naming the problem row when something is wrong.
 */
function readConfig_() {
  const values = settingsSheet_().getDataRange().getDisplayValues();
  const found = {};
  let dayHeader = -1;
  for (let i = 0; i < values.length; i++) {
    const label = values[i][0].trim().toLowerCase();
    if (label === 'book ahead days') found.ahead = [values[i][1], i];
    else if (label === 'courts') found.courts = [values[i][1], i];
    else if (label.indexOf('booking length') === 0) found.lengths = [values[i][1], i];
    else if (label.indexOf('start time step') === 0) found.step = [values[i][1], i];
    else if (label === 'day' && dayHeader < 0) dayHeader = i;
  }
  const where = k => 'Settings tab, row ' + (found[k][1] + 1);

  if (!found.ahead) throw new Error('Settings tab: add a "Book ahead days" row, e.g. 9.');
  const bookAheadDays = Number(found.ahead[0]);
  if (!(bookAheadDays >= 0 && Math.floor(bookAheadDays) === bookAheadDays)) throw new Error(where('ahead') + ': "Book ahead days" must be a whole number, e.g. 9.');

  if (!found.courts) throw new Error('Settings tab: add a "Courts" row, e.g. 14.');
  const courts = Number(found.courts[0]);
  if (!(courts >= 1 && courts <= 40 && Math.floor(courts) === courts)) throw new Error(where('courts') + ': "Courts" must be a whole number between 1 and 40.');

  let lengths = DEFAULT_LENGTHS.slice();
  if (found.lengths && found.lengths[0].trim()) {
    lengths = found.lengths[0].split(/[,;\s]+/).filter(Boolean).map(Number);
    if (!lengths.length || lengths.some(m => !(m >= 15 && m <= 600 && Math.floor(m) === m))) {
      throw new Error(where('lengths') + ': list booking lengths in minutes separated by commas, e.g. 60, 90, 120.');
    }
    lengths = lengths.filter((m, i) => lengths.indexOf(m) === i).sort((a, b) => a - b);
  }

  let step = DEFAULT_STEP;
  if (found.step && found.step[0].trim()) {
    step = Number(found.step[0]);
    if ([5, 10, 15, 20, 30, 60].indexOf(step) === -1) throw new Error(where('step') + ': start time step must be 5, 10, 15, 20, 30 or 60 minutes.');
  }

  if (dayHeader < 0) throw new Error('Settings tab: add a row with "Day | Start | Finish" headings above the session days.');
  const sessions = [];
  for (let i = dayHeader + 1; i < values.length; i++) {
    const dayText = values[i][0].trim();
    if (!dayText) break; // a blank row ends the session list
    const at = 'Settings tab, row ' + (i + 1);
    const dow = dayIndex_(dayText);
    if (dow < 0) throw new Error(at + ': "' + dayText + '" is not a day of the week.');
    if (sessions.some(s => s.dow === dow)) throw new Error(at + ': ' + DAY_NAMES[dow] + ' is listed twice.');
    const start = time_(values[i][1]), end = time_(values[i][2]);
    if (!start || !end) throw new Error(at + ': enter Start and Finish as 24-hour times, e.g. 06:30.');
    if (end <= start) throw new Error(at + ': Finish must be after Start.');
    sessions.push({ dow: dow, day: DAY_NAMES[dow], start: start, end: end });
  }
  if (!sessions.length) throw new Error('Settings tab: list at least one session day under the "Day" heading.');
  sessions.sort((a, b) => ((a.dow + 6) % 7) - ((b.dow + 6) % 7)); // Monday first

  return { bookAheadDays: bookAheadDays, courts: courts, lengths: lengths, step: step, sessions: sessions };
}

function dayIndex_(text) {
  const t = text.toLowerCase();
  for (let i = 0; i < 7; i++) {
    const name = DAY_NAMES[i].toLowerCase();
    if (t === name || (t.length >= 3 && name.indexOf(t) === 0)) return i;
  }
  return -1;
}

// ---------- helpers ----------

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('Someone else is saving. Try again in a moment.');
  try { fn(); SpreadsheetApp.flush(); }
  finally { lock.releaseLock(); }
  return getData();
}

function validateDateCourt_(config, date, court) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid date.');
  const session = config.sessions.filter(s => s.dow === dow_(date))[0];
  if (!session) throw new Error('There is no Breakfast Tennis session on that day.');
  if (!(court >= 1 && court <= config.courts && Math.floor(court) === court)) throw new Error('Court must be 1–' + config.courts + '.');
  const ahead = daysBetween_(today_(), date);
  if (ahead > config.bookAheadDays) {
    throw new Error('Bookings open ' + config.bookAheadDays + ' days ahead. This session opens on ' + addDays_(date, -config.bookAheadDays) + '.');
  }
  return session;
}

function readBookers_() {
  const sh = sheet_(BOOKERS, BOOKERS_HEADER);
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, 1).getValues()
    .map(r => String(r[0]).trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

function sheet_(name, header) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    if (name === BOOKINGS) sh.getRange('A:D').setNumberFormat('@'); // dates and times as plain text
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function userEmail_() {
  try { return Session.getActiveUser().getEmail() || ''; } catch (e) { return ''; }
}

/** "6:30", "06:30", "6:30:00" or "6:30 AM" → "06:30"; anything else → "". */
function time_(text) {
  const m = String(text == null ? '' : text).trim().match(/^(\d{1,2})[:.](\d{2})(?::\d{2})?\s*([ap]\.?m\.?)?$/i);
  if (!m) return '';
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (m[3]) {
    if (h < 1 || h > 12) return '';
    h = (h % 12) + (/^p/i.test(m[3]) ? 12 : 0);
  }
  if (h > 23 || min > 59) return '';
  return fromMin_(h * 60 + min);
}
function toMin_(hhmm) { const p = hhmm.split(':'); return Number(p[0]) * 60 + Number(p[1]); }
function fromMin_(m) { const h = Math.floor(m / 60), x = m % 60; return (h < 10 ? '0' : '') + h + ':' + (x < 10 ? '0' : '') + x; }

/** 'yyyy-mm-dd' or UK 'dd/mm/yyyy' → 'yyyy-mm-dd'; anything else → ''. */
function normDate_(text) {
  const t = String(text).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return m[3] + '-' + (m[2].length < 2 ? '0' : '') + m[2] + '-' + (m[1].length < 2 ? '0' : '') + m[1];
  return '';
}

function tz_() { return Session.getScriptTimeZone() || 'Europe/London'; }
function today_() { return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd'); }
function utc_(ymd) { const p = String(ymd).split('-').map(Number); return Date.UTC(p[0], p[1] - 1, p[2]); }
function dow_(ymd) { return new Date(utc_(ymd)).getUTCDay(); }
function addDays_(ymd, n) { return new Date(utc_(ymd) + n * 86400000).toISOString().slice(0, 10); }
function daysBetween_(a, b) { return Math.round((utc_(b) - utc_(a)) / 86400000); }
