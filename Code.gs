/**
 * Imprest Management Portal — Backend API (Google Apps Script + Sheets)
 *
 * Storage model (Google Sheets):
 *   One Spreadsheet ("Imprest Portal Data") with three tabs:
 *     Profiles      — one row per employee: [username, json, updatedAt]
 *     Entries       — one row per TI/PI record: [username, id, json, updatedAt]
 *     OtherExpenses — one row per expense: [username, id, json, updatedAt]
 *   Each row's `json` column holds the full serialized object, exactly like
 *   the old profile.json/entries.json/otherExpenses.json files did — this
 *   keeps the schema fluid (new profile/entry fields still persist with NO
 *   migration step, same guarantee apiSaveEmployee's full-object-merge gave
 *   before) while gaining Sheets' visibility, built-in versioning/backup,
 *   and no per-user Drive folder sprawl.
 *   The Spreadsheet's ID is cached in Script Properties after first lookup
 *   so every request doesn't have to search Drive by name.
 *
 * Attachment handling — WHY THIS MATTERS:
 *   Google Sheets enforces a hard 50,000-character limit per cell. Photo/
 *   PDF attachments on transactions are stored by the front-end as base64
 *   data-URLs (tx.image, etc.), which routinely exceed that on their own.
 *   Writing them straight into a Sheets cell would silently corrupt or
 *   throw. So before any record is written, offloadAttachments() walks the
 *   object recursively and moves any base64 data-URL string over
 *   ATTACH_INLINE_LIMIT chars into a small per-user "Imprest Portal
 *   Attachments" Drive folder, replacing it in the JSON with a short
 *   "drive:<fileId>:<mime>" reference. On every read, inflateAttachments()
 *   walks the object back and re-expands those references into full
 *   data-URLs — so the front-end (app.js) receives EXACTLY the same shape
 *   of data it always did and required NO changes for this migration.
 *   Orphaned attachment files (replaced or removed by the user) are
 *   best-effort trashed on overwrite/delete so Drive usage doesn't grow
 *   unbounded.
 *
 * Why GET *and* POST, and why text/plain:
 * Browsers only skip CORS "preflight" for so-called simple requests.
 * A POST with Content-Type: text/plain qualifies as simple, so the
 * front-end always POSTs a JSON string as plain text (see api.js on
 * the front-end side) and this file parses e.postData.contents itself.
 * Reads use GET with a query string for the same reason. This avoids
 * Apps Script's inability to respond to CORS preflight (OPTIONS)
 * requests, which is the most common reason people find Apps Script
 * "doesn't support CORS" — the trick is never triggering a preflight
 * in the first place.
 */

var ROOT_SHEET_NAME = 'Imprest Portal Data';
var ATTACH_FOLDER_NAME = 'Imprest Portal Attachments';

var SHEET_PROFILES = 'Profiles';
var SHEET_ENTRIES = 'Entries';
var SHEET_EXPENSES = 'OtherExpenses';

var SHEET_HEADERS = {
  Profiles: [ 'username', 'json', 'updatedAt' ],
  Entries: [ 'username', 'id', 'json', 'updatedAt' ],
  OtherExpenses: [ 'username', 'id', 'json', 'updatedAt' ],
};

// Leave generous headroom under Sheets' 50,000-char cell cap: this is the
// per-STRING threshold that triggers offload, not the whole-cell size —
// the whole record JSON (dates, amounts, transaction lists, etc. minus any
// offloaded attachments) needs to stay comfortably under the limit too.
var ATTACH_INLINE_LIMIT = 30000;
var DATA_URL_RE = /^data:([^;]+);base64,([\s\S]+)$/;
var DRIVE_REF_PREFIX = 'drive:';

// Legacy admin fallback (kept so an existing deployment doesn't lock you
// out): logging in with these credentials still gets admin rights even
// before you've created a proper admin profile via apiAdminLogin below.
// Prefer creating a normal profile with isAdmin:true instead (see
// apiAdminCreateUser) and changing this password, or removing it once
// you have at least one real admin account.
var ADMIN_USERNAME = 'admin';
var ADMIN_PASSWORD = 'admin123'; // TODO: change this before going live

