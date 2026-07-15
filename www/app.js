/* Attendance — app logic.
 *
 * Plain JavaScript on purpose: no framework, no build step, no CDN. Everything
 * it needs ships inside the APK, so it opens instantly and works with no signal.
 *
 * Set API_URL to your Apps Script /exec URL. That is the only line you must edit.
 */

var API_URL = 'https://script.google.com/macros/s/AKfycbyNKpfz7bS015Rqqhs3MiOlKDSziPMfojESL-Rw2FTFphPc1ljh-nXkXhi1tQWHRO0ZGw/exec';

/* ── native bridges ────────────────────────────────────────────────────────
   Each falls back to a browser equivalent, so the same code runs in Chrome
   while you're testing and on the phone once it's wrapped.                  */

var Cap = window.Capacitor || {};
var Plug = Cap.Plugins || {};
var isNative = !!(Cap.isNativePlatform && Cap.isNativePlatform());

function gps() {
  if (Plug.Geolocation) {
    return Plug.Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 15000 })
      .then(function (p) {
        return { lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6) };
      })
      .catch(function () {
        throw new Error('Could not get your location. Turn on GPS and try again outdoors.');
      });
  }
  return new Promise(function (res, rej) {
    if (!navigator.geolocation) return rej(new Error('This device has no GPS.'));
    navigator.geolocation.getCurrentPosition(
      function (p) { res({ lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6) }); },
      function (e) {
        rej(new Error(e.code === 1
          ? 'Location permission denied. Allow location access for Attendance in your phone settings.'
          : 'Could not get your location. Try again in an open area.'));
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  });
}

/** Returns a small base64 JPEG, or '' if the user backs out. */
function selfie() {
  if (!Plug.Camera) return Promise.resolve('');
  return Plug.Camera.getPhoto({
    quality: 60, allowEditing: false, resultType: 'base64',
    source: 'CAMERA', direction: 'FRONT', width: 480, correctOrientation: true
  }).then(function (p) { return p.base64String || ''; })
    .catch(function () { return ''; });
}

function notify(id, title, body, at) {
  if (!Plug.LocalNotifications) return Promise.resolve();
  return Plug.LocalNotifications.schedule({
    notifications: [{ id: id, title: title, body: body,
                      schedule: { at: at, repeats: true, every: 'day' } }]
  }).catch(function () {});
}

function cancelNotify(id) {
  if (!Plug.LocalNotifications) return Promise.resolve();
  return Plug.LocalNotifications.cancel({ notifications: [{ id: id }] }).catch(function () {});
}

function saveFile(name, text) {
  if (Plug.Filesystem && Plug.Share) {
    return Plug.Filesystem.writeFile({
      path: name, data: text, directory: 'CACHE', encoding: 'utf8'
    }).then(function (r) {
      return Plug.Share.share({ title: name, url: r.uri, dialogTitle: 'Export attendance' });
    });
  }
  var a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(text);
  a.download = name;
  a.click();
  return Promise.resolve();
}

/* ── small helpers ─────────────────────────────────────────────────────── */

function $(id) { return document.getElementById(id); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function today() { return new Date().toLocaleDateString('en-CA'); }
function hhmm(d) { return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); }
function toMins(t) { var p = String(t).split(':'); return +p[0] * 60 + +p[1]; }
function dur(a, b) {
  var m = Math.round((new Date(b) - new Date(a)) / 60000);
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}
function metres(a, b, c, d) {
  var R = 6371000, r = function (x) { return x * Math.PI / 180; };
  var x = Math.sin(r(c - a) / 2) * Math.sin(r(c - a) / 2) +
          Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) * Math.sin(r(d - b) / 2);
  return Math.round(2 * R * Math.asin(Math.sqrt(x)));
}
function sha256(s) {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode('att:' + s))
    .then(function (b) {
      return Array.from(new Uint8Array(b))
        .map(function (x) { return x.toString(16).padStart(2, '0'); }).join('');
    });
}
function store(k, v) {
  if (v === undefined) {
    try { return JSON.parse(localStorage.getItem('att.' + k)); } catch (e) { return null; }
  }
  localStorage.setItem('att.' + k, JSON.stringify(v));
}

/* ── network + offline queue ───────────────────────────────────────────── */

var QUEUEABLE = { checkIn: 1, checkOut: 1, saveStudent: 1 };

