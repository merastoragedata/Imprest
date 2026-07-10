/**
 * Imprest Management Portal — Backend API (Google Apps Script + Drive)
 *
 * Storage model: one root folder ("Imprest Portal Data"), with one
 * subfolder per employee (named by their username). Inside each
 * employee's folder:
 *   profile.json         — their employee profile
 *   entries.json          — { entryId: entryObject, ... }  (all TI/PI records)
 *   otherExpenses.json    — { expenseId: expenseObject, ... }
 *
 * This is deliberately the same per-user folder structure discussed
 * for storing generated letters/vouchers/Form-2 Docs later — those
 * will live alongside these JSON files in the same employee folder,
 * so everything for one person sits in one place.
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

var ROOT_FOLDER_NAME = 'Imprest Portal Data';

// Legacy admin fallback (kept so an existing deployment doesn't lock you
// out): logging in with these credentials still gets admin rights even
// before you've created a proper admin profile via apiAdminLogin below.
// Prefer creating a normal profile with isAdmin:true instead (see
// apiAdminCreateUser) and changing this password, or removing it once
// you have at least one real admin account.
var ADMIN_USERNAME = 'admin';
var ADMIN_PASSWORD = 'admin123'; // TODO: change this before going live

var FILES = {
  PROFILE: 'profile.json',
  ENTRIES: 'entries.json',
  OTHER_EXPENSES: 'otherExpenses.json',
};

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

/* Drive folder / file helpers */

function getRootFolder() {
  var it = DriveApp.getFoldersByName(ROOT_FOLDER_NAME);
  if (it.hasNext()) return it.next();
  return DriveApp.createFolder(ROOT_FOLDER_NAME);
}

function getUserFolder(username, createIfMissing) {
  var key = (username || '').trim().toLowerCase();
  if (!key) return null;
  var root = getRootFolder();
  var it = root.getFoldersByName(key);
  if (it.hasNext()) return it.next();
  if (!createIfMissing) return null;
  return root.createFolder(key);
}

function readJsonFile(folder, filename, fallback) {
  var it = folder.getFilesByName(filename);
  if (!it.hasNext()) return fallback;
  var file = it.next();
  try {
    var text = file.getBlob().getDataAsString();
    return text ? JSON.parse(text) : fallback;
  } catch (e) {
    return fallback;
  }
}

function writeJsonFile(folder, filename, obj) {
  var it = folder.getFilesByName(filename);
  var content = JSON.stringify(obj);
  if (it.hasNext()) {
    it.next().setContent(content);
  } else {
    folder.createFile(filename, content, MimeType.PLAIN_TEXT);
  }
}

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

/* Admin */

function apiAdminLogin(username, password) {
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    return { ok: true };
  }
  return { ok: false, error: 'Incorrect admin credentials.' };
}

/* Employees */

function apiRegister(username, password, authMethod) {
  if (!username || (!password && authMethod !== 'google')) {
    return { ok: false, error: 'Username and password required.' };
  }
  return withLock(function () {
    var existing = getUserFolder(username, false);
    if (existing) return { ok: false, error: 'Username already registered.' };
    var folder = getUserFolder(username, true);
    var profile = {
      username: username.trim(),
      passwordHash: password ? hashPassword(password) : '',
      authMethod: authMethod || 'local',
      status: 'pending',
      name: '', designation: '', office: '', letterNo: '',
      sapNo: username.trim(), cpfNo: '', pmoNo: '',
      bossName: '', bossDesignation: '', bossOffice: '', bossOrg: 'MSETCL, Nashik', bossSalutation: 'Sir',
      refundAccounts: [],
    };
    writeJsonFile(folder, FILES.PROFILE, profile);
    return { ok: true, profile: stripHash(profile) };
  });
}

function apiLogin(username, password) {
  var folder = getUserFolder(username, false);
  if (!folder) {
    // Legacy fallback so an existing deployment isn't locked out while
    // you set up a proper admin profile (see apiAdminCreateUser).
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
      return { ok: true, profile: { username: ADMIN_USERNAME, name: 'Admin', isAdmin: true, status: 'approved' } };
    }
    return { ok: false, error: 'No account found.' };
  }
  var profile = readJsonFile(folder, FILES.PROFILE, null);
  if (!profile) return { ok: false, error: 'No account found.' };
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
    var existing = getUserFolder(username, false);
    if (existing) return { ok: false, error: 'That SAP ID is already registered.' };
    var folder = getUserFolder(username, true);
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
    };
    writeJsonFile(folder, FILES.PROFILE, profile);
    return { ok: true, profile: stripHash(profile) };
  });
}