/* Entry points */

function doGet(e) {
  try {
    var result = route(e.parameter.action, e.parameter);
    return jsonOut(result);
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    var body = {};
    if (e.postData && e.postData.contents) {
      body = JSON.parse(e.postData.contents);
    }
    var result = route(body.action, body.payload || {});
    return jsonOut(result);
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* Router */

function route(action, p) {
  switch (action) {
    case 'adminLogin':      return apiAdminLogin(p.username, p.password);
    case 'register':        return apiRegister(p.username, p.password, p.authMethod);
    case 'login':           return apiLogin(p.username, p.password);
    case 'getEmployee':     return apiGetEmployee(p.username);
    case 'saveEmployee':    return apiSaveEmployee(p.profile);
    case 'listEmployees':   return apiListEmployees();
    case 'approveEmployee': return apiSetStatus(p.username, 'approved');
    case 'revokeEmployee':  return apiSetStatus(p.username, 'pending');
    case 'rejectEmployee':  return apiDeleteEmployee(p.username);
    case 'changeCredentials': return apiChangeCredentials(p.username, p.newUsername, p.newPassword);
    case 'adminCreateUser': return apiAdminCreateUser(p.username, p.password, p.name, p.isAdmin);
    case 'setSecurityQA':   return apiSetSecurityQA(p.username, p.question, p.answer);
    case 'resetWithSecurityAnswer': return apiResetWithSecurityAnswer(p.username, p.answer, p.newPassword);
    case 'getSecurityQuestion': return apiGetSecurityQuestion(p.username);
    case 'rememberDevice':  return apiRememberDevice(p.username);
    case 'loginWithToken':  return apiLoginWithToken(p.username, p.token);

    case 'listEntries':     return apiListEntries(p.username);
    case 'saveEntry':       return apiSaveEntry(p.username, p.entry);
    case 'deleteEntry':     return apiDeleteEntry(p.username, p.id);
    case 'listAllEntries':  return apiListAllEntries();

    case 'listOtherExpenses':  return apiListOtherExpenses(p.username);
    case 'saveOtherExpense':   return apiSaveOtherExpense(p.username, p.expense);
    case 'deleteOtherExpense': return apiDeleteOtherExpense(p.username, p.id);

    default: return { ok: false, error: 'Unknown action: ' + action };
  }
}

/* Spreadsheet / sheet-tab helpers */

function getSpreadsheet() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SPREADSHEET_ID');
  var ss = null;
  if (id) {
    try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; }
  }
  if (!ss) {
    // Script property lost/stale — fall back to searching Drive by name
    // before creating a brand-new spreadsheet.
    var it = DriveApp.getFilesByName(ROOT_SHEET_NAME);
    while (it.hasNext()) {
      var f = it.next();
      if (f.getMimeType() === MimeType.GOOGLE_SHEETS) { ss = SpreadsheetApp.open(f); break; }
    }
  }
  if (!ss) ss = SpreadsheetApp.create(ROOT_SHEET_NAME);
  props.setProperty('SPREADSHEET_ID', ss.getId());
  ensureTabs(ss);
  return ss;
}

function ensureTabs(ss) {
  Object.keys(SHEET_HEADERS).forEach(function (name) {
    var sheet = ss.getSheetByName(name);
    if (!sheet) {
      sheet = ss.insertSheet(name);
      sheet.appendRow(SHEET_HEADERS[name]);
      sheet.setFrozenRows(1);
    } else if (sheet.getLastRow() === 0) {
      sheet.appendRow(SHEET_HEADERS[name]);
      sheet.setFrozenRows(1);
    }
  });
  // Clean up the default blank "Sheet1" Apps Script leaves behind on create.
  var def = ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1 && def.getLastRow() === 0) {
    ss.deleteSheet(def);
  }
}