function post(action, payload) {
  var body = Object.assign({ action: action }, payload || {});
  return fetch(API_URL, {
    method: 'POST',
    // text/plain keeps Apps Script from demanding a CORS preflight it can't answer
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body)
  })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (!j.ok) throw new Error(j.error);
      return j.data;
    });
}

/** Mutations go through here: they queue instead of failing when offline. */
function api(action, payload) {
  return post(action, payload).catch(function (err) {
    var offline = !navigator.onLine || /Failed to fetch|NetworkError|Load failed/i.test(err.message);
    if (offline && QUEUEABLE[action]) {
      var q = store('queue') || [];
      q.push({ action: action, payload: payload, at: Date.now() });
      store('queue', q);
      showOffline();
      return { queued: true };
    }
    throw offline ? new Error('No connection. Check your internet and try again.') : err;
  });
}

function queueCount() { return (store('queue') || []).length; }

function showOffline() {
  var n = queueCount();
  $('offline').hidden = n === 0 && navigator.onLine;
  $('offline').textContent = n
    ? n + (n === 1 ? ' check-in waiting to sync' : ' entries waiting to sync')
    : 'Offline — changes will sync when you reconnect';
  $('offline-count').textContent = n;
}

function flushQueue() {
  var q = store('queue') || [];
  if (!q.length || !navigator.onLine) return Promise.resolve();
  var item = q[0];
  return post(item.action, item.payload)
    .then(function () {
      store('queue', (store('queue') || []).slice(1));
      showOffline();
      return flushQueue();
    })
    .catch(function () {});
}

window.addEventListener('online', function () { flushQueue().then(function () { render(); }); });
window.addEventListener('offline', showOffline);

/* ── state ─────────────────────────────────────────────────────────────── */

var S = {
  boot: null, user: null, tab: 'checkin', busy: false,
  campuses: [], users: [], settings: { lateTime: '08:15', defaultRadius: 200 },
  day: null, hist: [], mine: null, pendingPhoto: ''
};

function say(msg, type) {
  var b = $('banner');
  if (!msg) { b.hidden = true; return; }
  b.hidden = false;
  b.className = 'banner' + (type === 'err' ? ' err' : '');
  b.textContent = msg;
  clearTimeout(say._t);
  say._t = setTimeout(function () { b.hidden = true; }, 6000);
}

/* ── boot ──────────────────────────────────────────────────────────────── */

function boot() {
  showOffline();
  flushQueue();
  if (API_URL.indexOf('PASTE_') === 0) {
    return paint('<div class="card"><h4>Backend not connected</h4>' +
      '<p class="text-muted">Open <code>www/app.js</code> and set <code>API_URL</code> to your ' +
      'Apps Script deployment URL, then rebuild. Step 3 of the README walks through it.</p></div>');
  }
  post('bootstrap', {})
    .then(function (d) {
      S.boot = d; S.campuses = d.campuses; S.settings = d;
      store('boot', d);
      var cached = store('session');
      if (cached && cached.user) { S.user = cached.user; afterLogin(); }
      else render();
    })
    .catch(function (err) {
      var d = store('boot');
      if (d) {
        // We have data from last time — run offline rather than block the user.
        S.boot = d; S.campuses = d.campuses; S.settings = d;
        var cached = store('session');
        if (cached && cached.user) { S.user = cached.user; S.tab = tabsFor()[0]; render(); }
        else render();
        say('Offline — showing the last data this phone saved.', null);
        return;
      }
      // Nothing cached and no reachable backend: say so plainly.
      renderError(err);
    });
}

