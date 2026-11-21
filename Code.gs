/**
 * Breakfast Tennis court bookings — Google Apps Script backend.
 *
 * Tabs in the spreadsheet this script is bound to (created automatically; other tabs are never touched):
 *   Settings:   book-ahead days, courts, booking lengths, start step, confirm hours, weekly session times
 *   Players:    ID | Name | Booker            — everyone who books, plays on a booking, or attends
 *   Bookings:   Date | Court | Start | Finish | Minutes | Status | Booker | Players |
 *               Booker name | Player names | Updated | Updated by | ID
 *               ("Players" here means the people named on the booking besides the booker.)
 *   Attendance: Date | Player | Status | Added | Name | Updated | Updated by
 *
 * Bookings and attendance refer to players by ID; the name columns are only there to make
 * the sheet readable, and are refreshed whenever a player is renamed.
 *
 * Booking status:
 *   A booking with players named is Confirmed. Without them it is Provisional if it was made
 *   more than "Confirm players (hours before)" ahead, otherwise Confirmed. A Provisional booking
 *   past that deadline may have been cancelled by the club; the app flags it but doesn't block anything.
 *
 * Attendance is per session (date) and player. A No-show by someone named on a booking that
 * session is a "black mark".
 */

const LOOKBACK_DAYS = 56;     // bookings and attendance the page loads
const MARKS_DAYS = 365;       // how far back black marks are listed
const SETTINGS = 'Settings';
const BOOKINGS = 'Bookings';
const PLAYERS = 'Players';
const ATTENDANCE = 'Attendance';
const OLD_BOOKERS = 'Bookers';
const BOOKINGS_HEADER = ['Date', 'Court', 'Start', 'Finish', 'Minutes', 'Status', 'Booker', 'Players',
  'Booker name', 'Player names', 'Updated', 'Updated by', 'ID'];
const COL = { date: 0, court: 1, start: 2, finish: 3, minutes: 4, status: 5, booker: 6, opponents: 7,
  bookerName: 8, opponentNames: 9, updated: 10, by: 11, id: 12 };
const PLAYERS_HEADER = ['ID', 'Name', 'Booker'];
const ATTENDANCE_HEADER = ['Date', 'Player', 'Status', 'Added', 'Name', 'Updated', 'Updated by'];
const PROVISIONAL = 'Provisional', CONFIRMED = 'Confirmed';
const ATTENDED = 'Attended', NO_SHOW = 'No-show';

// Defaults written to a new Settings tab. Edit the tab, not these.
const DEFAULT_SETTINGS = [
  ['Setting', 'Value', ''],
  ['Book ahead days', '9', ''],
  ['Courts', '14', ''],
  ['Booking lengths (minutes)', '60, 90, 120', ''],
  ['Start time step (minutes)', '30', ''],
  ['Confirm players (hours before)', '72', ''],
  ['', '', ''],
  ['Day', 'Start', 'Finish'],
  ['Wednesday', '06:30', '08:00'],
  ['Friday', '06:30', '08:00'],
  ['Sunday', '07:00', '08:30'],
];
const DEFAULT_LENGTHS = [60, 90, 120];
const DEFAULT_STEP = 30;
const DEFAULT_CONFIRM_HOURS = 72;
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ---------- web app ----------