function getSheet(name) {
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(SHEET_HEADERS[name]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function normKey(s) { return (s || '').toString().trim().toLowerCase(); }

// Serializes read-modify-write sequences so two rapid requests for the
// same user (e.g. a double-click) can't clobber each other's changes.
function withLock(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function hashPassword(pw) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, pw, Utilities.Charset.UTF_8);
  return digest.map(function (b) { return (b < 0 ? b + 256 : b).toString(16).padStart(2, '0'); }).join('');
}

function stripHash(profile) {
  var copy = Object.assign({}, profile);
  delete copy.passwordHash;
  delete copy.securityAnswerHash;
  delete copy.rememberTokenHash;
  return copy;
}

/* Attachment offload / inflate — see file header comment for why. */

function getAttachmentsRootFolder() {
  var it = DriveApp.getFoldersByName(ATTACH_FOLDER_NAME);
  if (it.hasNext()) return it.next();
  return DriveApp.createFolder(ATTACH_FOLDER_NAME);
}

function getAttachmentsFolder(username) {
  var root = getAttachmentsRootFolder();
  var key = normKey(username) || '_unknown';
  var it = root.getFoldersByName(key);
  if (it.hasNext()) return it.next();
  return root.createFolder(key);
}

// Recursively walks obj; any string value that's a base64 data-URL over
// ATTACH_INLINE_LIMIT chars gets saved to Drive and replaced with a short
// "drive:<fileId>:<mime>" reference. Small strings (short data-URLs, plain
// text fields) pass through untouched.
function offloadAttachments(username, obj) {
  if (obj == null) return obj;
  if (Array.isArray(obj)) return obj.map(function (v) { return offloadAttachments(username, v); });
  if (typeof obj === 'object') {
    var out = {};
    Object.keys(obj).forEach(function (k) { out[k] = offloadAttachments(username, obj[k]); });
    return out;
  }
  if (typeof obj === 'string' && obj.length > ATTACH_INLINE_LIMIT) {
    var m = DATA_URL_RE.exec(obj);
    if (m) {
      var mime = m[1];
      var bytes = Utilities.base64Decode(m[2]);
      var blob = Utilities.newBlob(bytes, mime, 'attachment');
      var file = getAttachmentsFolder(username).createFile(blob);
      return DRIVE_REF_PREFIX + file.getId() + ':' + mime;
    }
  }
  return obj;
}

// Recursively walks obj, re-expanding "drive:<fileId>:<mime>" references
// back into full base64 data-URLs by fetching the blob from Drive. If the
// Drive file is missing/inaccessible, leaves the reference string as-is
// rather than throwing, so one bad file can't break a whole record.
function inflateAttachments(obj) {
  if (obj == null) return obj;
  if (Array.isArray(obj)) return obj.map(inflateAttachments);
  if (typeof obj === 'object') {
    var out = {};
    Object.keys(obj).forEach(function (k) { out[k] = inflateAttachments(obj[k]); });
    return out;
  }
  if (typeof obj === 'string' && obj.indexOf(DRIVE_REF_PREFIX) === 0) {
    var rest = obj.slice(DRIVE_REF_PREFIX.length);
    var sep = rest.indexOf(':');
    var fileId = sep === -1 ? rest : rest.slice(0, sep);
    var mime = sep === -1 ? 'application/octet-stream' : rest.slice(sep + 1);
    try {
      var b64 = Utilities.base64Encode(DriveApp.getFileById(fileId).getBlob().getBytes());
      return 'data:' + mime + ';base64,' + b64;
    } catch (e) {
      return obj;
    }
  }
  return obj;
}

// Finds every "drive:<fileId>:<mime>" reference in obj, returns unique file IDs.
function collectDriveRefs(obj, out) {
  out = out || [];
  if (obj == null) return out;
  if (Array.isArray(obj)) { obj.forEach(function (v) { collectDriveRefs(v, out); }); return out; }
  if (typeof obj === 'object') { Object.keys(obj).forEach(function (k) { collectDriveRefs(obj[k], out); }); return out; }
  if (typeof obj === 'string' && obj.indexOf(DRIVE_REF_PREFIX) === 0) {
    var rest = obj.slice(DRIVE_REF_PREFIX.length);
    var sep = rest.indexOf(':');
    var fileId = sep === -1 ? rest : rest.slice(0, sep);
    if (out.indexOf(fileId) === -1) out.push(fileId);
  }
  return out;
}

// Best-effort trash of Drive attachment files that are no longer referenced
// after a record is overwritten or deleted (so Drive usage doesn't grow
// unbounded as users replace/remove attachments).
function trashOrphanedRefs(oldJson, keepIds) {
  if (!oldJson) return;
  var oldObj;
  try { oldObj = JSON.parse(oldJson); } catch (e) { return; }
  var oldIds = collectDriveRefs(oldObj);
  oldIds.forEach(function (id) {
    if (keepIds && keepIds.indexOf(id) !== -1) return;
    try { DriveApp.getFileById(id).setTrashed(true); } catch (e) { /* already gone */ }
  });
}

/* Profiles table (one row per username) */

function findProfileRowIndex(sheet, username) {
  var key = normKey(username);
  if (!key) return -1;
  var last = sheet.getLastRow();
  if (last < 2) return -1;
  var usernames = sheet.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < usernames.length; i++) {
    if (normKey(usernames[i][0]) === key) return i + 2;
  }
  return -1;
}