/** Shown when the app cannot reach the backend and has nothing saved yet. */
function renderError(err) {
  var offline = !navigator.onLine;
  paint(
    '<div class="card">' +
      '<h4>' + (offline ? 'No internet connection' : 'Cannot reach the backend') + '</h4>' +
      '<p class="text-muted">' + (offline
        ? 'Connect to wifi or mobile data and try again. Once you have signed in on this phone ' +
          'once, the app will work offline.'
        : 'The app reached the internet but your Apps Script did not answer.') + '</p>' +
      '<button class="big-btn" id="e-retry">Try again</button>' +
    '</div>' +
    (offline ? '' :
    '<div class="card">' +
      '<h5>What to check</h5>' +
      '<div class="row"><div><div>1. Open your URL in a browser</div>' +
        '<div class="meta">It should say “Attendance API is running.” If it asks you to sign in ' +
        'or shows an error page, the deployment access is not set to <em>Anyone</em>.</div></div></div>' +
      '<div class="row"><div><div>2. Check the URL ends in /exec</div>' +
        '<div class="meta">A /dev URL will never work from the app.</div></div></div>' +
      '<div class="row"><div><div>3. Redeploy after any script change</div>' +
        '<div class="meta">Deploy &gt; Manage deployments &gt; edit &gt; Version: New version.</div></div></div>' +
    '</div>' +
    '<div class="card">' +
      '<h5>Technical detail</h5>' +
      '<p class="meta" style="word-break:break-all">URL: ' + esc(API_URL) + '</p>' +
      '<p class="meta" style="word-break:break-all">Error: ' + esc(err && err.message || err) + '</p>' +
    '</div>'));
  $('e-retry').onclick = function () {
    paint('<div class="center-note text-muted">Trying again…</div>');
    setTimeout(boot, 200);
  };
}

function tabsFor() {
  return S.user && S.user.role === 'teacher'
    ? ['checkin']
    : ['dash', 'students', 'staff', 'setup'];
}

function afterLogin() {
  S.tab = tabsFor()[0];
  scheduleReminder();
  render();
  loadTab();
}

/* ── reminders ─────────────────────────────────────────────────────────── */

function scheduleReminder() {
  if (!S.user || S.user.role !== 'teacher') return cancelNotify(101);
  var m = toMins(S.settings.lateTime || '08:15') - 15;
  var at = new Date();
  at.setHours(Math.floor(m / 60), m % 60, 0, 0);
  if (at < new Date()) at.setDate(at.getDate() + 1);
  notify(101, 'Check in for today',
         'You have not checked in yet. Tap to open Attendance.', at.toISOString());
}

/* ── data loading ──────────────────────────────────────────────────────── */

function loadTab() {
  if (!S.user) return;
  if (S.user.role === 'teacher') return loadDay();
  if (S.tab === 'dash') return loadDay().then(loadHist);
  if (S.tab === 'students') return loadDay();
  render();
}

function loadDay() {
  return post('day', { date: today() })
    .then(function (d) {
      S.day = d; S.users = d.users; S.campuses = d.campuses; S.settings = d.settings;
      store('day:' + today(), d);
      S.mine = (d.teach || []).filter(function (r) {
        return String(r.u).toLowerCase() === String(S.user.u).toLowerCase();
      })[0] || null;
      if (S.mine) cancelNotify(101);
      render();
    })
    .catch(function () {
      var d = store('day:' + today());
      if (d) {
        S.day = d; S.users = d.users; S.campuses = d.campuses;
        S.mine = (d.teach || []).filter(function (r) {
          return String(r.u).toLowerCase() === String(S.user.u).toLowerCase();
        })[0] || null;
      }
      render();
    });
}

function loadHist() {
  return post('history', { days: 7 })
    .then(function (d) { S.hist = d.hist; store('hist', d.hist); render(); })
    .catch(function () { S.hist = store('hist') || []; render(); });
}

/* ── actions ───────────────────────────────────────────────────────────── */

function mark(kind) {
  S.busy = true; render();
  var photo = '';
  var step = kind === 'in' ? selfie() : Promise.resolve('');
  step
    .then(function (b64) { photo = b64; return gps(); })
    .then(function (g) {
      var camp = S.campuses.filter(function (c) { return c.id === S.user.campus; })[0];
      var away = camp && camp.lat != null ? metres(g.lat, g.lng, camp.lat, camp.lng) : null;
      var limit = (camp && camp.radius) || S.settings.defaultRadius || 200;
      var now = new Date();
      var p = {
        date: today(), u: S.user.u, name: S.user.name, campus: S.user.campus,
        time: hhmm(now), ts: now.toISOString(), lat: g.lat, lng: g.lng, away: away
      };
      if (kind === 'in') p.photo = photo;
      return api(kind === 'in' ? 'checkIn' : 'checkOut', p).then(function (r) {
        if (r.duplicate) {
          say(kind === 'in' ? 'You already checked in today.' : 'You already checked out today.', null);
        } else {
          // Reflect it locally straight away, queued or not.
          if (kind === 'in') {
            S.mine = { u: S.user.u, name: S.user.name, campus: S.user.campus, time: p.time,
                       ts: p.ts, late: toMins(p.time) > toMins(S.settings.lateTime), away: away,
                       lat: g.lat, lng: g.lng, outTime: null, outTs: null };
          } else if (S.mine) {
            S.mine.outTime = p.time; S.mine.outTs = p.ts;
          }
          cancelNotify(101);
          var far = away != null && away > limit;
          var tail = away == null ? '' :
            far ? ' Note: ' + away + ' m from campus.' : ' ' + away + ' m from campus — verified.';
          var head = (kind === 'in' ? 'Checked in' : 'Checked out') + ' — ' + p.time + '.';
          say(head + tail + (r.queued ? ' Saved on this phone; it will sync when you reconnect.' : ''),
              far ? null : null);
        }
        S.busy = false;
        return navigator.onLine ? loadDay() : render();
      });
    })
    .catch(function (err) { S.busy = false; render(); say(err.message, 'err'); });
}

