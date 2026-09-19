(function () {
'use strict';

/* ---------- helpers ---------- */
var TOKEN_KEY = 'gymdesk.token', DAY = 86400000;
var DEFAULT_TEMPLATE = 'Hi {name}, your {plan} membership at {gym} {when}. Please renew at the counter or by UPI so you can carry on without a break.';
var token = null;
try { token = localStorage.getItem(TOKEN_KEY); } catch (e) { /* storage blocked */ }

var $ = function (s, r) { return (r || document).querySelector(s); };
var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
var pad = function (n) { return String(n).padStart(2, '0'); };
var iso = function (d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
var parse = function (s) { var p = s.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); };
var today = function () { var n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); };
var startOfDay = function (ts) { var d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); };
var addMonths = function (d, n) { var x = new Date(d.getFullYear(), d.getMonth() + n, 1); var last = new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate(); x.setDate(Math.min(d.getDate(), last)); return x; };
var daysBetween = function (a, b) { return Math.round((b - a) / DAY); };
var fmtDate = function (d, withYear) { var o = { day: 'numeric', month: 'short' }; if (withYear || d.getFullYear() !== today().getFullYear()) o.year = 'numeric'; return d.toLocaleDateString('en-IN', o); };
var fmtTime = function (ts) { return new Date(ts).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }); };
var inr = function (n) { return '\u20B9' + Math.round(n).toLocaleString('en-IN'); };
var compact = function (n) { if (n >= 100000) return '\u20B9' + (n / 100000).toFixed(1).replace('.0', '') + 'L'; if (n >= 1000) return '\u20B9' + (n / 1000).toFixed(1).replace('.0', '') + 'k'; return '\u20B9' + Math.round(n); };
var first = function (n) { return String(n).trim().split(/\s+/)[0] || ''; };
var hourLabel = function (h) { var x = ((h % 24) + 24) % 24; var s = x >= 12 ? 'pm' : 'am'; var v = x % 12 === 0 ? 12 : x % 12; return v + ' ' + s; };
var shortHour = function (h) { var s = h >= 12 ? 'p' : 'a'; var v = h % 12 === 0 ? 12 : h % 12; return v + s; };
var normPhone = function (v) { var d = String(v || '').replace(/\D/g, ''); if (d.length === 12 && d.indexOf('91') === 0) d = d.slice(2); if (d.length === 11 && d.charAt(0) === '0') d = d.slice(1); return d; };
var money = function (v) { return Math.max(0, Math.round(Number(v) || 0)); };

/* ---------- API ---------- */
function api(method, path, body) {
  var opts = { method: method, headers: { 'Content-Type': 'application/json' } };
  if (token) opts.headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) opts.body = JSON.stringify(body);
  return fetch('/api' + path, opts).then(function (r) {
    return r.json().catch(function () { return null; }).then(function (data) {
      if (r.status === 401 && token && path.indexOf('/auth/login') !== 0) { endSession(); throw new Error('Please log in again.'); }
      if (!r.ok) throw new Error((data && data.error) || 'Something went wrong. Try again.');
      return data;
    });
  }, function () { throw new Error('Cannot reach the server. Check your internet connection.'); });
}

/* ---------- data ---------- */
var db = null; // { user, gym, template, plans, members, checkins }
var state = { tab: 'today', q: '', filter: 'all', cq: '', fetchedAt: 0 };

function normMember(m) {
  return {
    id: String(m.id), name: m.name, phone: m.phone || '', planId: m.planId == null ? null : String(m.planId), plan: m.plan,
    start: m.start, expiry: m.expiry, joined: m.joined, due: m.due, notes: m.notes || '',
    payments: (m.payments || []).map(function (p) { return { id: String(p.id), date: p.date, amount: p.amount, plan: p.plan, months: p.months, mode: p.mode }; })
  };
}
function normPlans(list) { return list.map(function (p) { return { id: String(p.id), name: p.name, months: p.months, price: p.price }; }); }
function applyBootstrap(d) {
  db = {
    user: d.user, gym: d.gym.name, template: d.gym.template || DEFAULT_TEMPLATE, plans: normPlans(d.plans),
    members: d.members.map(normMember), checkins: d.checkins.map(function (c) { return { m: String(c.m), ts: c.ts }; })
  };
  state.fetchedAt = Date.now();
}
var findM = function (id) { return db.members.filter(function (m) { return m.id === id; })[0]; };
var replaceMember = function (dto) { var m = normMember(dto); db.members = db.members.map(function (x) { return x.id === m.id ? m : x; }); return m; };
var daysLeft = function (m) { return daysBetween(today(), parse(m.expiry)); };
var statusOf = function (m) { var d = daysLeft(m); return d < 0 ? 'expired' : d <= 7 ? 'soon' : 'ok'; };
function statusText(m) {
  var d = daysLeft(m);
  if (d < 0) return 'Expired ' + (d === -1 ? 'yesterday' : (-d) + ' days ago');
  if (d === 0) return 'Ends today';
  if (d === 1) return 'Ends tomorrow';
  if (d <= 30) return 'Ends in ' + d + ' days';
  return 'Runs until ' + fmtDate(parse(m.expiry), true);
}
function plate(m) {
  var d = daysLeft(m), st = statusOf(m);
  var label = d < 0 ? '\u2212' + Math.min(-d, 99) : String(Math.min(d, 99));
  return '<svg class="plate ' + st + '" viewBox="0 0 52 52" width="52" height="52" aria-hidden="true"><circle class="p-out" cx="26" cy="26" r="25"/><circle class="p-ring" cx="26" cy="26" r="20"/><circle class="p-hole" cx="26" cy="26" r="14.5"/><text class="p-num" x="26" y="31.5" text-anchor="middle">' + label + '</text></svg>';
}
function lastVisit(id) { var max = 0; db.checkins.forEach(function (c) { if (c.m === id && c.ts > max) max = c.ts; }); return max; }
function visitText(ts) {
  if (!ts) return 'No visits logged';
  var n = daysBetween(startOfDay(ts), today());
  return n === 0 ? 'Today' : n === 1 ? 'Yesterday' : n + ' days ago';
}
function sameDay(ts, d) { var x = new Date(ts); return x.getFullYear() === d.getFullYear() && x.getMonth() === d.getMonth() && x.getDate() === d.getDate(); }
function todayCheckin(id) { return db.checkins.filter(function (c) { return c.m === id && sameDay(c.ts, new Date()); })[0]; }