function readProfileRaw(username) {
  var sheet = getSheet(SHEET_PROFILES);
  var row = findProfileRowIndex(sheet, username);
  if (row === -1) return null;
  var json = sheet.getRange(row, 2).getValue();
  if (!json) return null;
  try { return inflateAttachments(JSON.parse(json)); } catch (e) { return null; }
}

function writeProfileRaw(username, profile) {
  var sheet = getSheet(SHEET_PROFILES);
  var row = findProfileRowIndex(sheet, username);
  var oldJson = row === -1 ? null : sheet.getRange(row, 2).getValue();
  var offloaded = offloadAttachments(username, profile);
  var json = JSON.stringify(offloaded);
  var now = new Date().toISOString();
  if (row === -1) {
    sheet.appendRow([ normKey(username), json, now ]);
  } else {
    sheet.getRange(row, 1, 1, 3).setValues([[ normKey(username), json, now ]]);
  }
  trashOrphanedRefs(oldJson, collectDriveRefs(offloaded));
}

function deleteProfileRaw(username) {
  var sheet = getSheet(SHEET_PROFILES);
  var row = findProfileRowIndex(sheet, username);
  if (row === -1) return;
  var oldJson = sheet.getRange(row, 2).getValue();
  sheet.deleteRow(row);
  trashOrphanedRefs(oldJson, []);
}

function listAllProfilesRaw() {
  var sheet = getSheet(SHEET_PROFILES);
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var values = sheet.getRange(2, 1, last - 1, 2).getValues();
  var out = [];
  values.forEach(function (r) {
    if (!r[1]) return;
    try { out.push(inflateAttachments(JSON.parse(r[1]))); } catch (e) { /* skip corrupt row */ }
  });
  return out;
}

/* Generic keyed table (username + id) — used for Entries and OtherExpenses */

function findRowIndex(sheet, username, id) {
  var ukey = normKey(username), ikey = String(id);
  var last = sheet.getLastRow();
  if (last < 2) return -1;
  var data = sheet.getRange(2, 1, last - 1, 2).getValues();
  for (var i = 0; i < data.length; i++) {
    if (normKey(data[i][0]) === ukey && String(data[i][1]) === ikey) return i + 2;
  }
  return -1;
}

function readRecordsForUser(sheetName, username) {
  var sheet = getSheet(sheetName);
  var ukey = normKey(username);
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var data = sheet.getRange(2, 1, last - 1, 3).getValues(); // username, id, json
  var out = [];
  data.forEach(function (r) {
    if (normKey(r[0]) === ukey && r[2]) {
      try { out.push(inflateAttachments(JSON.parse(r[2]))); } catch (e) { /* skip corrupt row */ }
    }
  });
  return out;
}