function exportMonth(month) {
  say('Building the export…', null);
  post('exportMonth', { month: month })
    .then(function (d) {
      if (!d.csv || d.csv.indexOf('\n') === -1) return say('Nothing recorded in that month yet.', null);
      return saveFile(d.filename, d.csv).then(function () { say('Export ready.', null); });
    })
    .catch(function (err) { say(err.message, 'err'); });
}

/* ── rendering ─────────────────────────────────────────────────────────── */

function paint(html) { $('app').innerHTML = '<div class="screen">' + html + '</div>'; }

function render() {
  if (!S.boot) return paint('<div class="center-note text-muted">Loading…</div>');
  if (!S.boot.setupDone) return renderFirstRun();
  if (!S.user) return renderLogin();
  return renderApp();
}

function renderFirstRun() {
  paint(
    '<h3>Set up Attendance</h3>' +
    '<p class="text-muted">Create the first admin account. You can add teachers and operators next.</p>' +
    '<div class="card stack">' +
      field('Your name', '<input class="input" id="f-name" placeholder="e.g. Ayesha Khan">') +
      field('Username', '<input class="input" id="f-user" autocapitalize="off" placeholder="e.g. ayesha">') +
      field('PIN (4–8 digits)', '<input class="input" id="f-pin" type="password" inputmode="numeric">') +
      field('Confirm PIN', '<input class="input" id="f-pin2" type="password" inputmode="numeric">') +
      '<button class="big-btn" id="f-go">Create admin account</button>' +
    '</div>');
  $('f-go').onclick = function () {
    var name = $('f-name').value.trim(), u = $('f-user').value.trim().toLowerCase();
    var p = $('f-pin').value.trim(), p2 = $('f-pin2').value.trim();
    if (!name) return say('Enter your name.', 'err');
    if (!u) return say('Enter a username.', 'err');
    if (!/^\d{4,8}$/.test(p)) return say('PIN must be 4–8 digits only.', 'err');
    if (p !== p2) return say('The PINs do not match.', 'err');
    post('createAdmin', { u: u, pin: p, name: name })
      .then(function (d) {
        S.user = d.user; S.campuses = d.campuses; S.users = d.users;
        S.settings = d.settings; S.boot.setupDone = true;
        store('session', { user: d.user });
        afterLogin();
      })
      .catch(function (e) { say(e.message, 'err'); });
  };
}

function renderLogin() {
  paint(
    '<h3>Attendance</h3>' +
    '<p class="text-muted">Sign in with the username and PIN your admin gave you.</p>' +
    '<div class="card stack">' +
      field('Username', '<input class="input" id="l-user" autocapitalize="off">') +
      field('PIN', '<input class="input" id="l-pin" type="password" inputmode="numeric">') +
      '<button class="big-btn" id="l-go">Sign in</button>' +
    '</div>');
  var go = function () {
    var u = $('l-user').value.trim().toLowerCase(), p = $('l-pin').value.trim();
    if (!u || !p) return say('Enter your username and PIN.', 'err');
    post('login', { u: u, pin: p })
      .then(function (d) {
        S.user = d.user; S.campuses = d.campuses; S.users = d.users; S.settings = d.settings;
        return sha256(p).then(function (h) {
          store('session', { user: d.user, h: h });
          afterLogin();
        });
      })
      .catch(function (e) {
        // Offline: fall back to the PIN this phone last signed in with.
        var c = store('session');
        if (c && c.h && c.user && c.user.u === u && !navigator.onLine) {
          return sha256(p).then(function (h) {
            if (h !== c.h) return say('Incorrect username or PIN.', 'err');
            S.user = c.user;
            say('Signed in offline. Data will sync when you reconnect.', null);
            afterLogin();
          });
        }
        say(e.message, 'err');
      });
  };
  $('l-go').onclick = go;
  $('l-pin').onkeydown = function (e) { if (e.key === 'Enter') go(); };
}