function reminderText(m) {
  var d = daysLeft(m), exp = fmtDate(parse(m.expiry), true);
  var when = d < 0 ? 'expired on ' + exp : d === 0 ? 'ends today' : 'ends on ' + exp;
  var t = (db.template || DEFAULT_TEMPLATE).split('{name}').join(first(m.name)).split('{gym}').join(db.gym).split('{plan}').join(m.plan).split('{when}').join(when);
  if (m.due > 0) t += ' Pending dues: ' + inr(m.due) + '.';
  return t;
}
function quietText(m) { return 'Hi ' + first(m.name) + ', we have not seen you at ' + db.gym + ' for a while. Hope all is well. Come by whenever you are ready.'; }
function waLink(m, text) {
  var d = normPhone(m.phone);
  return 'https://wa.me/' + (d.length === 10 ? '91' + d : '') + '?text=' + encodeURIComponent(text);
}
function waBtn(m, text, label, cls) {
  return '<a class="btn ' + (cls === undefined ? 'sm' : cls) + ' wa" href="' + waLink(m, text) + '" target="_blank" rel="noopener noreferrer">' + esc(label) + '</a>';
}

/* ---------- shell ---------- */
var screen = $('#screen'), lastFocus = null;
var ICONS = {
  today: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4M9 15l2 2 4-4"/>',
  members: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.3c2.2.7 3.5 2.6 3.5 5.7"/>',
  checkin: '<path d="M14 3h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5"/><path d="M3 12h11M10 8l4 4-4 4"/>',
  overview: '<path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'
};
var svg = function (k, s) { return '<svg viewBox="0 0 24 24" width="' + (s || 22) + '" height="' + (s || 22) + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[k] + '</svg>'; };
var TABS = [['today', 'Today'], ['members', 'Members'], ['checkin', 'Check-in'], ['overview', 'Overview']];

function renderChrome() {
  $('#top').innerHTML = '<div><h1>' + esc(db.gym) + '</h1><p class="sub">' + new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' }) + '</p></div>' +
    '<div class="top-actions"><button class="btn primary sm" data-action="add">New member</button><button class="icon-btn" data-action="settings" aria-label="Settings">' + svg('gear', 20) + '</button></div>';
  $('#tabs').innerHTML = TABS.map(function (t) { return '<button class="tab" data-action="tab" data-tab="' + t[0] + '"' + (state.tab === t[0] ? ' aria-current="page"' : '') + '>' + svg(t[0]) + '<span>' + t[1] + '</span></button>'; }).join('');
}
function render() {
  if (!db) return;
  document.body.classList.remove('auth');
  renderChrome();
  if (state.tab === 'today') renderToday();
  else if (state.tab === 'members') renderMembers();
  else if (state.tab === 'checkin') renderCheckin();
  else renderOverview();
}
var emptyBox = function (title, text, btn) { return '<div class="empty"><p><strong>' + esc(title) + '</strong></p><p class="meta">' + esc(text) + '</p>' + (btn || '') + '</div>'; };

/* ---------- sign in / set up ---------- */
function authForm(mode, msg) {
  document.body.classList.add('auth');
  $('#tabs').innerHTML = '';
  var setup = mode === 'setup';
  $('#top').innerHTML = '<div><h1>Gym Desk</h1><p class="sub">' + (setup ? 'Set up your gym' : 'Log in to your gym') + '</p></div>';
  screen.innerHTML = '<div class="authbox" data-mode="' + mode + '">' +
    (setup ? '<div class="field"><label for="a-gym">Gym name</label><input id="a-gym" autocomplete="organization"></div><div class="field"><label for="a-name">Your name</label><input id="a-name" autocomplete="name"></div>' : '') +
    '<div class="field"><label for="a-email">Email</label><input id="a-email" type="email" autocomplete="username" inputmode="email"></div>' +
    '<div class="field"><label for="a-pw">Password' + (setup ? ' (at least 8 characters)' : '') + '</label><input id="a-pw" type="password" autocomplete="' + (setup ? 'new-password' : 'current-password') + '"></div>' +
    (setup ? '<div class="field"><label for="a-key">Setup key</label><input id="a-key" type="password" autocomplete="off"></div>' : '') +
    '<p class="err" id="a-err">' + esc(msg || '') + '</p>' +
    '<button class="btn primary block" data-action="' + (setup ? 'do-setup' : 'do-login') + '" data-primary>' + (setup ? 'Create gym' : 'Log in') + '</button>' +
    '<button class="link" data-action="' + (setup ? 'to-login' : 'to-setup') + '">' + (setup ? 'I already have an account' : 'Setting up a new gym?') + '</button></div>';
}
function submitAuth(el, setup) {
  var err = $('#a-err');
  var body = { email: $('#a-email').value.trim(), password: $('#a-pw').value };
  if (setup) { body.gymName = $('#a-gym').value; body.name = $('#a-name').value; body.setupKey = $('#a-key').value; }
  if (!body.email || !body.password) { err.textContent = 'Enter your email and password.'; return; }
  el.disabled = true; err.textContent = '';
  api('POST', setup ? '/auth/register' : '/auth/login', body).then(function (r) {
    token = r.token;
    try { localStorage.setItem(TOKEN_KEY, token); } catch (e) { /* storage blocked */ }
    state.tab = 'today';
    boot();
  }).catch(function (e) { el.disabled = false; err.textContent = e.message; });
}
function endSession() {
  token = null; db = null;
  try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
  closeSheet();
  boot();
}
function boot() {
  if (!token) {
    return api('GET', '/auth/status').then(function (s) { authForm(s.needsSetup ? 'setup' : 'login'); })
      .catch(function (e) { authForm('login', e.message); });
  }
  screen.innerHTML = '<p class="loading">Loading…</p>';
  return api('GET', '/bootstrap').then(function (d) { applyBootstrap(d); render(); })
    .catch(function (e) {
      if (!token) return;
      $('#top').innerHTML = '<div><h1>Gym Desk</h1></div>';
      screen.innerHTML = emptyBox('Could not load your gym', e.message, '<p style="margin-top:12px"><button class="btn sm" data-action="retry">Try again</button></p>');
    });
}