function doGet() {
  const page = HtmlService.createTemplateFromFile('Index');
  page.viewer = userEmail_(); // shown when loading fails, so access problems are easy to diagnose
  return page.evaluate()
    .setTitle('Breakfast Tennis Courts')
    .setFaviconUrl('https://raw.githubusercontent.com/isensible/breakfast-tennis/main/favicon.png')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Run once from the editor to create the tabs (or convert an older sheet) and grant permissions. */
function setup() {
  settingsSheet_();
  ensureSchema_();
  sheet_(ATTENDANCE, ATTENDANCE_HEADER);
}

// ---------- API called from the page ----------

function getData() {
  ensureSchema_();
  const config = readConfig_();
  const players = readPlayers_();
  const all = readBookings_(players);
  const att = readAttendance_(players);
  const today = today_();
  const since = addDays_(today, -LOOKBACK_DAYS);
  return {
    today: today,
    now: Date.now(),
    config: config,
    players: players.map(p => ({ id: p.id, name: p.name, booker: p.booker })),
    bookings: all.filter(b => b.date >= since),
    attendance: att.filter(a => a.date >= since),
    marks: blackMarks_(all, att, addDays_(today, -MARKS_DAYS)),
  };
}

/**
 * Create or update one booking.
 * b = { id (omit for new), date: 'yyyy-mm-dd', court, start: 'hh:mm', minutes,
 *       bookerId, opponentIds: [up to 3 player ids], status: 'Provisional' | 'Confirmed' }
 */
function saveBooking(b) {
  return withLock_(() => {
    const config = readConfig_();
    const players = readPlayers_();
    const byId = indexBy_(players, 'id');
    const date = String(b.date || '');
    const court = Number(b.court);
    const start = time_(b.start);
    const minutes = Number(b.minutes);
    const id = String(b.id || '');

    const session = validateDateCourt_(config, date, court);
    if (!start) throw new Error('Pick a start time.');
    if (config.lengths.indexOf(minutes) === -1) throw new Error('Booking length must be ' + config.lengths.join(', ') + ' minutes.');

    const bookings = readBookings_(players);
    const existing = id ? bookings.filter(x => x.id === id)[0] : null;
    if (id && !existing) throw new Error('That booking was deleted by someone else.');

    const bookerId = String(b.bookerId || '');
    const booker = byId[bookerId];
    if (!booker) throw new Error('Pick who booked the court.');
    if (!booker.booker && !(existing && existing.bookerId === bookerId)) {
      throw new Error(booker.name + ' isn’t marked as a booker on the Players list.');
    }

    const oppIds = [];
    (b.opponentIds || []).forEach(o => {
      const pid = String(o || '').trim();
      if (!pid) return;
      if (!byId[pid]) throw new Error('A player is no longer on the Players list. Reload and pick again.');
      if (pid === bookerId) throw new Error(booker.name + ' booked the court, so can’t also be listed as a player.');
      if (oppIds.indexOf(pid) !== -1) throw new Error(byId[pid].name + ' is listed twice.');
      oppIds.push(pid);
    });
    // Any number of players up to 3 is fine: not everyone needs naming for a booking to be confirmed.
    if (oppIds.length > 3) throw new Error('A booking can name at most 3 players besides the booker.');

    const s = toMin_(start), e = s + minutes;
    if (e > 24 * 60) throw new Error('A booking can’t run past midnight.');
    if (!(s < toMin_(session.end) && e > toMin_(session.start))) {
      throw new Error('That booking doesn’t overlap the ' + session.start + '–' + session.end + ' session.');
    }
    const clash = bookings.filter(o =>
      o.date === date && o.court === court && o.id !== id && toMin_(o.start) < e && s < toMin_(o.end))[0];
    if (clash) {
      throw new Error('Court ' + court + ' is already booked ' + clash.start + '–' + clash.end + ' by ' + nameOf_(byId, clash.bookerId) + '.');
    }

    let status;
    if (oppIds.length) status = CONFIRMED;
    else if (b.status === PROVISIONAL || b.status === CONFIRMED) status = b.status;
    else if (existing) status = existing.status;
    else status = Date.now() < startTime_(date, start) - config.confirmHours * 3600000 ? PROVISIONAL : CONFIRMED;

    const sh = bookingsSheet_();
    const row = id ? findRowById_(sh, id) : 0;
    const values = [date, court, start, fromMin_(e), minutes, status, bookerId, oppIds.join(', '),
      booker.name, oppIds.map(p => byId[p].name).join(', '), new Date(), userEmail_(), id || newId_()];
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

function addPlayer(p) {
  return withLock_(() => {
    const name = cleanName_(p && p.name);
    checkNewName_(name, readPlayers_(), '');
    createPlayer_(name, !!(p && p.booker));
  });
}

/** p = { id, name?, booker? } — rename and/or change the Booker tick. */
function updatePlayer(p) {
  return withLock_(() => {
    const players = readPlayers_();
    const player = players.filter(x => x.id === String(p.id))[0];
    if (!player) throw new Error('That player was removed by someone else.');
    const sh = playersSheet_();
    if (p.name != null) {
      const name = cleanName_(p.name);
      if (name !== player.name) {
        checkNewName_(name, players, player.id);
        sh.getRange(player.row, 2).setValue(name);
        player.name = name;
        refreshNames_(players);
      }
    }
    if (p.booker != null) sh.getRange(player.row, 3).setValue(p.booker ? 'Yes' : '');
  });
}

function removePlayer(id) {
  return withLock_(() => {
    const players = readPlayers_();
    const player = players.filter(x => x.id === String(id))[0];
    if (!player) return;
    const used = readBookings_(players).filter(b => b.bookerId === player.id || b.opponentIds.indexOf(player.id) !== -1).length;
    const attended = readAttendance_(players).filter(a => a.playerId === player.id).length;
    if (used || attended) {
      throw new Error(player.name + ' is on ' + (used ? used + ' booking' + (used === 1 ? '' : 's') : '') +
        (used && attended ? ' and ' : '') + (attended ? attended + ' attendance record' + (attended === 1 ? '' : 's') : '') +
        ', so can’t be removed. Untick Booker if they no longer book courts.');
    }
    playersSheet_().deleteRow(player.row);
  });
}

/**
 * Record attendance for one session.
 * p = { date, entries: [{ playerId, status: 'Attended' | 'No-show' | '', added: bool, remove: bool }] }
 * "added" marks a player who wasn't named on a booking. "remove" deletes that player's row for the session.
 */
function setAttendance(p) {
  return withLock_(() => {
    const config = readConfig_();
    const date = String(p.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid date.');
    if (!config.sessions.some(s => s.dow === dow_(date))) throw new Error('There is no Breakfast Tennis session on that day.');
    const byId = indexBy_(readPlayers_(), 'id');
    const sh = sheet_(ATTENDANCE, ATTENDANCE_HEADER);
    const n = sh.getLastRow() - 1;
    const rows = n > 0 ? sh.getRange(2, 1, n, 4).getDisplayValues() : [];
    const rowOf = {};
    rows.forEach((r, i) => { if (normDate_(r[0]) === date) rowOf[String(r[1]).trim()] = { row: i + 2, added: isYes_(r[3]) }; });

    const appends = [], deletes = [], when = new Date(), who = userEmail_();
    (p.entries || []).forEach(e => {
      const pid = String(e.playerId || '');
      if (!byId[pid]) throw new Error('A player is no longer on the Players list. Reload and try again.');
      const status = e.status === ATTENDED || e.status === NO_SHOW ? e.status : '';
      const cur = rowOf[pid];
      const added = e.added != null ? !!e.added : !!(cur && cur.added);
      if (e.remove || (!status && !added)) { if (cur) deletes.push(cur.row); return; }
      const values = [date, pid, status, added ? 'Yes' : '', byId[pid].name, when, who];
      if (cur) sh.getRange(cur.row, 1, 1, values.length).setValues([values]);
      else appends.push(values);
    });
    deletes.sort((a, b) => b - a).forEach(r => sh.deleteRow(r));
    if (appends.length) sh.getRange(sh.getLastRow() + 1, 1, appends.length, ATTENDANCE_HEADER.length).setValues(appends);
  });
}

// ---------- players ----------

function playersSheet_() { return sheet_(PLAYERS, PLAYERS_HEADER); }

/** Players with their sheet row. Rows typed in by hand without an ID are given one. */
function readPlayers_() {
  const sh = playersSheet_();
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  const rows = sh.getRange(2, 1, n, 3).getDisplayValues();
  const out = [];
  let next = 0;
  rows.forEach(r => { const m = String(r[0]).match(/^P(\d+)$/i); if (m) next = Math.max(next, Number(m[1])); });
  rows.forEach((r, i) => {
    const name = cleanName_(r[1]);
    if (!name) return;
    let id = String(r[0]).trim().toUpperCase();
    if (!id) { id = playerId_(++next); sh.getRange(i + 2, 1).setValue(id); }
    out.push({ id: id, name: name, booker: isYes_(r[2]), row: i + 2 });
  });
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function createPlayer_(name, booker) {
  const sh = playersSheet_();
  const n = sh.getLastRow() - 1;
  let next = 0;
  if (n > 0) sh.getRange(2, 1, n, 1).getDisplayValues().forEach(r => {
    const m = String(r[0]).match(/^P(\d+)$/i); if (m) next = Math.max(next, Number(m[1]));
  });
  const id = playerId_(next + 1);
  sh.appendRow([id, name, booker ? 'Yes' : '']);
  return id;
}

function checkNewName_(name, players, selfId) {
  if (!name) throw new Error('Enter a name.');
  if (name.length > 40) throw new Error('Keep names under 40 characters.');
  const clash = players.filter(x => x.id !== selfId && x.name.toLowerCase() === name.toLowerCase())[0];
  if (clash) throw new Error(name + ' is already on the Players list (' + clash.id + '). Add an initial to tell them apart.');
}

/** Rewrite the readable name columns in Bookings and Attendance after a rename. */
function refreshNames_(players) {
  const byId = indexBy_(players, 'id');
  const b = bookingsSheet_();
  const nb = b.getLastRow() - 1;
  if (nb > 0) {
    const ids = b.getRange(2, COL.booker + 1, nb, 2).getDisplayValues();
    const names = ids.map(r => [nameOf_(byId, String(r[0]).trim()), splitIds_(r[1]).map(id => nameOf_(byId, id)).join(', ')]);
    b.getRange(2, COL.bookerName + 1, nb, 2).setValues(names);
  }
  const a = sheet_(ATTENDANCE, ATTENDANCE_HEADER);
  const na = a.getLastRow() - 1;
  if (na > 0) {
    const ids = a.getRange(2, 2, na, 1).getDisplayValues();
    a.getRange(2, 5, na, 1).setValues(ids.map(r => [nameOf_(byId, String(r[0]).trim())]));
  }
}

// ---------- bookings ----------

function bookingsSheet_() {
  const sh = sheet_(BOOKINGS, BOOKINGS_HEADER);
  // Sheets made before "opponents" were renamed "players" get their headings updated once.
  const h = sh.getRange(1, COL.opponents + 1, 1, 3).getDisplayValues()[0];
  if (String(h[0]).trim() === 'Opponents') sh.getRange(1, COL.opponents + 1).setValue('Players');
  if (String(h[2]).trim() === 'Opponent names') sh.getRange(1, COL.opponentNames + 1).setValue('Player names');
  return sh;
}

/**
 * All bookings as plain objects. If a row typed in by hand has names but no IDs, the names are
 * looked up on the Players list. Rows without an ID are given one.
 */
function readBookings_(players) {
  const sh = bookingsSheet_();
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  const byId = indexBy_(players, 'id');
  const byName = {};
  players.forEach(p => { byName[p.name.toLowerCase()] = p.id; });
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

    let bookerId = String(r[COL.booker]).trim().toUpperCase();
    if (!byId[bookerId]) bookerId = byName[cleanName_(r[COL.bookerName]).toLowerCase()] || bookerId;
    let opponentIds = splitIds_(r[COL.opponents]).map(x => x.toUpperCase());
    if (!opponentIds.length && String(r[COL.opponentNames]).trim()) {
      opponentIds = String(r[COL.opponentNames]).split(',').map(x => byName[cleanName_(x).toLowerCase()]).filter(Boolean);
    }
    const st = String(r[COL.status]).trim().toLowerCase();
    const status = opponentIds.length ? CONFIRMED : st.indexOf('prov') === 0 ? PROVISIONAL : st ? CONFIRMED : PROVISIONAL;

    out.push({
      id: id, date: date, court: court, start: start,
      end: fromMin_(toMin_(start) + minutes), minutes: minutes,
      status: status, bookerId: bookerId, opponentIds: opponentIds,
      startsAt: startTime_(date, start),
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

// ---------- attendance ----------

function readAttendance_(players) {
  const sh = sheet_(ATTENDANCE, ATTENDANCE_HEADER);
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  const byId = indexBy_(players, 'id');
  const byName = {};
  players.forEach(p => { byName[p.name.toLowerCase()] = p.id; });
  const out = [];
  sh.getRange(2, 1, n, 5).getDisplayValues().forEach(r => {
    const date = normDate_(r[0]);
    let pid = String(r[1]).trim().toUpperCase();
    if (!byId[pid]) pid = byName[cleanName_(r[4]).toLowerCase()] || '';
    if (!date || !pid) return;
    const s = String(r[2]).trim().toLowerCase().replace(/[\s_]/g, '-');
    const status = /^(attended|yes|present|y)$/.test(s) ? ATTENDED : /^(no-show|noshow|no|absent|n|dns)$/.test(s) ? NO_SHOW : '';
    out.push({ date: date, playerId: pid, status: status, added: isYes_(r[3]) });
  });
  return out;
}

/** No-shows by players named on a booking that session, newest first. One entry per booking. */
function blackMarks_(bookings, att, since) {
  const byDate = {};
  bookings.forEach(b => { (byDate[b.date] = byDate[b.date] || []).push(b); });
  const out = [];
  att.forEach(a => {
    if (a.status !== NO_SHOW || a.date < since) return;
    (byDate[a.date] || []).forEach(b => {
      const role = b.bookerId === a.playerId ? 'booker' : b.opponentIds.indexOf(a.playerId) !== -1 ? 'player' : '';
      if (role) out.push({ date: a.date, playerId: a.playerId, court: b.court, start: b.start, end: b.end, role: role });
    });
  });
  return out.sort((x, y) => (y.date + y.start).localeCompare(x.date + x.start));
}

// ---------- schema & migration ----------

/**
 * Makes sure the Players and Bookings tabs are in the current layout. Converts a sheet from the
 * previous version once: bookers and opponent names become players, and the old Bookings tab is
 * kept as "Bookings (before players)".
 */
function ensureSchema_() {
  const layout = bookingsLayout_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (layout === 'v1') {
    throw new Error('The Bookings tab is in a much older layout. Rename or delete that tab, then reload: the app will create a new one.');
  }
  if (layout === 'current' && ss.getSheetByName(PLAYERS)) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('The sheet is being updated. Try again in a moment.');
  try {
    const now = bookingsLayout_(); // re-check: someone else may have just done it
    if (now === 'current' && ss.getSheetByName(PLAYERS)) return;
    migrate_(now);
    SpreadsheetApp.flush();
  } finally { lock.releaseLock(); }
}

function bookingsLayout_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(BOOKINGS);
  if (!sh || sh.getLastColumn() < 1) return 'none';
  const head = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 6)).getDisplayValues()[0].map(s => String(s).trim().toLowerCase());
  if (head[5] === 'status') return 'current';
  if (head[2] === 'start' && head[5] === 'booker') return 'v2';
  if (sh.getLastRow() <= 1 && !head.join('')) return 'none';
  return 'v1';
}

function migrate_(layout) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const players = ss.getSheetByName(PLAYERS) ? readPlayers_() : [];
  const byName = {};
  players.forEach(p => { byName[p.name.toLowerCase()] = p; });
  let next = 0;
  players.forEach(p => { const m = p.id.match(/^P(\d+)$/); if (m) next = Math.max(next, Number(m[1])); });
  const added = [], makeBooker = [];
  function ensure(name, booker) {
    name = cleanName_(name);
    if (!name) return '';
    const k = name.toLowerCase();
    const p = byName[k];
    if (p) { if (booker && !p.booker) { p.booker = true; if (p.row) makeBooker.push(p.row); } return p.id; }
    const np = { id: playerId_(++next), name: name, booker: !!booker };
    byName[k] = np; players.push(np); added.push(np);
    return np.id;
  }

  // Everyone on the old Bookers list becomes a booker.
  const old = ss.getSheetByName(OLD_BOOKERS);
  if (old && old.getLastRow() > 1) old.getRange(2, 1, old.getLastRow() - 1, 1).getDisplayValues().forEach(r => ensure(r[0], true));

  // Convert the previous Bookings layout (… | Booker | Updated | Updated by | ID | Opponent).
  const rows = [];
  if (layout === 'v2') {
    const sh = ss.getSheetByName(BOOKINGS);
    const n = sh.getLastRow() - 1;
    const vals = n > 0 ? sh.getRange(2, 1, n, 10).getDisplayValues() : [];
    vals.forEach(r => {
      const date = normDate_(r[0]), start = time_(r[2]);
      let minutes = Number(r[4]);
      if (!minutes && start && time_(r[3])) minutes = toMin_(time_(r[3])) - toMin_(start);
      if (!date || !Number(r[1]) || !start || !(minutes > 0)) return;
      const bookerId = ensure(r[5], true);
      const opps = String(r[9] || '').split(/\s*[,;&\/]\s*|\s+and\s+/i).map(cleanName_).filter(Boolean)
        .map(nm => ensure(nm, false)).filter(pid => pid && pid !== bookerId);
      rows.push({ date: date, court: Number(r[1]), start: start, minutes: minutes, bookerId: bookerId,
        opps: opps.slice(0, 3), updated: r[6], by: r[7], id: String(r[8]).trim() || newId_() });
    });
    let backup = BOOKINGS + ' (before players)', k = 2;
    while (ss.getSheetByName(backup)) backup = BOOKINGS + ' (before players ' + (k++) + ')';
    sh.setName(backup);
  }

  // Write the Players tab.
  const psh = playersSheet_();
  makeBooker.forEach(r => psh.getRange(r, 3).setValue('Yes'));
  if (added.length) psh.getRange(psh.getLastRow() + 1, 1, added.length, 3).setValues(added.map(p => [p.id, p.name, p.booker ? 'Yes' : '']));

  // Write the new Bookings tab.
  const bsh = bookingsSheet_();
  if (rows.length) {
    const byId = indexBy_(players, 'id');
    bsh.getRange(2, 1, rows.length, BOOKINGS_HEADER.length).setValues(rows.map(x => [
      x.date, x.court, x.start, fromMin_(toMin_(x.start) + x.minutes), x.minutes,
      x.opps.length ? CONFIRMED : PROVISIONAL, x.bookerId, x.opps.join(', '),
      nameOf_(byId, x.bookerId), x.opps.map(p => nameOf_(byId, p)).join(', '), x.updated, x.by, x.id]));
  }
  sheet_(ATTENDANCE, ATTENDANCE_HEADER);
}

// ---------- settings ----------

function settingsSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SETTINGS);
  if (!sh) {
    sh = ss.insertSheet(SETTINGS, 0);
    sh.getRange(1, 1, 30, 3).setNumberFormat('@'); // keep times and lists as plain text
    sh.getRange(1, 1, DEFAULT_SETTINGS.length, 3).setValues(DEFAULT_SETTINGS);
    sh.getRange('A1:B1').setFontWeight('bold');
    sh.getRange('A8:C8').setFontWeight('bold');
    sh.getRange('E8').setValue('One row per session day. Times are 24-hour hh:mm. The list ends at the first blank row.')
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
    else if (label.indexOf('confirm player') === 0 || label.indexOf('confirm opponent') === 0) found.confirm = [values[i][1], i];
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

  let confirmHours = DEFAULT_CONFIRM_HOURS;
  if (found.confirm && found.confirm[0].trim()) {
    confirmHours = Number(found.confirm[0]);
    if (!(confirmHours >= 0 && confirmHours <= 24 * 14 && Math.floor(confirmHours) === confirmHours)) {
      throw new Error(where('confirm') + ': "Confirm players (hours before)" must be a whole number of hours, e.g. 72.');
    }
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

  return { bookAheadDays: bookAheadDays, courts: courts, lengths: lengths, step: step, confirmHours: confirmHours, sessions: sessions };
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
  ensureSchema_();
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

function sheet_(name, header) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sh.setFrozenRows(1);
    if (name === BOOKINGS) sh.getRange('A:D').setNumberFormat('@');   // dates and times as plain text
    if (name === ATTENDANCE) sh.getRange('A:A').setNumberFormat('@');
  }
  return sh;
}

function indexBy_(list, key) { const o = {}; list.forEach(x => { o[x[key]] = x; }); return o; }
function nameOf_(byId, id) { return byId[id] ? byId[id].name : (id || ''); }
function splitIds_(text) { return String(text || '').split(/[,;\s]+/).map(s => s.trim()).filter(Boolean); }
function cleanName_(s) { return String(s == null ? '' : s).trim().replace(/\s+/g, ' '); }
function isYes_(v) { return /^(yes|y|true|x|✓|1)$/i.test(String(v).trim()); }
function playerId_(n) { return 'P' + String(n).padStart(4, '0'); }
function newId_() { return Utilities.getUuid().slice(0, 8); }

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
/** Milliseconds timestamp of a booking's start, in the club's time zone (handles clock changes). */
function startTime_(ymd, hhmm) { return Utilities.parseDate(ymd + ' ' + hhmm, tz_(), 'yyyy-MM-dd HH:mm').getTime(); }
function utc_(ymd) { const p = String(ymd).split('-').map(Number); return Date.UTC(p[0], p[1] - 1, p[2]); }
function dow_(ymd) { return new Date(utc_(ymd)).getUTCDay(); }
function addDays_(ymd, n) { return new Date(utc_(ymd) + n * 86400000).toISOString().slice(0, 10); }
function daysBetween_(a, b) { return Math.round((utc_(b) - utc_(a)) / 86400000); }
