const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { withTx } = require('./db');
const { todayISO, isValidISO, addMonths } = require('./dates');

const DEFAULT_TEMPLATE = 'Hi {name}, your {plan} membership at {gym} {when}. Please renew at the counter or by UPI so you can carry on without a break.';
// Placeholder plans for a new gym. The owner edits names and prices in Settings.
const DEFAULT_PLANS = [['Monthly', 1, 800], ['Quarterly', 3, 2100], ['Half-yearly', 6, 3800], ['Yearly', 12, 6500]];
const MODES = ['Cash', 'UPI', 'Card'];

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => new HttpError(400, m);
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ---------- input cleaning ---------- */
function str(v, max, label, required) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (required && !s) throw bad(label + ' is required.');
  if (s.length > max) throw bad(label + ' is too long.');
  return s;
}
function int(v, label, min, max) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (!Number.isInteger(n) || n < min || n > max) throw bad(label + ' must be a whole number between ' + min + ' and ' + max + '.');
  return n;
}
function phone(v) {
  let d = String(v == null ? '' : v).replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d[0] === '0') d = d.slice(1);
  if (d && d.length !== 10) throw bad('Phone number must be 10 digits.');
  return d;
}
function mode(v) {
  if (v === undefined || v === null || v === '') return 'Cash';
  if (!MODES.includes(v)) throw bad('Payment mode must be Cash, UPI or Card.');
  return v;
}
function date(v, label) {
  if (!isValidISO(v)) throw bad(label + ' must be a valid date.');
  return v;
}
function idParam(req) {
  const n = Number(req.params.id);
  if (!Number.isInteger(n) || n < 1 || n > 2147483647) throw new HttpError(404, 'Not found.');
  return n;
}
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/* ---------- row -> JSON ---------- */
function memberDTO(m, pays) {
  return {
    id: m.id, name: m.name, phone: m.phone, planId: m.plan_id, plan: m.plan_name,
    start: m.start_date, expiry: m.expiry_date, joined: m.joined_on, due: m.due, notes: m.notes,
    payments: (pays || []).map((p) => ({ id: p.id, date: p.paid_on, amount: p.amount, plan: p.plan_name, months: p.months, mode: p.mode }))
  };
}