/* ---------- Today ---------- */
function rowRenew(m) {
  return '<li class="row"><button class="row-main" data-action="open" data-id="' + m.id + '">' + plate(m) +
    '<span class="row-text"><strong>' + esc(m.name) + '</strong><span class="meta ' + statusOf(m) + '">' + statusText(m) + '</span><span class="meta">' + esc(m.plan) + (m.due > 0 ? ' \u00B7 ' + inr(m.due) + ' due' : '') + '</span></span></button>' +
    '<div class="row-actions">' + waBtn(m, reminderText(m), 'WhatsApp reminder') + '<button class="btn sm primary" data-action="renew" data-id="' + m.id + '">Renew</button></div></li>';
}
function rowDue(m) {
  return '<li class="row"><button class="row-main" data-action="open" data-id="' + m.id + '">' + plate(m) +
    '<span class="row-text"><strong>' + esc(m.name) + '</strong><span class="meta expired">' + inr(m.due) + ' pending</span><span class="meta">' + esc(m.plan) + ' \u00B7 ' + statusText(m) + '</span></span></button>' +
    '<div class="row-actions">' + waBtn(m, reminderText(m), 'WhatsApp reminder') + '<button class="btn sm primary" data-action="collect" data-id="' + m.id + '">Collect dues</button></div></li>';
}
function renderToday() {
  var list = db.members.filter(function (m) { return daysLeft(m) <= 7; }).sort(function (a, b) { return daysLeft(a) - daysLeft(b); });
  var ids = {}; list.forEach(function (m) { ids[m.id] = 1; });
  var dues = db.members.filter(function (m) { return m.due > 0 && !ids[m.id]; }).sort(function (a, b) { return b.due - a.due; });
  var html = '';
  if (!db.members.length) html += '<div class="banner"><p>Start by adding your members from the register. For each one, use the start date written in the register and the amount they paid. Their renewal date is worked out for you.</p><div><button class="btn sm primary" data-action="add">Add first member</button></div></div>';
  html += '<div class="sec-head"><h2>Renew now</h2><span class="count">' + list.length + '</span></div>';
  html += '<p class="hint">Each plate shows days left. Yellow means this week, red means expired.</p>';
  html += list.length ? '<ul class="panel">' + list.map(rowRenew).join('') + '</ul>' : emptyBox('Nobody is due this week', 'Members appear here 7 days before their plan ends.');
  if (dues.length) html += '<div class="sec-head"><h2>Dues to collect</h2><span class="count">' + dues.length + '</span></div><ul class="panel">' + dues.map(rowDue).join('') + '</ul>';
  screen.innerHTML = html;
}

/* ---------- Members ---------- */
var FILTERS = [['all', 'All', function () { return true; }], ['active', 'Active', function (m) { return daysLeft(m) >= 0; }], ['soon', 'Ending soon', function (m) { var d = daysLeft(m); return d >= 0 && d <= 7; }], ['expired', 'Expired', function (m) { return daysLeft(m) < 0; }], ['dues', 'Has dues', function (m) { return m.due > 0; }]];
function renderMembers() {
  var chips = FILTERS.map(function (f) { var n = db.members.filter(f[2]).length; return '<button class="chip" data-action="filter" data-f="' + f[0] + '" aria-pressed="' + (state.filter === f[0]) + '">' + f[1] + ' ' + n + '</button>'; }).join('');
  screen.innerHTML = '<div class="search"><input id="q" type="search" placeholder="Search name or phone" aria-label="Search members" autocomplete="off" value="' + esc(state.q) + '"></div><div class="chips" role="group" aria-label="Filter members">' + chips + '</div><div id="list"></div>';
  updateMembers();
}
function matches(m, q) {
  q = q.trim().toLowerCase(); if (!q) return true;
  var digits = q.replace(/\D/g, '');
  return m.name.toLowerCase().indexOf(q) > -1 || (digits && normPhone(m.phone).indexOf(digits) > -1);
}
function updateMembers() {
  var f = FILTERS.filter(function (x) { return x[0] === state.filter; })[0];
  var list = db.members.filter(function (m) { return f[2](m) && matches(m, state.q); }).sort(function (a, b) { return a.name.localeCompare(b.name); });
  var el = $('#list'); if (!el) return;
  if (!db.members.length) { el.innerHTML = emptyBox('No members yet', 'Copy your first member from the register. It takes about a minute.', '<p style="margin-top:12px"><button class="btn primary sm" data-action="add">Add first member</button></p>'); return; }
  if (!list.length) { el.innerHTML = emptyBox('No match', 'Try a different name, number or filter.'); return; }
  el.innerHTML = '<ul class="panel">' + list.map(function (m) {
    return '<li class="row"><button class="row-main" data-action="open" data-id="' + m.id + '">' + plate(m) + '<span class="row-text"><strong>' + esc(m.name) + '</strong><span class="meta ' + statusOf(m) + '">' + statusText(m) + '</span><span class="meta">' + esc(m.plan) + (m.phone ? ' \u00B7 ' + esc(m.phone) : '') + (m.due > 0 ? ' \u00B7 ' + inr(m.due) + ' due' : '') + '</span></span></button></li>';
  }).join('') + '</ul>';
}

