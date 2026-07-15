/**
 * Attendance — backend.
 *
 * This turns one Google Sheet into a small JSON API. Deploy it as a Web App
 * (Deploy > New deployment > Web app > Execute as: Me > Access: Anyone) and
 * paste the resulting /exec URL into www/index.html as API_URL.
 *
 * Run setup() once from the editor before deploying: it creates the tabs and
 * the Drive folder for check-in photos.
 */

var SHEET_ID = '';        // leave blank to use the sheet this script is bound to
var PHOTO_FOLDER = 'Attendance photos';

function ss_() {
  return SHEET_ID ? SpreadsheetApp.openById(SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
}

var TABS = {
  Campuses: ['id', 'name', 'lat', 'lng', 'radius'],
  Users: ['username', 'name', 'role', 'campus', 'pinHash'],
  TeacherAttendance: ['date', 'username', 'name', 'campus', 'inTime', 'inTs', 'late',
    'inLat', 'inLng', 'inAway', 'inPhoto', 'outTime', 'outTs', 'outLat', 'outLng', 'outAway'],
  StudentAttendance: ['date', 'campus', 'present', 'total', 'by', 'ts'],
  Settings: ['key', 'value']
};

/** Run this once, by hand, from the Apps Script editor. */
function setup() {
  var s = ss_();
  Object.keys(TABS).forEach(function (name) {
    var sh = s.getSheetByName(name) || s.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.appendRow(TABS[name]);
      sh.setFrozenRows(1);
    }
  });
  var set = s.getSheetByName('Settings');
  if (set.getLastRow() < 2) {
    set.appendRow(['lateTime', '08:15']);
    set.appendRow(['defaultRadius', '200']);
    set.appendRow(['setupDone', 'false']);
  }
  var camp = s.getSheetByName('Campuses');
  if (camp.getLastRow() < 2) {
    for (var i = 1; i <= 4; i++) camp.appendRow(['c' + i, 'Campus ' + i, '', '', '']);
  }
  folder_();
  var def = s.getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0) s.deleteSheet(def);
  return 'Ready. Now deploy as a web app.';
}

function folder_() {
  var it = DriveApp.getFoldersByName(PHOTO_FOLDER);
  return it.hasNext() ? it.next() : DriveApp.createFolder(PHOTO_FOLDER);
}

/* ── sheet helpers ─────────────────────────────────────────────────────── */

function rows_(name) {
  var sh = ss_().getSheetByName(name);
  var v = sh.getDataRange().getValues();
  if (v.length < 2) return [];
  var head = v[0];
  return v.slice(1).map(function (r, i) {
    var o = { _row: i + 2 };
    head.forEach(function (h, j) { o[h] = r[j]; });
    return o;
  });
}

function append_(name, obj) {
  var sh = ss_().getSheetByName(name);
  sh.appendRow(TABS[name].map(function (h) {
    var v = obj[h];
    return v === undefined || v === null ? '' : v;
  }));
}

function update_(name, row, obj) {
  var sh = ss_().getSheetByName(name);
  TABS[name].forEach(function (h, i) {
    if (obj[h] !== undefined) sh.getRange(row, i + 1).setValue(obj[h]);
  });
}

function settings_() {
  var o = {};
  rows_('Settings').forEach(function (r) { o[r.key] = String(r.value); });
  return {
    lateTime: o.lateTime || '08:15',
    defaultRadius: parseInt(o.defaultRadius, 10) || 200,
    setupDone: o.setupDone === 'true'
  };
}

function setSetting_(k, v) {
  var sh = ss_().getSheetByName('Settings');
  var found = rows_('Settings').filter(function (r) { return r.key === k; })[0];
  if (found) sh.getRange(found._row, 2).setValue(String(v));
  else sh.appendRow([k, String(v)]);
}

function hash_(pin) {
  var b = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'att:' + pin);
  return b.map(function (x) { return ((x & 0xff) + 256).toString(16).slice(1); }).join('');
}

function campuses_() {
  return rows_('Campuses').map(function (c) {
    return {
      id: c.id, name: c.name,
      lat: c.lat === '' ? null : Number(c.lat),
      lng: c.lng === '' ? null : Number(c.lng),
      radius: c.radius === '' ? null : Number(c.radius)
    };
  });
}

function users_(withHash) {
  return rows_('Users').map(function (u) {
    var o = { u: String(u.username), name: u.name, role: u.role, campus: u.campus || null };
    if (withHash) o.pinHash = u.pinHash;
    return o;
  });
}

/* ── entry points ──────────────────────────────────────────────────────── */

function doGet() {
  return ContentService.createTextOutput('Attendance API is running.');
}