function createApp({ pool, jwtSecret, setupKey, authLimit = 30 }) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ['https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"]
      }
    }
  }));
  app.use(express.json({ limit: '100kb' }));

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, limit: authLimit, standardHeaders: true, legacyHeaders: false,
    message: { error: 'Too many attempts. Try again in a few minutes.' }
  });
  const sign = (p) => jwt.sign(p, jwtSecret, { expiresIn: '30d', algorithm: 'HS256' });
  const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

  const auth = wrap(async (req, res, next) => {
    const m = (req.headers.authorization || '').match(/^Bearer (.+)$/);
    if (!m) throw new HttpError(401, 'Please log in.');
    let p;
    try { p = jwt.verify(m[1], jwtSecret, { algorithms: ['HS256'] }); }
    catch (e) { throw new HttpError(401, 'Please log in again.'); }
    const r = await pool.query('select id, name, email, gym_id from users where id = $1 and gym_id = $2', [p.uid, p.gid]);
    if (!r.rowCount) throw new HttpError(401, 'Please log in again.');
    req.user = { id: r.rows[0].id, name: r.rows[0].name, email: r.rows[0].email };
    req.gymId = r.rows[0].gym_id;
    next();
  });

  /* ---------- public ---------- */
  app.get('/healthz', wrap(async (req, res) => { await pool.query('select 1'); res.json({ ok: true }); }));

  app.get('/api/auth/status', wrap(async (req, res) => {
    const r = await pool.query('select count(*) as n from gyms');
    res.json({ needsSetup: r.rows[0].n === 0 });
  }));

  app.post('/api/auth/register', authLimiter, wrap(async (req, res) => {
    if (!setupKey) throw new HttpError(403, 'Setup is turned off. Set the SETUP_KEY environment variable on the server.');
    const b = req.body || {};
    if (!safeEqual(typeof b.setupKey === 'string' ? b.setupKey : '', setupKey)) throw new HttpError(403, 'The setup key is not correct.');
    const gymName = str(b.gymName, 80, 'Gym name', true);
    const name = str(b.name, 80, 'Your name', true);
    const email = str(b.email, 120, 'Email', true).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('Enter a valid email address.');
    const pw = typeof b.password === 'string' ? b.password : '';
    if (pw.length < 8 || pw.length > 200) throw bad('Password must be at least 8 characters.');
    const hash = await bcrypt.hash(pw, 10);
    const ids = await withTx(pool, async (c) => {
      if ((await c.query('select 1 from users where lower(email) = $1', [email])).rowCount) throw new HttpError(409, 'That email is already registered.');
      const g = await c.query('insert into gyms (name) values ($1) returning id', [gymName]);
      const u = await c.query('insert into users (gym_id, name, email, password_hash) values ($1, $2, $3, $4) returning id', [g.rows[0].id, name, email, hash]);
      for (let i = 0; i < DEFAULT_PLANS.length; i++) {
        const p = DEFAULT_PLANS[i];
        await c.query('insert into plans (gym_id, name, months, price, position) values ($1, $2, $3, $4, $5)', [g.rows[0].id, p[0], p[1], p[2], i]);
      }
      return { uid: u.rows[0].id, gid: g.rows[0].id };
    });
    res.status(201).json({ token: sign(ids) });
  }));

  app.post('/api/auth/login', authLimiter, wrap(async (req, res) => {
    const b = req.body || {};
    const email = String(b.email || '').trim().toLowerCase();
    const pw = String(b.password || '');
    const r = await pool.query('select id, gym_id, password_hash from users where lower(email) = $1', [email]);
    const u = r.rows[0];
    const ok = await bcrypt.compare(pw, u ? u.password_hash : DUMMY_HASH);
    if (!u || !ok) throw new HttpError(401, 'Email or password is not correct.');
    res.json({ token: sign({ uid: u.id, gid: u.gym_id }) });
  }));

  /* ---------- everything below needs a login ---------- */
  app.use('/api', auth);

  app.post('/api/auth/password', wrap(async (req, res) => {
    const b = req.body || {};
    const next = typeof b.next === 'string' ? b.next : '';
    if (next.length < 8 || next.length > 200) throw bad('New password must be at least 8 characters.');
    const r = await pool.query('select password_hash from users where id = $1', [req.user.id]);
    if (!(await bcrypt.compare(String(b.current || ''), r.rows[0].password_hash))) throw new HttpError(400, 'Your current password is not correct.');
    await pool.query('update users set password_hash = $1 where id = $2', [await bcrypt.hash(next, 10), req.user.id]);
    res.json({ ok: true });
  }));

  async function loadAll(gid, checkinDays) {
    const checkinSql = checkinDays
      ? "select member_id as m, (extract(epoch from at) * 1000)::bigint as ts from checkins where gym_id = $1 and at >= now() - ($2 || ' days')::interval order by at"
      : 'select member_id as m, (extract(epoch from at) * 1000)::bigint as ts from checkins where gym_id = $1 order by at';
    const [g, pl, mem, pay, chk] = await Promise.all([
      pool.query('select id, name, template from gyms where id = $1', [gid]),
      pool.query('select id, name, months, price from plans where gym_id = $1 order by position, id', [gid]),
      pool.query('select * from members where gym_id = $1 order by lower(name), id', [gid]),
      pool.query('select * from payments where gym_id = $1 order by paid_on, id', [gid]),
      pool.query(checkinSql, checkinDays ? [gid, String(checkinDays)] : [gid])
    ]);
    const byMember = {};
    pay.rows.forEach((p) => { (byMember[p.member_id] = byMember[p.member_id] || []).push(p); });
    return {
      gym: g.rows[0], plans: pl.rows,
      members: mem.rows.map((m) => memberDTO(m, byMember[m.id])),
      checkins: chk.rows
    };
  }

  app.get('/api/bootstrap', wrap(async (req, res) => {
    const all = await loadAll(req.gymId, 60);
    res.json({ user: req.user, ...all });
  }));

  app.get('/api/export', wrap(async (req, res) => {
    const all = await loadAll(req.gymId, 0);
    res.setHeader('Content-Disposition', 'attachment; filename="gym-desk-backup-' + todayISO() + '.json"');
    res.json({ exportedAt: new Date().toISOString(), ...all });
  }));

  /* ---------- members ---------- */
  async function getPlan(c, gid, planId) {
    const id = int(planId, 'Plan', 1, 2147483647);
    const r = await c.query('select id, name, months, price from plans where id = $1 and gym_id = $2', [id, gid]);
    if (!r.rowCount) throw bad('Choose one of your plans.');
    return r.rows[0];
  }
  async function lockMember(c, gid, id) {
    const r = await c.query('select * from members where id = $1 and gym_id = $2 for update', [id, gid]);
    if (!r.rowCount) throw new HttpError(404, 'Member not found.');
    return r.rows[0];
  }
  async function memberById(c, gid, id) {
    const m = await c.query('select * from members where id = $1 and gym_id = $2', [id, gid]);
    if (!m.rowCount) throw new HttpError(404, 'Member not found.');
    const p = await c.query('select * from payments where member_id = $1 order by paid_on, id', [id]);
    return memberDTO(m.rows[0], p.rows);
  }

  app.post('/api/members', wrap(async (req, res) => {
    const b = req.body || {};
    const name = str(b.name, 80, 'Name', true);
    const ph = phone(b.phone);
    const notes = str(b.notes, 300, 'Notes', false);
    const paid = int(b.paid === undefined ? 0 : b.paid, 'Amount paid', 0, 10000000);
    const md = mode(b.mode);
    const today = todayISO();
    const start = b.startDate ? date(b.startDate, 'Start date') : today;
    const dto = await withTx(pool, async (c) => {
      const plan = await getPlan(c, req.gymId, b.planId);
      const expiry = addMonths(start, plan.months);
      const due = Math.max(0, plan.price - paid);
      const payDate = start <= today ? start : today;
      const m = await c.query(
        'insert into members (gym_id, name, phone, plan_id, plan_name, start_date, expiry_date, joined_on, due, notes) values ($1,$2,$3,$4,$5,$6,$7,$6,$8,$9) returning id',
        [req.gymId, name, ph, plan.id, plan.name, start, expiry, due, notes]);
      await c.query('insert into payments (gym_id, member_id, paid_on, amount, plan_name, months, mode) values ($1,$2,$3,$4,$5,$6,$7)',
        [req.gymId, m.rows[0].id, payDate, paid, plan.name, plan.months, md]);
      return memberById(c, req.gymId, m.rows[0].id);
    });
    res.status(201).json(dto);
  }));

  app.patch('/api/members/:id', wrap(async (req, res) => {
    const id = idParam(req);
    const b = req.body || {};
    const name = str(b.name, 80, 'Name', true);
    const ph = phone(b.phone);
    const notes = str(b.notes, 300, 'Notes', false);
    const expiry = date(b.expiry, 'Plan end date');
    const dto = await withTx(pool, async (c) => {
      await lockMember(c, req.gymId, id);
      await c.query('update members set name = $1, phone = $2, notes = $3, expiry_date = $4 where id = $5', [name, ph, notes, expiry, id]);
      return memberById(c, req.gymId, id);
    });
    res.json(dto);
  }));

  app.delete('/api/members/:id', wrap(async (req, res) => {
    const r = await pool.query('delete from members where id = $1 and gym_id = $2', [idParam(req), req.gymId]);
    if (!r.rowCount) throw new HttpError(404, 'Member not found.');
    res.json({ ok: true });
  }));

  app.post('/api/members/:id/renew', wrap(async (req, res) => {
    const id = idParam(req);
    const b = req.body || {};
    const paid = int(b.paid === undefined ? 0 : b.paid, 'Amount paid', 0, 10000000);
    const md = mode(b.mode);
    const today = todayISO();
    const dto = await withTx(pool, async (c) => {
      const m = await lockMember(c, req.gymId, id);
      const plan = await getPlan(c, req.gymId, b.planId);
      // Still active: the new period starts when the current one ends. Lapsed: starts today.
      const start = m.expiry_date >= today ? m.expiry_date : today;
      const expiry = addMonths(start, plan.months);
      const extra = Math.max(0, paid - plan.price);
      const due = Math.max(0, m.due - extra) + Math.max(0, plan.price - paid);
      await c.query('update members set plan_id = $1, plan_name = $2, start_date = $3, expiry_date = $4, due = $5 where id = $6',
        [plan.id, plan.name, start, expiry, due, id]);
      await c.query('insert into payments (gym_id, member_id, paid_on, amount, plan_name, months, mode) values ($1,$2,$3,$4,$5,$6,$7)',
        [req.gymId, id, today, paid, plan.name, plan.months, md]);
      return memberById(c, req.gymId, id);
    });
    res.json(dto);
  }));

  app.post('/api/members/:id/collect', wrap(async (req, res) => {
    const id = idParam(req);
    const b = req.body || {};
    const amount = int(b.amount, 'Amount', 1, 10000000);
    const md = mode(b.mode);
    const dto = await withTx(pool, async (c) => {
      const m = await lockMember(c, req.gymId, id);
      await c.query('update members set due = $1 where id = $2', [Math.max(0, m.due - amount), id]);
      await c.query("insert into payments (gym_id, member_id, paid_on, amount, plan_name, months, mode) values ($1,$2,$3,$4,'Dues',0,$5)",
        [req.gymId, id, todayISO(), amount, md]);
      return memberById(c, req.gymId, id);
    });
    res.json(dto);
  }));

  app.post('/api/members/:id/checkin', wrap(async (req, res) => {
    const id = idParam(req);
    if (!(await pool.query('select 1 from members where id = $1 and gym_id = $2', [id, req.gymId])).rowCount) throw new HttpError(404, 'Member not found.');
    const day = todayISO();
    await pool.query('insert into checkins (gym_id, member_id, day) values ($1, $2, $3) on conflict (member_id, day) do nothing', [req.gymId, id, day]);
    const r = await pool.query('select (extract(epoch from at) * 1000)::bigint as ts from checkins where member_id = $1 and day = $2', [id, day]);
    res.status(201).json({ m: id, ts: r.rows[0].ts });
  }));

  app.delete('/api/members/:id/checkin', wrap(async (req, res) => {
    const id = idParam(req);
    if (!(await pool.query('select 1 from members where id = $1 and gym_id = $2', [id, req.gymId])).rowCount) throw new HttpError(404, 'Member not found.');
    await pool.query('delete from checkins where member_id = $1 and day = $2', [id, todayISO()]);
    res.json({ ok: true });
  }));

  /* ---------- settings ---------- */
  app.put('/api/settings', wrap(async (req, res) => {
    const b = req.body || {};
    const gymName = str(b.gymName, 80, 'Gym name', true);
    const template = str(b.template, 500, 'Reminder text', false) || DEFAULT_TEMPLATE;
    if (!Array.isArray(b.plans) || b.plans.length < 1 || b.plans.length > 20) throw bad('Keep between 1 and 20 plans.');
    const items = b.plans.map((p, i) => ({
      id: p && p.id !== undefined && p.id !== null && p.id !== '' ? int(p.id, 'Plan id', 1, 2147483647) : null,
      name: str(p && p.name, 40, 'Plan name', true),
      months: int(p && p.months, 'Plan months', 1, 60),
      price: int(p && p.price, 'Plan price', 0, 10000000),
      position: i
    }));
    const out = await withTx(pool, async (c) => {
      const have = new Set((await c.query('select id from plans where gym_id = $1', [req.gymId])).rows.map((r) => r.id));
      const keep = [];
      for (const it of items) {
        if (it.id !== null) {
          if (!have.has(it.id)) throw bad('Unknown plan.');
          await c.query('update plans set name = $1, months = $2, price = $3, position = $4 where id = $5 and gym_id = $6', [it.name, it.months, it.price, it.position, it.id, req.gymId]);
          keep.push(it.id);
        } else {
          const r = await c.query('insert into plans (gym_id, name, months, price, position) values ($1,$2,$3,$4,$5) returning id', [req.gymId, it.name, it.months, it.price, it.position]);
          keep.push(r.rows[0].id);
        }
      }
      await c.query('delete from plans where gym_id = $1 and id <> all($2::int[])', [req.gymId, keep]);
      await c.query('update gyms set name = $1, template = $2 where id = $3', [gymName, template, req.gymId]);
      const pl = await c.query('select id, name, months, price from plans where gym_id = $1 order by position, id', [req.gymId]);
      return { gym: { id: req.gymId, name: gymName, template }, plans: pl.rows };
    });
    res.json(out);
  }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

  /* ---------- static frontend ---------- */
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err && err.code === '23505') return res.status(409).json({ error: 'That already exists.' });
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request was not valid JSON.' });
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'The request is too large.' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our side. Try again.' });
  });
  return app;
}
module.exports = { createApp };