/* ---------- Check-in ---------- */
function renderCheckin() {
  screen.innerHTML = '<div class="search"><input id="cq" type="search" placeholder="Type a name or phone number" aria-label="Find member to check in" autocomplete="off" value="' + esc(state.cq) + '"></div><div id="cres"></div><div id="ctoday"></div>';
  updateCheckin();
}
function updateCheckin() {
  var q = state.cq.trim(), res = $('#cres'), td = $('#ctoday'); if (!res || !td) return;
  if (q) {
    var list = db.members.filter(function (m) { return matches(m, q); }).slice(0, 8);
    res.innerHTML = list.length ? '<ul class="panel" style="margin-bottom:6px">' + list.map(function (m) {
      var c = todayCheckin(m.id);
      return '<li class="row simple">' + plate(m) + '<div class="row-text"><strong>' + esc(m.name) + '</strong><span class="meta ' + (c ? 'ok' : statusOf(m)) + '">' + (c ? 'Checked in ' + fmtTime(c.ts) : statusText(m)) + '</span></div><div class="row-actions">' +
        (daysLeft(m) < 0 && !c ? '<button class="btn sm" data-action="renew" data-id="' + m.id + '">Renew</button>' : '') +
        '<button class="btn sm ' + (c ? '' : 'primary') + '" data-action="checkin" data-id="' + m.id + '">' + (c ? 'Undo' : 'Check in') + '</button></div></li>';
    }).join('') + '</ul>' : emptyBox('No match', 'Check the spelling or try the phone number.');
  } else res.innerHTML = '<p class="hint">Search for a member to log their visit.</p>';
  var todays = db.checkins.filter(function (c) { return sameDay(c.ts, new Date()); }).sort(function (a, b) { return b.ts - a.ts; });
  td.innerHTML = '<div class="sec-head"><h2>Today</h2><span class="count">' + todays.length + ' in</span></div>' +
    (todays.length ? '<ul class="panel">' + todays.map(function (c) { var m = findM(c.m); if (!m) return ''; return '<li class="row simple" style="grid-template-columns:auto 1fr"><span class="meta" style="min-width:64px">' + fmtTime(c.ts) + '</span><button class="row-main" style="grid-template-columns:1fr" data-action="open" data-id="' + m.id + '"><strong>' + esc(m.name) + '</strong></button></li>'; }).join('') + '</ul>' : emptyBox('No check-ins yet today', 'Visits you log here build the busy-hours chart in Overview.'));
}