function writeRecord(sheetName, username, id, obj) {
  var sheet = getSheet(sheetName);
  var row = findRowIndex(sheet, username, id);
  var oldJson = row === -1 ? null : sheet.getRange(row, 3).getValue();
  var offloaded = offloadAttachments(username, obj);
  var json = JSON.stringify(offloaded);
  var now = new Date().toISOString();
  if (row === -1) {
    sheet.appendRow([ normKey(username), String(id), json, now ]);
  } else {
    sheet.getRange(row, 1, 1, 4).setValues([[ normKey(username), String(id), json, now ]]);
  }
  trashOrphanedRefs(oldJson, collectDriveRefs(offloaded));
}

function deleteRecord(sheetName, username, id) {
  var sheet = getSheet(sheetName);
  var row = findRowIndex(sheet, username, id);
  if (row === -1) return;
  var oldJson = sheet.getRange(row, 3).getValue();
  sheet.deleteRow(row);
  trashOrphanedRefs(oldJson, []);
}

function deleteAllRecordsForUser(sheetName, username) {
  var sheet = getSheet(sheetName);
  var ukey = normKey(username);
  var last = sheet.getLastRow();
  if (last < 2) return;
  var data = sheet.getRange(2, 1, last - 1, 3).getValues();
  for (var i = data.length - 1; i >= 0; i--) {
    if (normKey(data[i][0]) === ukey) {
      trashOrphanedRefs(data[i][2], []);
      sheet.deleteRow(i + 2);
    }
  }
}

function readAllRecordsJoined(sheetName) {
  var sheet = getSheet(sheetName);
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var data = sheet.getRange(2, 1, last - 1, 3).getValues();
  var out = [];
  data.forEach(function (r) {
    if (!r[2]) return;
    try { out.push({ username: r[0], id: r[1], obj: inflateAttachments(JSON.parse(r[2])) }); } catch (e) { /* skip */ }
  });
  return out;
}

function renameUsernameInSheet(sheetName, oldUsername, newUsername) {
  var sheet = getSheet(sheetName);
  var oldKey = normKey(oldUsername), newKey = normKey(newUsername);
  var last = sheet.getLastRow();
  if (last < 2) return;
  var range = sheet.getRange(2, 1, last - 1, 1);
  var values = range.getValues();
  var changed = false;
  for (var i = 0; i < values.length; i++) {
    if (normKey(values[i][0]) === oldKey) { values[i][0] = newKey; changed = true; }
  }
  if (changed) range.setValues(values);
}

/* Admin */

function apiAdminLogin(username, password) {
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    // Auto-provision a real, persistent profile for the built-in admin so it
    // behaves like any other user (own profile, own imprests) plus admin rights.
    return withLock(function () {
      var profile = readProfileRaw(username);
      if (!profile) {
        profile = {
          username: username, passwordHash: hashPassword(password), authMethod: 'local',
          status: 'approved', isAdmin: true,
          name: 'Administrator', designation: '', office: '', letterNo: '',
          sapNo: username, cpfNo: '', pmoNo: '',
          bossName: '', bossDesignation: '', bossOffice: '', bossOrg: 'MSETCL, Nashik', bossSalutation: 'Sir',
          refundAccounts: [], companyAccounts: []
        };
        writeProfileRaw(username, profile);
      }
      return { ok: true, profile: stripHash(profile) };
    });
  }
  return { ok: false, error: 'Incorrect admin credentials.' };
}

/* Employees */

function apiRegister(username, password, authMethod) {
  if (!username || (!password && authMethod !== 'google')) {
    return { ok: false, error: 'Username and password required.' };
  }
  return withLock(function () {
    var existing = readProfileRaw(username);
    if (existing) return { ok: false, error: 'Username already registered.' };
    var profile = {
      username: username.trim(),
      passwordHash: password ? hashPassword(password) : '',
      authMethod: authMethod || 'local',
      status: 'pending',
      name: '', designation: '', office: '', letterNo: '',
      sapNo: username.trim(), cpfNo: '', pmoNo: '',
      bossName: '', bossDesignation: '', bossOffice: '', bossOrg: 'MSETCL, Nashik', bossSalutation: 'Sir',
      refundAccounts: [],
      companyAccounts: [],
    };
    writeProfileRaw(username, profile);
    return { ok: true, profile: stripHash(profile) };
  });
}