// Self-service "forgot password": a security question set up in advance
// (Profile page) lets a locked-out user reset their own password without
// admin help. The answer is stored hashed, same as the password.
function apiSetSecurityQA(username, question, answer) {
  if (!username || !question || !answer) return { ok: false, error: 'Question and answer required.' };
  return withLock(function () {
    var folder = getUserFolder(username, false);
    if (!folder) return { ok: false, error: 'Account not found.' };
    var profile = readJsonFile(folder, FILES.PROFILE, null);
    if (!profile) return { ok: false, error: 'Account not found.' };
    profile.securityQuestion = question;
    profile.securityAnswerHash = hashPassword(answer.trim().toLowerCase());
    writeJsonFile(folder, FILES.PROFILE, profile);
    return { ok: true };
  });
}

function apiGetSecurityQuestion(username) {
  var folder = getUserFolder(username, false);
  if (!folder) return { ok: false, error: 'Account not found.' };
  var profile = readJsonFile(folder, FILES.PROFILE, null);
  if (!profile || !profile.securityQuestion) return { ok: false, error: 'No security question set for this account — ask your admin to reset your password instead.' };
  return { ok: true, question: profile.securityQuestion };
}

function apiResetWithSecurityAnswer(username, answer, newPassword) {
  if (!username || !answer || !newPassword) return { ok: false, error: 'Missing fields.' };
  return withLock(function () {
    var folder = getUserFolder(username, false);
    if (!folder) return { ok: false, error: 'Account not found.' };
    var profile = readJsonFile(folder, FILES.PROFILE, null);
    if (!profile || !profile.securityAnswerHash) return { ok: false, error: 'No security question set for this account.' };
    if (profile.securityAnswerHash !== hashPassword(answer.trim().toLowerCase())) {
      return { ok: false, error: 'That answer doesn\'t match.' };
    }
    profile.passwordHash = hashPassword(newPassword);
    writeJsonFile(folder, FILES.PROFILE, profile);
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
    var folder = getUserFolder(username, false);
    if (!folder) return { ok: false, error: 'Account not found.' };
    var profile = readJsonFile(folder, FILES.PROFILE, null);
    if (!profile) return { ok: false, error: 'Account not found.' };
    var token = Utilities.getUuid() + '-' + Utilities.getUuid();
    profile.rememberTokenHash = hashPassword(token);
    writeJsonFile(folder, FILES.PROFILE, profile);
    return { ok: true, token: token };
  });
}

function apiLoginWithToken(username, token) {
  var folder = getUserFolder(username, false);
  if (!folder) return { ok: false, error: 'No account found.' };
  var profile = readJsonFile(folder, FILES.PROFILE, null);
  if (!profile || !profile.rememberTokenHash) return { ok: false, error: 'Device not remembered.' };
  if (profile.rememberTokenHash !== hashPassword(token || '')) return { ok: false, error: 'Device not remembered.' };
  if (profile.status !== 'approved') return { ok: false, error: 'Awaiting admin approval.' };
  return { ok: true, profile: stripHash(profile) };
}

function apiGetEmployee(username) {
  var folder = getUserFolder(username, false);
  if (!folder) return { ok: false, error: 'Not found.' };
  var profile = readJsonFile(folder, FILES.PROFILE, null);
  if (!profile) return { ok: false, error: 'Not found.' };
  return { ok: true, profile: stripHash(profile) };
}

function apiSaveEmployee(profile) {
  if (!profile || !profile.username) return { ok: false, error: 'Missing profile/username.' };
  return withLock(function () {
    var folder = getUserFolder(profile.username, true);
    var existing = readJsonFile(folder, FILES.PROFILE, {});
    var merged = Object.assign({}, existing, profile);
    delete merged.password; // never store plain password
    if (!merged.passwordHash) merged.passwordHash = existing.passwordHash || '';
    writeJsonFile(folder, FILES.PROFILE, merged);
    return { ok: true, profile: stripHash(merged) };
  });
}

function apiListEmployees() {
  var root = getRootFolder();
  var folders = root.getFolders();
  var employees = [];
  while (folders.hasNext()) {
    var folder = folders.next();
    var profile = readJsonFile(folder, FILES.PROFILE, null);
    if (profile) employees.push(stripHash(profile));
  }
  return { ok: true, employees: employees };
}

function apiSetStatus(username, status) {
  return withLock(function () {
    var folder = getUserFolder(username, false);
    if (!folder) return { ok: false, error: 'Not found.' };
    var profile = readJsonFile(folder, FILES.PROFILE, null);
    if (!profile) return { ok: false, error: 'Not found.' };
    profile.status = status;
    writeJsonFile(folder, FILES.PROFILE, profile);
    return { ok: true };
  });
}