/* ---------- Overview ---------- */
function quietList() {
  if (!db.checkins.length) return null;
  var oldest = db.checkins.reduce(function (a, c) { return c.ts < a ? c.ts : a; }, Infinity);
  var tracked = daysBetween(startOfDay(oldest), today());
  if (tracked < 10) return null;
  var last = {}; db.checkins.forEach(function (c) { if (!last[c.m] || c.ts > last[c.m]) last[c.m] = c.ts; });
  var out = [];
  db.members.forEach(function (m) {
    if (daysLeft(m) < 0) return;
    if (daysBetween(parse(m.joined), today()) < 10) return;
    var l = last[m.id], gap = l ? daysBetween(startOfDay(l), today()) : tracked;
    if (gap >= 10) out.push({ m: m, gap: gap, never: !l, tracked: tracked });
  });
  return out.sort(function (a, b) { return b.gap - a.gap; }).slice(0, 6);
}
function renderOverview() {
  var t = today(), key = function (d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1); };
  var active = db.members.filter(function (m) { return daysLeft(m) >= 0; }).length;
  var soon = db.members.filter(function (m) { var d = daysLeft(m); return d >= 0 && d <= 7; }).length;
  var expired = db.members.filter(function (m) { return daysLeft(m) < 0; }).length;
  var rev = {}; db.members.forEach(function (m) { m.payments.forEach(function (p) { var k = p.date.slice(0, 7); rev[k] = (rev[k] || 0) + p.amount; }); });
  var months = []; for (var i = 5; i >= 0; i--) { var d = new Date(t.getFullYear(), t.getMonth() - i, 1); months.push({ label: d.toLocaleDateString('en-IN', { month: 'short' }), v: rev[key(d)] || 0 }); }
  var maxM = Math.max.apply(null, months.map(function (x) { return x.v; }).concat([1]));
  var joins = db.members.filter(function (m) { return m.joined.slice(0, 7) === key(t); }).length;
  var dues = db.members.reduce(function (s, m) { return s + m.due; }, 0);
  var counts = []; for (var h = 0; h < 24; h++) counts.push(0);
  var since = Date.now() - 30 * DAY, any = false;
  db.checkins.forEach(function (c) { if (c.ts >= since) { counts[new Date(c.ts).getHours()]++; any = true; } });
  var peak = 5, maxH = 0; for (var hh = 5; hh <= 22; hh++) { if (counts[hh] > maxH) { maxH = counts[hh]; peak = hh; } }
  var hourBars = ''; for (var x = 5; x <= 22; x++) { hourBars += '<div class="bar' + (x === peak && maxH > 0 ? ' peak' : '') + '"><span class="bv"></span><div class="col"><i style="height:' + (maxH ? Math.max(3, counts[x] / maxH * 100) : 3) + '%"></i></div><span class="bl">' + ((x - 5) % 3 === 0 ? shortHour(x) : '') + '</span></div>'; }
  var quiet = quietList();
  var html = '<div class="sec-head"><h2>Members</h2></div><dl class="ledger">' +
    '<div><span class="dot green"></span><dt>Active</dt><dd>' + active + '</dd></div>' +
    '<div><span class="dot yellow"></span><dt>Ending this week</dt><dd>' + soon + '</dd></div>' +
    '<div><span class="dot red"></span><dt>Expired</dt><dd>' + expired + '</dd></div>' +
    '<div><span class="dot blue"></span><dt>Joined this month</dt><dd>' + joins + '</dd></div></dl>' +
    '<div class="sec-head"><h2>Money</h2></div><dl class="ledger">' +
    '<div><dt>Collected this month</dt><dd>' + inr(months[5].v) + '</dd></div>' +
    '<div><dt>Dues pending</dt><dd>' + inr(dues) + '</dd></div></dl>' +
    '<h3>Collected, last 6 months</h3><div class="chart"><div class="bars" aria-hidden="true">' + months.map(function (m) { return '<div class="bar"><span class="bv">' + compact(m.v) + '</span><div class="col"><i style="height:' + Math.max(3, m.v / maxM * 100) + '%"></i></div><span class="bl">' + m.label + '</span></div>'; }).join('') + '</div>' +
    '<ul class="sr">' + months.map(function (m) { return '<li>' + m.label + ': ' + inr(m.v) + '</li>'; }).join('') + '</ul></div>' +
    '<h3>Busy hours, last 30 days</h3><div class="chart">' + (any ? '<div class="bars hours" aria-hidden="true">' + hourBars + '</div><p class="caption">Busiest around ' + hourLabel(peak) + ' to ' + hourLabel(peak + 1) + '.</p>' : '<p class="caption" style="margin:0">Log check-ins for a few days and the busy hours will show up here.</p>') + '</div>' +
    '<h3>Gone quiet</h3>';
  if (quiet === null) html += emptyBox('Not enough visits yet', 'This list starts once check-ins have been logged for 10 days. It shows active members who stopped coming.');
  else if (!quiet.length) html += emptyBox('Everyone is showing up', 'No active member has missed 10 days in a row.');
  else html += '<ul class="panel">' + quiet.map(function (q) { var m = q.m; return '<li class="row"><button class="row-main" data-action="open" data-id="' + m.id + '">' + plate(m) + '<span class="row-text"><strong>' + esc(m.name) + '</strong><span class="meta">' + (q.never ? 'No visits in ' + q.tracked + ' days' : 'Last visit ' + q.gap + ' days ago') + '</span><span class="meta">' + statusText(m) + '</span></span></button><div class="row-actions">' + waBtn(m, quietText(m), 'Send a nudge') + '</div></li>'; }).join('') + '</ul>';
  screen.innerHTML = html;
}

/* ---------- sheets ---------- */
function openSheet(title, body) {
  var w = $('#sheetWrap'), sh = $('.sheet', w);
  if (w.hidden) lastFocus = document.activeElement;
  sh.innerHTML = '<div class="sheet-head"><h2 id="sheetTitle">' + esc(title) + '</h2><button class="btn sm" data-action="close">Close</button></div>' + body;
  w.hidden = false; document.body.style.overflow = 'hidden'; sh.scrollTop = 0; sh.focus();
}
function closeSheet() {
  var w = $('#sheetWrap'); if (w.hidden) return;
  w.hidden = true; document.body.style.overflow = '';
  if (lastFocus && lastFocus.isConnected) { try { lastFocus.focus(); } catch (e) { /* ignore */ } }
}
var tt;
function toast(msg) { var t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(tt); tt = setTimeout(function () { t.hidden = true; }, 3400); }
function pending(el, on) { if (el) el.disabled = on; }
var planOptions = function (sel) { return db.plans.map(function (p) { return '<option value="' + p.id + '"' + (p.id === sel ? ' selected' : '') + '>' + esc(p.name) + ' \u00B7 ' + inr(p.price) + '</option>'; }).join(''); };
var modeOptions = '<option>Cash</option><option>UPI</option><option>Card</option>';
var planById = function (id) { return db.plans.filter(function (p) { return p.id === id; })[0] || db.plans[0]; };