function apiLogin(username, password) {
  var profile = readProfileRaw(username);
  if (!profile) {
    // Legacy fallback so an existing deployment isn't locked out while
    // you set up a proper admin profile (see apiAdminCreateUser).
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
      return { ok: true, profile: { username: ADMIN_USERNAME, name: 'Admin', isAdmin: true, status: 'approved' } };
    }
    return { ok: false, error: 'No account found.' };
  }
  if (profile.authMethod === 'google') {
    if (profile.status !== 'approved') return { ok: false, error: 'Awaiting admin approval.' };
    return { ok: true, profile: stripHash(profile) };
  }
  if (profile.passwordHash !== hashPassword(password || '')) {
    return { ok: false, error: 'Incorrect password.' };
  }
  if (profile.status !== 'approved') return { ok: false, error: 'Awaiting admin approval.' };
  return { ok: true, profile: stripHash(profile) };
}

// Admin creates a user directly — no approval step needed, admin sets the
// initial password (or the user changes it after first login from Profile).
function apiAdminCreateUser(username, password, name, isAdmin) {
  if (!username || !password) return { ok: false, error: 'SAP ID and password required.' };
  return withLock(function () {
    var existing = readProfileRaw(username);
    if (existing) return { ok: false, error: 'That SAP ID is already registered.' };
    var profile = {
      username: username.trim(),
      passwordHash: hashPassword(password),
      authMethod: 'local',
      status: 'approved',
      isAdmin: !!isAdmin,
      name: name || '', designation: '', office: '', letterNo: '',
      sapNo: username.trim(), cpfNo: '', pmoNo: '',
      bossName: '', bossDesignation: '', bossOffice: '', bossOrg: 'MSETCL, Nashik', bossSalutation: 'Sir',
      refundAccounts: [],
      companyAccounts: [],
    };
    writeProfileRaw(username, profile);
    return { ok: true, profile: stripHash(profile) };
  });
}

// Self-service "forgot password": a security question set up in advance
// (Profile page) lets a locked-out user reset their own password without
// admin help. The answer is stored hashed, same as the password.
function apiSetSecurityQA(username, question, answer) {
  if (!username || !question || !answer) return { ok: false, error: 'Question and answer required.' };
  return withLock(function () {
    var profile = readProfileRaw(username);
    if (!profile) return { ok: false, error: 'Account not found.' };
    profile.securityQuestion = question;
    profile.securityAnswerHash = hashPassword(answer.trim().toLowerCase());
    writeProfileRaw(username, profile);
    return { ok: true };
  });
}

function apiGetSecurityQuestion(username) {
  var profile = readProfileRaw(username);
  if (!profile || !profile.securityQuestion) return { ok: false, error: 'No security question set for this account — ask your admin to reset your password instead.' };
  return { ok: true, question: profile.securityQuestion };
}

function apiResetWithSecurityAnswer(username, answer, newPassword) {
  if (!username || !answer || !newPassword) return { ok: false, error: 'Missing fields.' };
  return withLock(function () {
    var profile = readProfileRaw(username);
    if (!profile || !profile.securityAnswerHash) return { ok: false, error: 'No security question set for this account.' };
    if (profile.securityAnswerHash !== hashPassword(answer.trim().toLowerCase())) {
      return { ok: false, error: 'That answer doesn\'t match.' };
    }
    profile.passwordHash = hashPassword(newPassword);
    writeProfileRaw(username, profile);
    return { ok: true };
  });
}