function doPost(e) {
  var out;
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    var body = JSON.parse(e.postData.contents);
    out = { ok: true, data: route_(body.action, body) };
  } catch (err) {
    out = { ok: false, error: String(err.message || err) };
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

function route_(action, p) {
  switch (action) {
    case 'bootstrap':   return bootstrap_();
    case 'login':       return login_(p);
    case 'createAdmin': return createAdmin_(p);
    case 'addUser':     return addUser_(p);
    case 'removeUser':  return removeUser_(p);
    case 'saveCampuses':return saveCampuses_(p);
    case 'saveSettings':return saveSettings_(p);
    case 'checkIn':     return checkIn_(p);
    case 'checkOut':    return checkOut_(p);
    case 'saveStudent': return saveStudent_(p);
    case 'day':         return day_(p);
    case 'history':     return history_(p);
    case 'exportMonth': return exportMonth_(p);
    default: throw new Error('Unknown action: ' + action);
  }
}

/* ── actions ───────────────────────────────────────────────────────────── */

function bootstrap_() {
  var st = settings_();
  return { setupDone: st.setupDone, lateTime: st.lateTime, defaultRadius: st.defaultRadius,
           campuses: campuses_() };
}

function login_(p) {
  var u = String(p.u || '').trim().toLowerCase();
  var h = hash_(String(p.pin || '').trim());
  var found = users_(true).filter(function (x) {
    return String(x.u).toLowerCase() === u && x.pinHash === h;
  })[0];
  if (!found) throw new Error('Incorrect username or PIN.');
  delete found.pinHash;
  return { user: found, campuses: campuses_(), settings: settings_(),
           users: users_(false) };
}

function createAdmin_(p) {
  if (settings_().setupDone) throw new Error('Setup has already been completed.');
  var u = String(p.u || '').trim().toLowerCase();
  if (!u) throw new Error('Enter a username.');
  if (!/^\d{4,8}$/.test(String(p.pin))) throw new Error('PIN must be 4-8 digits.');
  append_('Users', { username: u, name: p.name || 'Admin', role: 'admin',
                     campus: '', pinHash: hash_(String(p.pin)) });
  setSetting_('setupDone', 'true');
  return { user: { u: u, name: p.name || 'Admin', role: 'admin', campus: null },
           campuses: campuses_(), settings: settings_(), users: users_(false) };
}

function addUser_(p) {
  var u = String(p.u || '').trim().toLowerCase();
  if (!p.name || !u) throw new Error('Name and username are both required.');
  if (!/^\d{4,8}$/.test(String(p.pin))) throw new Error('PIN must be 4-8 digits.');
  if (users_(false).some(function (x) { return String(x.u).toLowerCase() === u; }))
    throw new Error('That username already exists.');
  if (p.role === 'teacher' && !p.campus) throw new Error('Teachers must be assigned a campus.');
  append_('Users', { username: u, name: p.name, role: p.role,
                     campus: p.campus || '', pinHash: hash_(String(p.pin)) });
  return { users: users_(false) };
}

function removeUser_(p) {
  var target = String(p.u || '').toLowerCase();
  var found = rows_('Users').filter(function (x) {
    return String(x.username).toLowerCase() === target;
  })[0];
  if (!found) throw new Error('That user no longer exists.');
  if (found.role === 'admin') throw new Error('Admin accounts cannot be removed.');
  ss_().getSheetByName('Users').deleteRow(found._row);
  return { users: users_(false) };
}

function saveCampuses_(p) {
  (p.campuses || []).forEach(function (c) {
    var found = rows_('Campuses').filter(function (x) { return x.id === c.id; })[0];
    var rec = { id: c.id, name: c.name,
                lat: c.lat === null ? '' : c.lat,
                lng: c.lng === null ? '' : c.lng,
                radius: c.radius === null ? '' : c.radius };
    if (found) update_('Campuses', found._row, rec); else append_('Campuses', rec);
  });
  return { campuses: campuses_() };
}

function saveSettings_(p) {
  if (p.lateTime) setSetting_('lateTime', p.lateTime);
  if (p.defaultRadius) setSetting_('defaultRadius', p.defaultRadius);
  return { settings: settings_() };
}

function savePhoto_(b64, label) {
  if (!b64) return '';
  try {
    var blob = Utilities.newBlob(Utilities.base64Decode(b64), 'image/jpeg', label + '.jpg');
    var f = folder_().createFile(blob);
    f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return f.getUrl();
  } catch (err) {
    return '';
  }
}

function mins_(hhmm) {
  var p = String(hhmm).split(':');
  return parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
}

function checkIn_(p) {
  var date = p.date, u = String(p.u).toLowerCase();
  var dup = rows_('TeacherAttendance').filter(function (r) {
    return r.date === date && String(r.username).toLowerCase() === u;
  })[0];
  if (dup) return { duplicate: true };
  var photo = savePhoto_(p.photo, date + '-' + u + '-in');
  append_('TeacherAttendance', {
    date: date, username: u, name: p.name, campus: p.campus,
    inTime: p.time, inTs: p.ts, late: mins_(p.time) > mins_(settings_().lateTime),
    inLat: p.lat, inLng: p.lng, inAway: p.away === null ? '' : p.away, inPhoto: photo
  });
  return { saved: true };
}

function checkOut_(p) {
  var date = p.date, u = String(p.u).toLowerCase();
  var rec = rows_('TeacherAttendance').filter(function (r) {
    return r.date === date && String(r.username).toLowerCase() === u;
  })[0];
  if (!rec) throw new Error('Check in first.');
  if (rec.outTs) return { duplicate: true };
  update_('TeacherAttendance', rec._row, {
    outTime: p.time, outTs: p.ts, outLat: p.lat, outLng: p.lng,
    outAway: p.away === null ? '' : p.away
  });
  return { saved: true };
}

function saveStudent_(p) {
  var found = rows_('StudentAttendance').filter(function (r) {
    return r.date === p.date && r.campus === p.campus;
  })[0];
  var rec = { date: p.date, campus: p.campus, present: p.present, total: p.total,
              by: p.by, ts: p.ts };
  if (found) update_('StudentAttendance', found._row, rec);
  else append_('StudentAttendance', rec);
  return { saved: true };
}

function day_(p) {
  var d = p.date;
  var teach = rows_('TeacherAttendance').filter(function (r) { return r.date === d; })
    .map(function (r) {
      return { u: String(r.username), name: r.name, campus: r.campus, time: r.inTime,
               ts: r.inTs, late: r.late === true || r.late === 'TRUE',
               lat: r.inLat, lng: r.inLng, away: r.inAway === '' ? null : Number(r.inAway),
               photo: r.inPhoto || '',
               outTime: r.outTime || null, outTs: r.outTs || null };
    });
  var stud = rows_('StudentAttendance').filter(function (r) { return r.date === d; })
    .map(function (r) {
      return { campus: r.campus, present: Number(r.present), total: Number(r.total), by: r.by };
    });
  return { teach: teach, stud: stud, users: users_(false), campuses: campuses_(),
           settings: settings_() };
}

function history_(p) {
  var days = p.days || 7, out = [];
  var tz = Session.getScriptTimeZone();
  var allT = rows_('TeacherAttendance'), allS = rows_('StudentAttendance');
  for (var i = 0; i < days; i++) {
    var dt = new Date();
    dt.setDate(dt.getDate() - i);
    var k = Utilities.formatDate(dt, tz, 'yyyy-MM-dd');
    var t = allT.filter(function (r) { return r.date === k; });
    var s = allS.filter(function (r) { return r.date === k; });
    var pres = 0, tot = 0;
    s.forEach(function (r) { pres += Number(r.present); tot += Number(r.total); });
    if (tot || t.length) {
      out.push({ k: k, pctLabel: tot ? Math.round(pres / tot * 100) + '%' : '—',
                 tin: t.length,
                 tout: t.filter(function (r) { return r.outTs; }).length });
    }
  }
  return { hist: out };
}

/** month = 'yyyy-MM'. Returns CSV text the app writes to a file. */
function exportMonth_(p) {
  var m = p.month;
  var camp = {};
  campuses_().forEach(function (c) { camp[c.id] = c.name; });

  var t = rows_('TeacherAttendance').filter(function (r) {
    return String(r.date).indexOf(m) === 0;
  });
  var s = rows_('StudentAttendance').filter(function (r) {
    return String(r.date).indexOf(m) === 0;
  });

  var out = [];
  out.push('TEACHER ATTENDANCE — ' + m);
  out.push(['Date', 'Name', 'Username', 'Campus', 'In', 'Late', 'Out', 'Hours',
            'Metres from campus', 'Photo'].join(','));
  t.forEach(function (r) {
    var hrs = '';
    if (r.inTs && r.outTs) {
      var d = Math.round((new Date(r.outTs) - new Date(r.inTs)) / 60000);
      hrs = Math.floor(d / 60) + 'h ' + (d % 60) + 'm';
    }
    out.push([r.date, q_(r.name), r.username, q_(camp[r.campus] || ''), r.inTime,
              (r.late === true || r.late === 'TRUE') ? 'LATE' : '', r.outTime || '',
              hrs, r.inAway, r.inPhoto || ''].join(','));
  });

  out.push('');
  out.push('STUDENT ATTENDANCE — ' + m);
  out.push(['Date', 'Campus', 'Present', 'Total', 'Percent', 'Entered by'].join(','));
  s.forEach(function (r) {
    var pct = Number(r.total) ? Math.round(Number(r.present) / Number(r.total) * 100) + '%' : '';
    out.push([r.date, q_(camp[r.campus] || ''), r.present, r.total, pct, q_(r.by)].join(','));
  });

  return { csv: out.join('\n'), filename: 'attendance-' + m + '.csv' };
}

function q_(v) {
  var s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
