// member-portal.js
// Adds a client (member) portal + meal photo tracking to Gym Desk.
//
// Install:   npm i multer express-rate-limit
// Mount in server.js (before any catch-all/static fallback):
//     app.set('trust proxy', 1);
//     app.use('/', require('./member-portal')({ pool, staffAuth }));
//   pool      = your pg Pool
//   staffAuth = your existing middleware that allows only logged-in staff/trainers

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const rateLimit = require('express-rate-limit');

module.exports = function memberPortal({ pool, staffAuth }) {
  const router = express.Router();
  const jsonBody = express.json({ limit: '20kb' });
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 3 * 1024 * 1024, files: 1 },
  });

  const MAX_PHOTOS_PER_DAY = 12;
  const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack', 'meal'];
  const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

  // ---- EDIT HERE if your members table uses different column names -------------
  const pick = (o, keys) => {
    for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
    return null;
  };
  function mapMember(m) {
    return {
      name: pick(m, ['name', 'full_name']),
      plan: pick(m, ['plan_name', 'plan', 'plan_title']),
      start: pick(m, ['start_date', 'join_date', 'joined_on']),
      end: pick(m, ['end_date', 'expiry_date', 'expires_on', 'renewal_date']),
      due: pick(m, ['due_amount', 'dues', 'balance']),
    };
  }
  const PHONE_COLUMNS = ['phone', 'mobile', 'whatsapp'];
  // -------------------------------------------------------------------------------

  const looksLikeImage = (buf, mime) => {
    if (mime === 'image/jpeg') return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    if (mime === 'image/png') return buf.slice(0, 4).toString('hex') === '89504e47';
    if (mime === 'image/webp')
      return buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP';
    return false;
  };

  const memberLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
  });
  const badTokenLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    skipSuccessfulRequests: true, // only failed token attempts count
    standardHeaders: true,
    legacyHeaders: false,
  });

  // ---------------------------------------------------------------------------
  // MEMBER SIDE
  // ---------------------------------------------------------------------------
  async function memberAuth(req, res, next) {
    try {
      const token = req.get('x-member-token');
      if (!token || token.length < 20 || token.length > 128) return res.sendStatus(401);
      const { rows } = await pool.query('SELECT * FROM members WHERE access_token_hash = $1', [
        sha(token),
      ]);
      if (!rows[0]) return res.sendStatus(401);
      req.member = rows[0];
      next();
    } catch (e) {
      console.error('memberAuth error:', e.message);
      res.sendStatus(500);
    }
  }
  const guard = [memberLimiter, badTokenLimiter, memberAuth];

  // The member page itself (the token lives in the URL: /m/<token>)
  router.get('/m/:token', (req, res) => {
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, '..', 'public', 'member.html'));
  });

  // Subscription details
  router.get('/api/portal/me', guard, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(mapMember(req.member));
  });

  // List own meals (no image bytes, just metadata)
  router.get('/api/portal/me/meals', guard, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, meal_type, note, trainer_comment, created_at
           FROM meal_photos WHERE member_id = $1
          ORDER BY created_at DESC LIMIT 60`,
        [req.member.id]
      );
      res.set('Cache-Control', 'no-store');
      res.json(rows);
    } catch (e) {
      console.error(e.message);
      res.sendStatus(500);
    }
  });

  // Upload a meal photo
  router.post('/api/portal/me/meals', guard, (req, res) => {
    upload.single('photo')(req, res, async (err) => {
      if (err) return res.status(400).json({ error: 'Photo is too large or invalid.' });
      try {
        const f = req.file;
        if (!f || !looksLikeImage(f.buffer, f.mimetype))
          return res.status(400).json({ error: 'Please upload a JPEG, PNG or WebP photo.' });

        const { rows: cnt } = await pool.query(
          `SELECT count(*)::int AS n FROM meal_photos
            WHERE member_id = $1 AND created_at > now() - interval '24 hours'`,
          [req.member.id]
        );
        if (cnt[0].n >= MAX_PHOTOS_PER_DAY)
          return res.status(429).json({ error: 'Daily photo limit reached. Try again tomorrow.' });

        const mealType = MEAL_TYPES.includes(req.body.meal_type) ? req.body.meal_type : 'meal';
        const note = String(req.body.note || '').trim().slice(0, 300) || null;

        const { rows } = await pool.query(
          `INSERT INTO meal_photos (member_id, meal_type, note, image, mime)
           VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [req.member.id, mealType, note, f.buffer, f.mimetype]
        );
        res.status(201).json({ id: rows[0].id });
      } catch (e) {
        console.error(e.message);
        res.sendStatus(500);
      }
    });
  });

  // Serve own image (member must send the token header, so it cannot be guessed)
  router.get('/api/portal/me/meals/:id/image', guard, async (req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT image, mime FROM meal_photos WHERE id = $1 AND member_id = $2',
        [req.params.id, req.member.id]
      );
      if (!rows[0]) return res.sendStatus(404);
      res.set('Cache-Control', 'private, max-age=86400');
      res.type(rows[0].mime).send(rows[0].image);
    } catch (e) {
      res.sendStatus(500);
    }
  });

  // Delete own photo
  router.delete('/api/portal/me/meals/:id', guard, async (req, res) => {
    try {
      await pool.query('DELETE FROM meal_photos WHERE id = $1 AND member_id = $2', [
        req.params.id,
        req.member.id,
      ]);
      res.sendStatus(204);
    } catch (e) {
      res.sendStatus(500);
    }
  });

  // ---------------------------------------------------------------------------
  // STAFF / TRAINER SIDE (all behind your existing staffAuth)
  // ---------------------------------------------------------------------------

  // Minimal member list for the "Member links" tab
  router.get('/api/portal/members', staffAuth, async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT * FROM members ORDER BY id DESC LIMIT 1000');
      res.json(
        rows.map((m) => ({
          id: m.id,
          name: pick(m, ['name', 'full_name']),
          phone: pick(m, PHONE_COLUMNS),
          has_link: !!m.access_token_hash,
        }))
      );
    } catch (e) {
      console.error(e.message);
      res.sendStatus(500);
    }
  });

  // Create (or reset) a member's personal link. Resetting invalidates the old link.
  router.post('/api/portal/members/:id/link', staffAuth, async (req, res) => {
    try {
      const token = crypto.randomBytes(24).toString('hex');
      const { rows } = await pool.query(
        'UPDATE members SET access_token_hash = $1 WHERE id = $2 RETURNING *',
        [sha(token), req.params.id]
      );
      if (!rows[0]) return res.sendStatus(404);

      const link = `${req.protocol}://${req.get('host')}/m/${token}`;
      let phone = String(pick(rows[0], PHONE_COLUMNS) || '').replace(/\D/g, '');
      if (phone.length === 10) phone = '91' + phone; // assume India for 10-digit numbers
      const name = pick(rows[0], ['name', 'full_name']) || '';
      const text = `Hi ${name}, here is your personal Gym Desk link. Open it to see your membership and add your meal photos: ${link}`;
      res.json({
        link,
        whatsapp: phone ? `https://wa.me/${phone}?text=${encodeURIComponent(text)}` : null,
      });
    } catch (e) {
      console.error(e.message);
      res.sendStatus(500);
    }
  });

  // Meal feed (optionally for one member)
  router.get('/api/portal/meals', staffAuth, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit, 10) || 60, 200);
      const params = [limit];
      let where = '';
      if (req.query.member_id) {
        params.push(req.query.member_id);
        where = 'WHERE p.member_id = $2';
      }
      const { rows } = await pool.query(
        `SELECT p.id, p.member_id, p.meal_type, p.note, p.trainer_comment, p.created_at,
                COALESCE(to_jsonb(m)->>'name', to_jsonb(m)->>'full_name') AS member_name
           FROM meal_photos p JOIN members m ON m.id = p.member_id
           ${where}
          ORDER BY p.created_at DESC LIMIT $1`,
        params
      );
      res.json(rows);
    } catch (e) {
      console.error(e.message);
      res.sendStatus(500);
    }
  });

  router.get('/api/portal/meals/:id/image', staffAuth, async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT image, mime FROM meal_photos WHERE id = $1', [
        req.params.id,
      ]);
      if (!rows[0]) return res.sendStatus(404);
      res.set('Cache-Control', 'private, max-age=86400');
      res.type(rows[0].mime).send(rows[0].image);
    } catch (e) {
      res.sendStatus(500);
    }
  });

  router.post('/api/portal/meals/:id/comment', staffAuth, jsonBody, async (req, res) => {
    try {
      const comment = String(req.body.comment || '').trim().slice(0, 500) || null;
      await pool.query(
        'UPDATE meal_photos SET trainer_comment = $1, commented_at = now() WHERE id = $2',
        [comment, req.params.id]
      );
      res.sendStatus(200);
    } catch (e) {
      res.sendStatus(500);
    }
  });

  // Staff page for trainers (served as a static file; the API calls are what is protected)
  router.get('/trainer-meals', (req, res) =>
    res.sendFile(path.join(__dirname, '..', 'public', 'trainer-meals.html'))
  );

  return router;
};