function showMember(id) {
  var m = findM(id); if (!m) { closeSheet(); return; }
  var st = statusOf(m), digits = normPhone(m.phone);
  var hist = m.payments.slice().reverse().map(function (p) { return '<li><span>' + fmtDate(parse(p.date), true) + '</span><span>' + (p.plan === 'Dues' ? 'Dues payment' : esc(p.plan)) + ' \u00B7 ' + esc(p.mode) + '</span><strong>' + inr(p.amount) + '</strong></li>'; }).join('');
  var c = todayCheckin(m.id);
  openSheet(m.name,
    '<div class="who">' + plate(m) + '<div><p class="name">' + esc(m.name) + '</p><p class="meta ' + st + '">' + statusText(m) + '</p></div></div>' +
    '<dl class="facts"><div><dt>Plan</dt><dd>' + esc(m.plan) + '</dd></div>' +
    '<div><dt>Current period</dt><dd>' + fmtDate(parse(m.start)) + ' to ' + fmtDate(parse(m.expiry), true) + '</dd></div>' +
    '<div><dt>Phone</dt><dd>' + (digits ? '<a href="tel:' + digits + '">' + esc(m.phone) + '</a>' : 'Not added') + '</dd></div>' +
    '<div><dt>Dues</dt><dd>' + (m.due > 0 ? inr(m.due) : 'None') + '</dd></div>' +
    '<div><dt>Member since</dt><dd>' + fmtDate(parse(m.joined), true) + '</dd></div>' +
    '<div><dt>Last visit</dt><dd>' + visitText(lastVisit(m.id)) + '</dd></div>' +
    (m.notes ? '<div><dt>Notes</dt><dd>' + esc(m.notes) + '</dd></div>' : '') + '</dl>' +
    '<div class="btn-grid"><button class="btn primary" data-action="renew" data-id="' + m.id + '">Renew plan</button>' +
    (m.due > 0 ? '<button class="btn" data-action="collect" data-id="' + m.id + '">Collect ' + inr(m.due) + '</button>' : '') +
    waBtn(m, reminderText(m), 'WhatsApp reminder', '') +
    '<button class="btn" data-action="checkin-member" data-id="' + m.id + '">' + (c ? 'Undo check-in' : 'Check in today') + '</button></div>' +
    '<h3>Payments</h3><ul class="history">' + hist + '</ul>' +
    '<div class="btn-grid" style="margin-top:18px"><button class="btn" data-action="edit" data-id="' + m.id + '">Edit details</button><button class="btn" data-action="delete" data-id="' + m.id + '" data-confirm="Tap again to delete">Delete member</button></div>');
}

function showAdd() {
  var p = db.plans[0];
  openSheet('New member',
    '<div class="field"><label for="f-name">Full name</label><input id="f-name" autocomplete="off" placeholder="As written in the register"><p class="err" id="e-name"></p></div>' +
    '<div class="field"><label for="f-phone">WhatsApp number</label><input id="f-phone" inputmode="tel" autocomplete="off" placeholder="10-digit mobile number"><p class="err" id="e-phone"></p></div>' +
    '<div class="field"><label for="f-plan">Plan</label><select id="f-plan">' + planOptions(p.id) + '</select></div>' +
    '<div class="two"><div class="field"><label for="f-start">Start date</label><input id="f-start" type="date" value="' + iso(today()) + '"></div>' +
    '<div class="field"><label for="f-paid">Paid (\u20B9)</label><input id="f-paid" inputmode="numeric" value="' + p.price + '"></div></div>' +
    '<div class="field"><label for="f-mode">Paid by</label><select id="f-mode">' + modeOptions + '</select></div>' +
    '<div class="field"><label for="f-notes">Notes (optional)</label><input id="f-notes" autocomplete="off" placeholder="Goal, injury, trainer, anything useful"></div>' +
    '<p class="preview" id="preview"></p><button class="btn primary block" data-action="save-new" data-primary>Save member</button>');
  updatePreview();
}
function updatePreview() {
  var el = $('#preview'); if (!el) return;
  if ($('#f-plan')) {
    var plan = planById($('#f-plan').value), st = $('#f-start').value || iso(today());
    var ex = addMonths(parse(st), plan.months), due = Math.max(0, plan.price - money($('#f-paid').value));
    el.textContent = 'Plan runs until ' + fmtDate(ex, true) + (due > 0 ? '. Dues left: ' + inr(due) + '.' : '. Fully paid.');
  } else if ($('#r-plan')) {
    var m = findM($('#r-plan').dataset.id); if (!m) return;
    var pl = planById($('#r-plan').value), t = today(), cur = parse(m.expiry), s = cur >= t ? cur : t, e = addMonths(s, pl.months);
    var paid = money($('#r-paid').value), extra = Math.max(0, paid - pl.price), nd = Math.max(0, m.due - extra) + Math.max(0, pl.price - paid);
    el.textContent = 'New period: ' + fmtDate(s) + ' to ' + fmtDate(e, true) + (nd > 0 ? '. Dues after this: ' + inr(nd) + '.' : '. Nothing pending.');
  }
}
function saveNew(el) {
  var name = $('#f-name').value.trim(), ph = normPhone($('#f-phone').value);
  $('#e-name').textContent = name ? '' : 'Enter the member\u2019s name.';
  $('#e-phone').textContent = (!ph || ph.length === 10) ? '' : 'Use a 10-digit mobile number, or leave it blank.';
  if (!name || (ph && ph.length !== 10)) return;
  pending(el, true);
  api('POST', '/members', { name: name, phone: ph, planId: Number($('#f-plan').value), startDate: $('#f-start').value || iso(today()), paid: money($('#f-paid').value), mode: $('#f-mode').value, notes: $('#f-notes').value.trim() })
    .then(function (d) { var m = normMember(d); db.members.push(m); closeSheet(); render(); toast('Saved ' + first(m.name) + ' until ' + fmtDate(parse(m.expiry), true)); })
    .catch(function (e) { pending(el, false); toast(e.message); });
}
function showRenew(id) {
  var m = findM(id); if (!m) return;
  var p = planById(m.planId);
  openSheet('Renew ' + first(m.name),
    '<div class="field"><label for="r-plan">Plan</label><select id="r-plan" data-id="' + m.id + '">' + planOptions(p.id) + '</select></div>' +
    '<div class="two"><div class="field"><label for="r-paid">Paid (\u20B9)</label><input id="r-paid" inputmode="numeric" value="' + p.price + '"></div>' +
    '<div class="field"><label for="r-mode">Paid by</label><select id="r-mode">' + modeOptions + '</select></div></div>' +
    '<p class="preview" id="preview"></p><button class="btn primary block" data-action="save-renew" data-id="' + m.id + '" data-primary>Record payment and renew</button>');
  updatePreview();
}
function saveRenew(el, id) {
  pending(el, true);
  api('POST', '/members/' + id + '/renew', { planId: Number($('#r-plan').value), paid: money($('#r-paid').value), mode: $('#r-mode').value })
    .then(function (d) { var m = replaceMember(d); closeSheet(); render(); toast('Renewed ' + first(m.name) + ' until ' + fmtDate(parse(m.expiry), true)); })
    .catch(function (e) { pending(el, false); toast(e.message); });
}
function showCollect(id) {
  var m = findM(id); if (!m) return;
  openSheet('Collect dues',
    '<p class="meta" style="margin:0 0 14px">' + esc(m.name) + ' has ' + inr(m.due) + ' pending.</p>' +
    '<div class="two"><div class="field"><label for="c-amt">Amount received (\u20B9)</label><input id="c-amt" inputmode="numeric" value="' + m.due + '"></div>' +
    '<div class="field"><label for="c-mode">Paid by</label><select id="c-mode">' + modeOptions + '</select></div></div>' +
    '<button class="btn primary block" data-action="save-collect" data-id="' + m.id + '" data-primary>Record payment</button>');
}
function saveCollect(el, id) {
  var amt = money($('#c-amt').value); if (!amt) { toast('Enter the amount received.'); return; }
  pending(el, true);
  api('POST', '/members/' + id + '/collect', { amount: amt, mode: $('#c-mode').value })
    .then(function (d) { var m = replaceMember(d); closeSheet(); render(); toast('Recorded ' + inr(amt) + ' from ' + first(m.name)); })
    .catch(function (e) { pending(el, false); toast(e.message); });
}
function showEdit(id) {
  var m = findM(id); if (!m) return;
  openSheet('Edit ' + first(m.name),
    '<div class="field"><label for="e-n">Full name</label><input id="e-n" value="' + esc(m.name) + '" autocomplete="off"><p class="err" id="e-name"></p></div>' +
    '<div class="field"><label for="e-p">WhatsApp number</label><input id="e-p" inputmode="tel" value="' + esc(m.phone) + '" autocomplete="off"><p class="err" id="e-phone"></p></div>' +
    '<div class="field"><label for="e-x">Plan ends on</label><input id="e-x" type="date" value="' + m.expiry + '"></div>' +
    '<div class="field"><label for="e-o">Notes</label><input id="e-o" value="' + esc(m.notes) + '" autocomplete="off"></div>' +
    '<button class="btn primary block" data-action="save-edit" data-id="' + m.id + '" data-primary>Save changes</button>');
}
function saveEdit(el, id) {
  var name = $('#e-n').value.trim(), ph = normPhone($('#e-p').value);
  $('#e-name').textContent = name ? '' : 'Enter the member\u2019s name.';
  $('#e-phone').textContent = (!ph || ph.length === 10) ? '' : 'Use a 10-digit mobile number, or leave it blank.';
  if (!name || (ph && ph.length !== 10)) return;
  pending(el, true);
  api('PATCH', '/members/' + id, { name: name, phone: ph, notes: $('#e-o').value.trim(), expiry: $('#e-x').value })
    .then(function (d) { var m = replaceMember(d); showMember(m.id); render(); toast('Saved changes'); })
    .catch(function (e) { pending(el, false); toast(e.message); });
}