// "Remember this device": issues a random long-lived token, stored hashed
// against the profile, and returned once to the client to keep in
// localStorage. loginWithToken re-authenticates using that token instead
// of a password. Not a substitute for real session security on a
// shared/public device, but reasonable for an officer's own machine.
function apiRememberDevice(username) {
  return withLock(function () {
    var profile = readProfileRaw(username);
    if (!profile) return { ok: false, error: 'Account not found.' };
    var token = Utilities.getUuid() + '-' + Utilities.getUuid();
    profile.rememberTokenHash = hashPassword(token);
    writeProfileRaw(username, profile);
    return { ok: true, token: token };
  });
}

function apiLoginWithToken(username, token) {
  var profile = readProfileRaw(username);
  if (!profile || !profile.rememberTokenHash) return { ok: false, error: 'Device not remembered.' };
  if (profile.rememberTokenHash !== hashPassword(token || '')) return { ok: false, error: 'Device not remembered.' };
  if (profile.status !== 'approved') return { ok: false, error: 'Awaiting admin approval.' };
  return { ok: true, profile: stripHash(profile) };
}

function apiGetEmployee(username) {
  var profile = readProfileRaw(username);
  if (!profile) return { ok: false, error: 'Not found.' };
  return { ok: true, profile: stripHash(profile) };
}

function apiSaveEmployee(profile) {
  if (!profile || !profile.username) return { ok: false, error: 'Missing profile/username.' };
  return withLock(function () {
    var existing = readProfileRaw(profile.username) || {};
    var merged = Object.assign({}, existing, profile);
    delete merged.password; // never store plain password
    if (!merged.passwordHash) merged.passwordHash = existing.passwordHash || '';
    writeProfileRaw(profile.username, merged);
    return { ok: true, profile: stripHash(merged) };
  });
}

function apiListEmployees() {
  return { ok: true, employees: listAllProfilesRaw().map(stripHash) };
}

function apiSetStatus(username, status) {
  return withLock(function () {
    var profile = readProfileRaw(username);
    if (!profile) return { ok: false, error: 'Not found.' };
    profile.status = status;
    writeProfileRaw(username, profile);
    return { ok: true };
  });
}

function apiDeleteEmployee(username) {
  return withLock(function () {
    deleteProfileRaw(username);
    deleteAllRecordsForUser(SHEET_ENTRIES, username);
    deleteAllRecordsForUser(SHEET_EXPENSES, username);
    return { ok: true };
  });
}

function apiChangeCredentials(username, newUsername, newPassword) {
  return withLock(function () {
    var profile = readProfileRaw(username);
    if (!profile) return { ok: false, error: 'Account not found.' };

    if (newPassword) profile.passwordHash = hashPassword(newPassword);

    if (newUsername && normKey(newUsername) !== normKey(username)) {
      if (readProfileRaw(newUsername)) return { ok: false, error: 'That username is already taken.' };
      profile.username = newUsername.trim();
      // Rename across all three tabs so listEntries/listOtherExpenses
      // lookups by the new username keep finding this person's records
      // (previously a single Drive-folder rename did this implicitly).
      deleteProfileRaw(username);
      writeProfileRaw(newUsername, profile);
      renameUsernameInSheet(SHEET_ENTRIES, username, newUsername);
      renameUsernameInSheet(SHEET_EXPENSES, username, newUsername);
      return { ok: true, profile: stripHash(profile) };
    }
    writeProfileRaw(username, profile);
    return { ok: true, profile: stripHash(profile) };
  });
}

function apiListAllEntries() {
  var profiles = {};
  listAllProfilesRaw().forEach(function (p) { profiles[normKey(p.username)] = p; });
  var all = [];
  readAllRecordsJoined(SHEET_ENTRIES).forEach(function (r) {
    var p = profiles[normKey(r.username)];
    var entry = r.obj;
    entry._owner = p ? p.username : r.username;
    entry._ownerName = (p && p.name) || (p && p.username) || r.username;
    all.push(entry);
  });
  return { ok: true, entries: all };
}

/* Entries (TI/PI records) */

function apiListEntries(username) {
  return { ok: true, entries: readRecordsForUser(SHEET_ENTRIES, username) };
}

function apiSaveEntry(username, entry) {
  if (!username || !entry || !entry.id) return { ok: false, error: 'Missing username/entry.' };
  return withLock(function () {
    writeRecord(SHEET_ENTRIES, username, entry.id, entry);
    return { ok: true };
  });
}