function renderApp() {
  var labels = { checkin: 'Check in', dash: 'Dashboard', students: 'Student attendance',
                 staff: 'Users', setup: 'Campuses' };
  var tabs = tabsFor();
  var role = S.user.role === 'teacher' ? 'Teacher'
           : S.user.role === 'operator' ? 'Operator' : 'Admin';
  var html =
    '<div class="topbar">' +
      '<div><h4>' + esc(S.user.name) + '</h4>' +
        '<div class="who text-muted">' + role + ' · ' + today() + '</div></div>' +
      '<button class="btn" id="signout">Sign out</button>' +
    '</div>';
  if (tabs.length > 1) {
    html += '<div class="tabs" role="tablist">' + tabs.map(function (t) {
      return '<button class="tab" role="tab" data-tab="' + t + '" aria-selected="' +
             (S.tab === t) + '">' + labels[t] + '</button>';
    }).join('') + '</div>';
  }
  html += '<div id="pane"></div>';
  paint(html);

  $('signout').onclick = function () {
    store('session', null); S.user = null; S.day = null; cancelNotify(101); render();
  };
  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
    b.onclick = function () { S.tab = b.dataset.tab; say(null); render(); loadTab(); };
  });

  var pane = $('pane');
  if (S.user.role === 'teacher') pane.innerHTML = paneCheckin();
  else if (S.tab === 'dash') pane.innerHTML = paneDash();
  else if (S.tab === 'students') { pane.innerHTML = paneStudents(); wireStudents(); }
  else if (S.tab === 'staff') { pane.innerHTML = paneStaff(); wireStaff(); }
  else if (S.tab === 'setup') { pane.innerHTML = paneSetup(); wireSetup(); }

  if (S.user.role === 'teacher') wireCheckin();
}

function field(label, control) {
  return '<div class="field"><label>' + label + '</label>' + control + '</div>';
}

/* — teacher — */

function paneCheckin() {
  var camp = S.campuses.filter(function (c) { return c.id === S.user.campus; })[0];
  if (!camp) {
    return '<div class="card"><h4>No campus assigned</h4>' +
      '<p class="text-muted">Ask your admin to assign you to a campus before you check in.</p></div>';
  }
  var m = S.mine;
  var out = '<div class="card"><div class="row"><div><h4>' + esc(camp.name) + '</h4>' +
    '<div class="meta">' + (camp.lat != null ? 'GPS point set' : 'No GPS point set for this campus') +
    '</div></div></div>';

  if (!m) {
    out += '<p class="text-muted">You have not checked in today.</p>' +
      '<button class="big-btn" id="c-in"' + (S.busy ? ' disabled' : '') + '>' +
      (S.busy ? 'Getting location…' : 'Check in') + '</button></div>';
    return out;
  }

  out += '<div class="row"><div><div class="meta">Checked in</div>' +
    '<div class="figure-xl" style="font-size:32px">' + esc(m.time) + '</div></div>' +
    (m.late ? '<span class="pill">Late</span>' : '<span class="pill ok">On time</span>') + '</div>';

  if (m.away != null) {
    out += '<div class="row"><div class="meta">Distance from campus</div><div>' + m.away + ' m</div></div>';
  }
  if (m.outTime) {
    out += '<div class="row"><div><div class="meta">Checked out</div><div>' + esc(m.outTime) +
      '</div></div><div><div class="meta">Hours</div><div>' + dur(m.ts, m.outTs) + '</div></div></div>' +
      '<p class="text-muted">You are done for today.</p></div>';
  } else {
    out += '<button class="big-btn secondary" id="c-out"' + (S.busy ? ' disabled' : '') + '>' +
      (S.busy ? 'Getting location…' : 'Check out') + '</button></div>';
  }
  return out;
}