function apiDeleteEmployee(username) {
  var folder = getUserFolder(username, false);
  if (folder) folder.setTrashed(true);
  return { ok: true };
}

function apiChangeCredentials(username, newUsername, newPassword) {
  return withLock(function () {
    var folder = getUserFolder(username, false);
    if (!folder) return { ok: false, error: 'Account not found.' };
    var profile = readJsonFile(folder, FILES.PROFILE, null);
    if (!profile) return { ok: false, error: 'Account not found.' };

    if (newPassword) profile.passwordHash = hashPassword(newPassword);

    if (newUsername && newUsername.trim().toLowerCase() !== username.trim().toLowerCase()) {
      var targetKey = newUsername.trim().toLowerCase();
      if (getUserFolder(targetKey, false)) return { ok: false, error: 'That username is already taken.' };
      // Rename the Drive folder and update the stored username.
      profile.username = newUsername.trim();
      folder.setName(targetKey);
    }
    writeJsonFile(folder, FILES.PROFILE, profile);
    return { ok: true, profile: stripHash(profile) };
  });
}

function apiListAllEntries() {
  var root = getRootFolder();
  var folders = root.getFolders();
  var all = [];
  while (folders.hasNext()) {
    var folder = folders.next();
    var profile = readJsonFile(folder, FILES.PROFILE, null);
    if (!profile) continue;
    var map = readJsonFile(folder, FILES.ENTRIES, {});
    Object.keys(map).forEach(function (k) {
      var entry = map[k];
      entry._owner = profile.username;
      entry._ownerName = profile.name || profile.username;
      all.push(entry);
    });
  }
  return { ok: true, entries: all };
}

/* Entries (TI/PI records) */

function apiListEntries(username) {
  var folder = getUserFolder(username, false);
  if (!folder) return { ok: true, entries: [] };
  var map = readJsonFile(folder, FILES.ENTRIES, {});
  return { ok: true, entries: Object.keys(map).map(function (k) { return map[k]; }) };
}

function apiSaveEntry(username, entry) {
  if (!username || !entry || !entry.id) return { ok: false, error: 'Missing username/entry.' };
  return withLock(function () {
    var folder = getUserFolder(username, true);
    var map = readJsonFile(folder, FILES.ENTRIES, {});
    map[entry.id] = entry;
    writeJsonFile(folder, FILES.ENTRIES, map);
    return { ok: true };
  });
}

function apiDeleteEntry(username, id) {
  return withLock(function () {
    var folder = getUserFolder(username, false);
    if (!folder) return { ok: true };
    var map = readJsonFile(folder, FILES.ENTRIES, {});
    delete map[id];
    writeJsonFile(folder, FILES.ENTRIES, map);
    return { ok: true };
  });
}

/* Other Expenses (standalone pool) */

function apiListOtherExpenses(username) {
  var folder = getUserFolder(username, false);
  if (!folder) return { ok: true, expenses: [] };
  var map = readJsonFile(folder, FILES.OTHER_EXPENSES, {});
  return { ok: true, expenses: Object.keys(map).map(function (k) { return map[k]; }) };
}

function apiSaveOtherExpense(username, expense) {
  if (!username || !expense || !expense.id) return { ok: false, error: 'Missing username/expense.' };
  return withLock(function () {
    var folder = getUserFolder(username, true);
    var map = readJsonFile(folder, FILES.OTHER_EXPENSES, {});
    map[expense.id] = expense;
    writeJsonFile(folder, FILES.OTHER_EXPENSES, map);
    return { ok: true };
  });
}

function apiDeleteOtherExpense(username, id) {
  return withLock(function () {
    var folder = getUserFolder(username, false);
    if (!folder) return { ok: true };
    var map = readJsonFile(folder, FILES.OTHER_EXPENSES, {});
    delete map[id];
    writeJsonFile(folder, FILES.OTHER_EXPENSES, map);
    return { ok: true };
  });
}

/* One-time setup helper.
 * Run this once from the Apps Script editor (select it in the function
 * dropdown, click Run) to create the root Drive folder up front, and
 * authorize Drive access. Not strictly required — the API creates the
 * root folder automatically on first real request too — but running
 * it once means you can go find the folder in Drive right away and
 * confirm everything's pointed at the right place.
 */
function setupInitialData() {
  var root = getRootFolder();
  Logger.log('Root folder ready: ' + root.getName() + ' (' + root.getUrl() + ')');
}