function planRow(p) {
  return '<div class="plan-row" data-pid="' + esc(p.id) + '"><input class="pn" aria-label="Plan name" value="' + esc(p.name) + '"><input class="pm" aria-label="Months" inputmode="numeric" value="' + p.months + '"><input class="pp" aria-label="Price in rupees" inputmode="numeric" value="' + p.price + '"><button class="btn sm" data-action="remove-plan" aria-label="Remove plan">Remove</button></div>';
}
function showSettings() {
  openSheet('Settings',
    '<p class="who-am-i">Logged in as ' + esc(db.user.name) + ' (' + esc(db.user.email) + ')</p>' +
    '<div class="field"><label for="s-gym">Gym name</label><input id="s-gym" value="' + esc(db.gym) + '" autocomplete="off"></div>' +
    '<h3 style="margin-top:6px">Plans</h3><p class="hint">Name, months, price in rupees.</p><div id="plan-rows">' + db.plans.map(planRow).join('') + '</div><p style="margin:0 0 16px"><button class="btn sm" data-action="add-plan">Add plan</button></p>' +
    '<div class="field"><label for="s-tpl">WhatsApp reminder text</label><textarea id="s-tpl">' + esc(db.template) + '</textarea><p class="meta" style="margin:0">Placeholders: {name} {plan} {gym} {when}</p></div>' +
    '<button class="btn primary block" data-action="save-settings" data-primary>Save settings</button>' +
    '<details><summary>Change password</summary><div class="field" style="margin-top:10px"><label for="pw-cur">Current password</label><input id="pw-cur" type="password" autocomplete="current-password"></div><div class="field"><label for="pw-new">New password (8+ characters)</label><input id="pw-new" type="password" autocomplete="new-password"></div><button class="btn sm" data-action="change-pw">Change password</button></details>' +
    '<details><summary>Backup</summary><p class="hint" style="margin-top:10px">Download every member, payment and visit as a file you can keep.</p><button class="btn sm" data-action="download">Download backup</button></details>' +
    '<div style="margin-top:18px"><button class="btn" data-action="logout">Log out</button></div>');
}
function saveSettings(el) {
  var plans = [].slice.call(document.querySelectorAll('.plan-row')).map(function (r) {
    return { id: r.dataset.pid ? Number(r.dataset.pid) : undefined, name: $('.pn', r).value.trim(), months: Math.max(1, parseInt($('.pm', r).value, 10) || 1), price: money($('.pp', r).value) };
  }).filter(function (p) { return p.name; });
  if (!plans.length) { toast('Keep at least one plan.'); return; }
  pending(el, true);
  api('PUT', '/settings', { gymName: $('#s-gym').value.trim(), template: $('#s-tpl').value.trim(), plans: plans })
    .then(function (d) {
      db.gym = d.gym.name; db.template = d.gym.template; db.plans = normPlans(d.plans);
      db.members.forEach(function (m) { if (m.planId && !db.plans.some(function (p) { return p.id === m.planId; })) m.planId = null; });
      closeSheet(); render(); toast('Saved settings');
    })
    .catch(function (e) { pending(el, false); toast(e.message); });
}
function downloadBackup() {
  fetch('/api/export', { headers: { Authorization: 'Bearer ' + token } })
    .then(function (r) { if (!r.ok) throw new Error('Could not create the backup.'); return r.blob(); })
    .then(function (b) {
      var a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'gym-desk-backup-' + iso(today()) + '.json';
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    }).catch(function (e) { toast(e.message); });
}