function wireCheckin() {
  if ($('c-in')) $('c-in').onclick = function () { mark('in'); };
  if ($('c-out')) $('c-out').onclick = function () { mark('out'); };
}

/* — dashboard — */

function paneDash() {
  if (!S.day) return '<div class="center-note text-muted">Loading today…</div>';
  var stud = S.day.stud || [], teach = S.day.teach || [];
  var teachers = S.users.filter(function (u) { return u.role === 'teacher'; });
  var P = stud.reduce(function (s, r) { return s + r.present; }, 0);
  var T = stud.reduce(function (s, r) { return s + r.total; }, 0);
  var late = teach.filter(function (r) { return r.late; }).length;
  var outs = teach.filter(function (r) { return r.outTs; }).length;

  var html = '<div class="card">' +
    '<div class="figure-xl">' + (T ? Math.round(P / T * 100) + '%' : '—') + '</div>' +
    '<div class="meta">' + (T ? P + ' / ' + T + ' students present' : 'No student entries yet') +
    ' · ' + teach.length + '/' + teachers.length + ' teachers in' +
    (late ? ', ' + late + ' late' : '') + ' · ' + outs + ' checked out</div>' +
    '<div class="bar"><span style="width:' + (T ? Math.round(P / T * 100) : 0) + '%"></span></div>' +
    '</div>';

  html += '<div class="card"><h5>By campus</h5>';
  S.campuses.forEach(function (c) {
    var s = stud.filter(function (r) { return r.campus === c.id; })[0];
    var pct = s ? Math.round(s.present / s.total * 100) : null;
    var tin = teach.filter(function (r) { return r.campus === c.id; }).length;
    var tot = teachers.filter(function (u) { return u.campus === c.id; }).length;
    html += '<div class="row"><div><div>' + esc(c.name) + '</div><div class="meta">' +
      (s ? s.present + '/' + s.total + ' students' : 'no entry') + ' · ' + tin + '/' + tot +
      ' teachers in</div></div><div style="text-align:right"><strong>' +
      (pct != null ? pct + '%' : '—') + '</strong></div></div>';
  });
  html += '</div>';

  html += '<div class="card"><h5>Teachers today</h5>';
  if (!teachers.length) html += '<p class="text-muted">No teacher accounts yet. Add them under Users.</p>';
  teachers.forEach(function (u) {
    var r = teach.filter(function (x) {
      return String(x.u).toLowerCase() === String(u.u).toLowerCase();
    })[0];
    var c = S.campuses.filter(function (x) { return x.id === u.campus; })[0];
    html += '<div class="row"><div>' +
      (r && r.photo ? '<img class="selfie" src="' + esc(r.photo) + '" alt="" ' +
        'style="float:left;margin-right:8px">' : '') +
      '<div>' + esc(u.name) + '</div><div class="meta">' + esc(c ? c.name : '—') +
      (r ? ' · in ' + esc(r.time) + (r.outTime ? ' · out ' + esc(r.outTime) : '') +
           (r.outTs ? ' · ' + dur(r.ts, r.outTs) : '') : ' · not in yet') +
      '</div></div><div style="text-align:right">' +
      (r ? (r.late ? '<span class="pill">Late</span>' : '<span class="pill ok">On time</span>') +
           (r.lat ? '<div class="meta"><a href="https://maps.google.com/?q=' + r.lat + ',' + r.lng +
                    '" target="_blank" rel="noopener">' +
                    (r.away != null ? r.away + ' m' : 'map') + '</a></div>' : '')
         : '<span class="meta">—</span>') +
      '</div></div>';
  });
  html += '</div>';

  html += '<div class="card"><h5>Last 7 days</h5>';
  if (!S.hist.length) html += '<p class="text-muted">Nothing recorded yet.</p>';
  S.hist.forEach(function (h) {
    html += '<div class="row"><div>' + esc(h.k) + '</div><div class="meta">' + h.tin +
      ' in · ' + h.tout + ' out</div><div><strong>' + esc(h.pctLabel) + '</strong></div></div>';
  });
  html += '</div>';

  if (S.user.role === 'admin') {
    var m = today().slice(0, 7);
    html += '<div class="card"><h5>Export</h5>' +
      '<p class="text-muted">Download a month of attendance as a spreadsheet file.</p>' +
      '<div class="two">' + field('Month', '<input class="input" id="x-month" type="month" value="' + m + '">') +
      '<div class="field"><label>&nbsp;</label><button class="btn btn-primary" id="x-go">Export CSV</button></div>' +
      '</div></div>';
  }
  setTimeout(function () {
    if ($('x-go')) $('x-go').onclick = function () { exportMonth($('x-month').value); };
  }, 0);
  return html;
}