function apiDeleteEntry(username, id) {
  return withLock(function () {
    deleteRecord(SHEET_ENTRIES, username, id);
    return { ok: true };
  });
}

/* Other Expenses (standalone pool) */

function apiListOtherExpenses(username) {
  return { ok: true, expenses: readRecordsForUser(SHEET_EXPENSES, username) };
}

function apiSaveOtherExpense(username, expense) {
  if (!username || !expense || !expense.id) return { ok: false, error: 'Missing username/expense.' };
  return withLock(function () {
    writeRecord(SHEET_EXPENSES, username, expense.id, expense);
    return { ok: true };
  });
}

function apiDeleteOtherExpense(username, id) {
  return withLock(function () {
    deleteRecord(SHEET_EXPENSES, username, id);
    return { ok: true };
  });
}

/* One-time setup helper.
 * Run this once from the Apps Script editor (select it in the function
 * dropdown, click Run) to create the Spreadsheet and its tabs up front,
 * and authorize Sheets/Drive access. Not strictly required — the API
 * creates the spreadsheet automatically on first real request too — but
 * running it once means you can go find it in Drive right away and
 * confirm everything's pointed at the right place.
 */
function setupInitialData() {
  var ss = getSpreadsheet();
  Logger.log('Spreadsheet ready: ' + ss.getName() + ' (' + ss.getUrl() + ')');
}

/* ---------------------------------------------------------------------
 * ONE-TIME MIGRATION from the old Drive-JSON-file storage model.
 * Run this ONCE from the Apps Script editor after deploying this version,
 * BEFORE removing the old "Imprest Portal Data" Drive folder. It reads
 * every employee's profile.json/entries.json/otherExpenses.json from the
 * old per-user Drive folders and writes them into the new Sheets tabs
 * (offloading any large embedded attachments to Drive references exactly
 * as writeProfileRaw/writeRecord do for new writes). Safe to re-run; it
 * skips profiles that already exist in the new Sheets store, so a partial
 * failure can just be re-run without duplicating data.
 * ------------------------------------------------------------------- */
function migrateFromOldDriveJsonStorage() {
  var OLD_ROOT_FOLDER_NAME = 'Imprest Portal Data';
  var oldRootIt = DriveApp.getFoldersByName(OLD_ROOT_FOLDER_NAME);
  if (!oldRootIt.hasNext()) { Logger.log('No old Drive folder found — nothing to migrate.'); return; }
  var oldRoot = oldRootIt.next();

  function readOldJsonFile(folder, filename, fallback) {
    var it = folder.getFilesByName(filename);
    if (!it.hasNext()) return fallback;
    try {
      var text = it.next().getBlob().getDataAsString();
      return text ? JSON.parse(text) : fallback;
    } catch (e) { return fallback; }
  }

  var migrated = 0, skipped = 0;
  var folders = oldRoot.getFolders();
  while (folders.hasNext()) {
    var folder = folders.next();
    var username = folder.getName();
    if (readProfileRaw(username)) { skipped++; continue; } // already migrated

    var profile = readOldJsonFile(folder, 'profile.json', null);
    if (!profile) continue;
    writeProfileRaw(username, profile);

    var entries = readOldJsonFile(folder, 'entries.json', {});
    Object.keys(entries).forEach(function (id) { writeRecord(SHEET_ENTRIES, username, id, entries[id]); });

    var expenses = readOldJsonFile(folder, 'otherExpenses.json', {});
    Object.keys(expenses).forEach(function (id) { writeRecord(SHEET_EXPENSES, username, id, expenses[id]); });

    migrated++;
  }
  Logger.log('Migration done. Migrated ' + migrated + ' employee(s), skipped ' + skipped + ' already present. ' +
    'Verify data in the new "' + ROOT_SHEET_NAME + '" spreadsheet, then you can trash the old "' + OLD_ROOT_FOLDER_NAME + '" Drive folder.');
}