/* ---------- events ---------- */
document.addEventListener('click', function (e) {
  var el = e.target.closest('[data-action]'); if (!el) return;
  if (el.dataset.confirm && !el.dataset.armed) {
    el.dataset.armed = '1'; el.dataset.label = el.textContent; el.textContent = el.dataset.confirm; el.classList.add('armed');
    setTimeout(function () { if (el.isConnected && el.dataset.armed) { delete el.dataset.armed; el.textContent = el.dataset.label; el.classList.remove('armed'); } }, 4000);
    return;
  }
  var a = el.dataset.action, id = el.dataset.id;
  switch (a) {
    case 'tab': state.tab = el.dataset.tab; render(); window.scrollTo(0, 0); break;
    case 'add': showAdd(); break;
    case 'settings': showSettings(); break;
    case 'close': closeSheet(); break;
    case 'open': showMember(id); break;
    case 'renew': showRenew(id); break;
    case 'collect': showCollect(id); break;
    case 'edit': showEdit(id); break;
    case 'filter': state.filter = el.dataset.f; renderMembers(); break;
    case 'retry': boot(); break;
    case 'to-setup': authForm('setup'); break;
    case 'to-login': authForm('login'); break;
    case 'do-login': submitAuth(el, false); break;
    case 'do-setup': submitAuth(el, true); break;
    case 'logout': endSession(); break;
    case 'download': downloadBackup(); break;
    case 'save-new': saveNew(el); break;
    case 'save-renew': saveRenew(el, id); break;
    case 'save-collect': saveCollect(el, id); break;
    case 'save-edit': saveEdit(el, id); break;
    case 'save-settings': saveSettings(el); break;
    case 'add-plan': $('#plan-rows').insertAdjacentHTML('beforeend', planRow({ id: '', name: '', months: 1, price: 0 })); break;
    case 'remove-plan':
      if (document.querySelectorAll('.plan-row').length > 1) el.closest('.plan-row').remove(); else toast('Keep at least one plan.');
      break;
    case 'delete':
      pending(el, true);
      api('DELETE', '/members/' + id).then(function () {
        db.members = db.members.filter(function (m) { return m.id !== id; });
        db.checkins = db.checkins.filter(function (c) { return c.m !== id; });
        closeSheet(); render(); toast('Deleted member');
      }).catch(function (err) { pending(el, false); toast(err.message); });
      break;
    case 'checkin':
    case 'checkin-member': {
      var c = todayCheckin(id), m = findM(id);
      pending(el, true);
      (c ? api('DELETE', '/members/' + id + '/checkin') : api('POST', '/members/' + id + '/checkin')).then(function (r) {
        if (c) { db.checkins = db.checkins.filter(function (x) { return x !== c; }); toast('Removed today\u2019s check-in'); }
        else { db.checkins.push({ m: id, ts: r.ts }); toast('Checked in ' + first(m.name)); }
        if (a === 'checkin') updateCheckin(); else showMember(id);
      }).catch(function (err) { pending(el, false); toast(err.message); });
      break;
    }
    case 'change-pw': {
      var cur = $('#pw-cur').value, nw = $('#pw-new').value;
      if (nw.length < 8) { toast('New password must be at least 8 characters.'); break; }
      pending(el, true);
      api('POST', '/auth/password', { current: cur, next: nw }).then(function () { pending(el, false); $('#pw-cur').value = ''; $('#pw-new').value = ''; toast('Password changed'); })
        .catch(function (err) { pending(el, false); toast(err.message); });
      break;
    }
  }
});
document.addEventListener('input', function (e) {
  var id = e.target.id;
  if (id === 'q') { state.q = e.target.value; updateMembers(); }
  else if (id === 'cq') { state.cq = e.target.value; updateCheckin(); }
  else if (id === 'f-start' || id === 'f-paid' || id === 'r-paid') updatePreview();
});
document.addEventListener('change', function (e) {
  var id = e.target.id;
  if (id === 'f-plan') { $('#f-paid').value = planById(e.target.value).price; updatePreview(); }
  else if (id === 'r-plan') { $('#r-paid').value = planById(e.target.value).price; updatePreview(); }
  else if (id === 'f-start') updatePreview();
});
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') closeSheet();
  else if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
    var box = e.target.closest('.sheet, .authbox');
    var b = box && box.querySelector('[data-primary]');
    if (b) { e.preventDefault(); b.click(); }
  }
});
// Pick up changes made on another phone when this one comes back to the foreground.
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState !== 'visible' || !token || !db || Date.now() - state.fetchedAt < 30000) return;
  api('GET', '/bootstrap').then(function (d) { applyBootstrap(d); if ($('#sheetWrap').hidden) render(); }).catch(function () { /* stay quiet */ });
});

boot();
})();