/* — student attendance — */

function paneStudents() {
  var recs = (S.day && S.day.stud) || [];
  var html = '<div class="card stack"><h5>Record today\'s attendance</h5>' +
    field('Campus', '<select class="input" id="s-campus">' + S.campuses.map(function (c) {
      return '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>';
    }).join('') + '</select>') +
    '<div class="two">' +
      field('Present', '<input class="input" id="s-present" type="number" inputmode="numeric" min="0">') +
      field('Total', '<input class="input" id="s-total" type="number" inputmode="numeric" min="1">') +
    '</div>' +
    '<button class="big-btn" id="s-go">Save</button></div>';

  html += '<div class="card"><h5>Entered today</h5>';
  if (!recs.length) html += '<p class="text-muted">No campus has been recorded yet today.</p>';
  recs.forEach(function (r) {
    var c = S.campuses.filter(function (x) { return x.id === r.campus; })[0];
    html += '<div class="row"><div><div>' + esc(c ? c.name : '—') + '</div>' +
      '<div class="meta">' + r.present + '/' + r.total + ' · by ' + esc(r.by || '—') + '</div></div>' +
      '<strong>' + Math.round(r.present / r.total * 100) + '%</strong></div>';
  });
  return html + '</div>';
}

function wireStudents() {
  $('s-go').onclick = function () {
    var p = parseInt($('s-present').value, 10), t = parseInt($('s-total').value, 10);
    if (isNaN(p) || isNaN(t) || t < 1) return say('Enter both present and total.', 'err');
    if (p > t) return say('Present cannot be more than the total.', 'err');
    var cid = $('s-campus').value;
    api('saveStudent', { date: today(), campus: cid, present: p, total: t,
                         by: S.user.name, ts: new Date().toISOString() })
      .then(function (r) {
        var c = S.campuses.filter(function (x) { return x.id === cid; })[0];
        say(c.name + ' saved — ' + Math.round(p / t * 100) + '% (' + p + '/' + t + ').' +
            (r.queued ? ' It will sync when you reconnect.' : ''), null);
        $('s-present').value = ''; $('s-total').value = '';
        loadTab();
      })
      .catch(function (e) { say(e.message, 'err'); });
  };
}

/* — users — */

function paneStaff() {
  var html = '<div class="card stack"><h5>Add a user</h5>' +
    field('Name', '<input class="input" id="u-name">') +
    field('Username', '<input class="input" id="u-user" autocapitalize="off">') +
    '<div class="two">' +
      field('PIN (4–8 digits)', '<input class="input" id="u-pin" inputmode="numeric">') +
      field('Role', '<select class="input" id="u-role"><option value="teacher">Teacher</option>' +
            '<option value="operator">Operator</option><option value="admin">Admin</option></select>') +
    '</div>' +
    field('Campus', '<select class="input" id="u-campus"><option value="">— none —</option>' +
      S.campuses.map(function (c) {
        return '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>';
      }).join('') + '</select>') +
    '<button class="big-btn" id="u-go">Add user</button></div>';

  html += '<div class="card"><h5>Accounts</h5>';
  S.users.forEach(function (u) {
    var c = S.campuses.filter(function (x) { return x.id === u.campus; })[0];
    html += '<div class="row"><div><div>' + esc(u.name) + '</div><div class="meta">' +
      esc(u.u) + ' · ' + esc(u.role) + ' · ' + esc(c ? c.name : '—') + '</div></div>' +
      (u.role === 'admin' ? '' :
        '<button class="btn" data-rm="' + esc(u.u) + '">Remove</button>') + '</div>';
  });
  return html + '</div>';
}

function wireStaff() {
  $('u-go').onclick = function () {
    var p = { name: $('u-name').value.trim(), u: $('u-user').value.trim().toLowerCase(),
              pin: $('u-pin').value.trim(), role: $('u-role').value,
              campus: $('u-campus').value || null };
    post('addUser', p)
      .then(function (d) {
        S.users = d.users;
        say(p.name + ' can now sign in with username “' + p.u + '” and PIN ' + p.pin +
            '. Write it down — it is not shown again.', null);
        render();
      })
      .catch(function (e) { say(e.message, 'err'); });
  };
  Array.prototype.forEach.call(document.querySelectorAll('[data-rm]'), function (b) {
    b.onclick = function () {
      if (!confirm('Remove ' + b.dataset.rm + '? Their past attendance stays in the sheet.')) return;
      post('removeUser', { u: b.dataset.rm })
        .then(function (d) { S.users = d.users; say('User removed.', null); render(); })
        .catch(function (e) { say(e.message, 'err'); });
    };
  });
}

/* — campuses + settings — */

function paneSetup() {
  var html = '<div class="card stack"><h5>Campuses</h5>' +
    '<p class="text-muted">Stand at each campus and tap “Use my location” to set its GPS point. ' +
    'Check-ins are measured against it.</p>';
  S.campuses.forEach(function (c, i) {
    html += '<div class="field"><label>Campus ' + (i + 1) + '</label>' +
      '<input class="input" data-cname="' + esc(c.id) + '" value="' + esc(c.name) + '">' +
      '<div class="row"><div class="meta">' +
      (c.lat != null ? c.lat + ', ' + c.lng : 'GPS point not set') + '</div>' +
      '<button class="btn" data-pin="' + esc(c.id) + '">' +
      (c.lat != null ? 'Update location' : 'Use my location') + '</button></div></div>';
  });
  html += '<button class="big-btn" id="cs-save">Save campus names</button></div>';

  html += '<div class="card stack"><h5>Rules</h5>' +
    '<div class="two">' +
      field('Late after', '<input class="input" id="st-late" type="time" value="' +
            esc(S.settings.lateTime || '08:15') + '">') +
      field('Allowed distance (m)', '<input class="input" id="st-rad" type="number" min="10" value="' +
            esc(S.settings.defaultRadius || 200) + '">') +
    '</div>' +
    '<button class="big-btn secondary" id="st-save">Save rules</button></div>';
  return html;
}

function wireSetup() {
  Array.prototype.forEach.call(document.querySelectorAll('[data-pin]'), function (b) {
    b.onclick = function () {
      b.textContent = 'Getting location…';
      gps().then(function (g) {
        var c = S.campuses.filter(function (x) { return x.id === b.dataset.pin; })[0];
        c.lat = g.lat; c.lng = g.lng;
        return post('saveCampuses', { campuses: [c] });
      })
        .then(function (d) { S.campuses = d.campuses; say('Campus location set.', null); render(); })
        .catch(function (e) { say(e.message, 'err'); render(); });
    };
  });
  $('cs-save').onclick = function () {
    var list = S.campuses.map(function (c) {
      var el = document.querySelector('[data-cname="' + c.id + '"]');
      return Object.assign({}, c, { name: el && el.value.trim() ? el.value.trim() : c.name });
    });
    post('saveCampuses', { campuses: list })
      .then(function (d) { S.campuses = d.campuses; say('Campus names saved.', null); render(); })
      .catch(function (e) { say(e.message, 'err'); });
  };
  $('st-save').onclick = function () {
    post('saveSettings', { lateTime: $('st-late').value,
                           defaultRadius: parseInt($('st-rad').value, 10) })
      .then(function (d) {
        S.settings = d.settings; say('Rules saved.', null); scheduleReminder(); render();
      })
      .catch(function (e) { say(e.message, 'err'); });
  };
}

/* ── go ────────────────────────────────────────────────────────────────── */

// If anything throws before the app paints, show it rather than sit on "Loading…".
window.addEventListener('error', function (e) {
  var app = document.getElementById('app');
  if (app && /Loading/.test(app.textContent)) {
    app.innerHTML = '<div class="card"><h4>The app hit an error starting up</h4>' +
      '<p class="meta" style="word-break:break-all">' + esc(e.message) + '</p>' +
      '<p class="meta">' + esc((e.filename || '').split('/').pop() + ':' + e.lineno) + '</p></div>';
  }
});

if (Plug.LocalNotifications) Plug.LocalNotifications.requestPermissions().catch(function () {});
document.addEventListener('DOMContentLoaded', boot);
if (document.readyState !== 'loading') boot();
