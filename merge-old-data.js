// merge-old-data.js
// Copies members, payments, check-ins (and gyms/users/plans they depend on) from your OLD
// Neon database into your NEW one, without touching anything already in the new database.
//
// Safe to try first: without --apply it only reports what it WOULD do and changes nothing.
//
//   OLD_DATABASE_URL="postgresql://...old..." \
//   NEW_DATABASE_URL="postgresql://...new..." \
//   node merge-old-data.js            # dry run (changes nothing)
//   node merge-old-data.js --apply    # really copies
//
// Run it from your GYM-Desk folder so it can find the "pg" package.

const { Client, types } = require('pg');
types.setTypeParser(1082, (v) => v); // keep DATE columns as plain "YYYY-MM-DD" text

const apply = process.argv.includes('--apply');
const OLD = process.env.OLD_DATABASE_URL;
const NEW = process.env.NEW_DATABASE_URL;

function die(msg) { console.error('\n' + msg + '\n'); process.exit(1); }
if (!OLD || !NEW) die('Set both OLD_DATABASE_URL and NEW_DATABASE_URL first (see the instructions at the top of this file).');
if (OLD === NEW) die('OLD_DATABASE_URL and NEW_DATABASE_URL are the same. They must be two different databases.');

const hostOf = (u) => { try { return new URL(u).host; } catch (e) { return '(unreadable)'; } };
const lc = (s) => String(s || '').trim().toLowerCase();

(async () => {
  const o = new Client({ connectionString: OLD });
  const n = new Client({ connectionString: NEW });
  console.log('OLD database host:', hostOf(OLD));
  console.log('NEW database host:', hostOf(NEW));
  console.log(apply ? 'MODE: APPLY (will write to the NEW database)\n' : 'MODE: DRY RUN (nothing will be changed)\n');

  try { await o.connect(); } catch (e) { die('Could not connect to the OLD database: ' + e.message + '\n(If it says quota/limit, the old project has not reset yet.)'); }
  try { await n.connect(); } catch (e) { die('Could not connect to the NEW database: ' + e.message); }

  const q = async (c, sql, p) => (await c.query(sql, p)).rows;

  const oGyms = await q(o, 'select * from gyms order by id');
  const oUsers = await q(o, 'select * from users order by id');
  const oPlans = await q(o, 'select * from plans order by id');
  const oMembers = await q(o, 'select * from members order by id');
  const oPays = await q(o, 'select * from payments order by id');
  const oChecks = await q(o, 'select * from checkins order by id');
  console.log(`Found in OLD: ${oGyms.length} gyms, ${oUsers.length} users, ${oPlans.length} plans, ${oMembers.length} members, ${oPays.length} payments, ${oChecks.length} check-ins\n`);

  const stats = { gymsNew: 0, gymsMatched: 0, usersAdded: 0, usersSkipped: 0, plansAdded: 0, plansMatched: 0, membersAdded: 0, membersSkipped: [], paysAdded: 0, paysSkipped: 0, checksAdded: 0 };
  const gymMap = new Map(), planMap = new Map(), memberMap = new Map(), skippedMembers = new Set();

  await n.query('begin');
  try {
    /* ---- gyms and users ---- */
    for (const g of oGyms) {
      const emails = oUsers.filter((u) => u.gym_id === g.id).map((u) => lc(u.email));
      let target = null;
      if (emails.length) {
        const r = await q(n, 'select gym_id from users where lower(email) = any($1::text[]) limit 1', [emails]);
        if (r.length) target = r[0].gym_id;
      }
      if (!target) {
        const r = await q(n, 'select id from gyms where lower(name) = $1 order by id limit 1', [lc(g.name)]);
        if (r.length) target = r[0].id;
      }
      if (target) { stats.gymsMatched++; }
      else {
        const r = await q(n, 'insert into gyms (name, template, created_at) values ($1,$2,$3) returning id', [g.name, g.template, g.created_at]);
        target = r[0].id; stats.gymsNew++;
      }
      gymMap.set(g.id, target);
    }
    for (const u of oUsers) {
      const exists = await q(n, 'select 1 from users where lower(email) = $1', [lc(u.email)]);
      if (exists.length) { stats.usersSkipped++; continue; }
      await n.query('insert into users (gym_id, name, email, password_hash, created_at) values ($1,$2,$3,$4,$5)',
        [gymMap.get(u.gym_id), u.name, u.email, u.password_hash, u.created_at]);
      stats.usersAdded++;
    }

    /* ---- plans ---- */
    for (const p of oPlans) {
      const gid = gymMap.get(p.gym_id);
      const r = await q(n, 'select id from plans where gym_id = $1 and lower(name) = $2 and months = $3 order by id limit 1', [gid, lc(p.name), p.months]);
      if (r.length) { planMap.set(p.id, r[0].id); stats.plansMatched++; continue; }
      const pos = await q(n, 'select coalesce(max(position), -1) + 1 as p from plans where gym_id = $1', [gid]);
      const ins = await q(n, 'insert into plans (gym_id, name, months, price, position) values ($1,$2,$3,$4,$5) returning id', [gid, p.name, p.months, p.price, pos[0].p]);
      planMap.set(p.id, ins[0].id); stats.plansAdded++;
    }

    /* ---- members (skip ones that already exist in the new database) ---- */
    for (const m of oMembers) {
      const gid = gymMap.get(m.gym_id);
      const dup = m.phone
        ? await q(n, 'select id from members where gym_id = $1 and lower(name) = $2 and phone = $3 limit 1', [gid, lc(m.name), m.phone])
        : await q(n, "select id from members where gym_id = $1 and lower(name) = $2 and phone = '' and joined_on = $3 limit 1", [gid, lc(m.name), m.joined_on]);
      if (dup.length) { skippedMembers.add(m.id); stats.membersSkipped.push(m.name + (m.phone ? ' (' + m.phone + ')' : '')); continue; }
      const ins = await q(n,
        `insert into members (gym_id, name, phone, plan_id, plan_name, start_date, expiry_date, joined_on, due, notes, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
        [gid, m.name, m.phone, m.plan_id ? (planMap.get(m.plan_id) || null) : null, m.plan_name, m.start_date, m.expiry_date, m.joined_on, m.due, m.notes, m.created_at]);
      memberMap.set(m.id, ins[0].id); stats.membersAdded++;
    }

    /* ---- payments and check-ins for the members we copied ---- */
    for (const p of oPays) {
      if (!memberMap.has(p.member_id)) { stats.paysSkipped++; continue; }
      await n.query('insert into payments (gym_id, member_id, paid_on, amount, plan_name, months, mode, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8)',
        [gymMap.get(p.gym_id), memberMap.get(p.member_id), p.paid_on, p.amount, p.plan_name, p.months, p.mode, p.created_at]);
      stats.paysAdded++;
    }
    for (const c of oChecks) {
      if (!memberMap.has(c.member_id)) continue;
      const r = await n.query('insert into checkins (gym_id, member_id, at, day) values ($1,$2,$3,$4) on conflict (member_id, day) do nothing',
        [gymMap.get(c.gym_id), memberMap.get(c.member_id), c.at, c.day]);
      stats.checksAdded += r.rowCount;
    }

    console.log('Gyms:     ' + stats.gymsMatched + ' matched existing, ' + stats.gymsNew + ' created');
    console.log('Users:    ' + stats.usersAdded + ' added, ' + stats.usersSkipped + ' already existed (kept as they are)');
    console.log('Plans:    ' + stats.plansAdded + ' added, ' + stats.plansMatched + ' matched existing');
    console.log('Members:  ' + stats.membersAdded + ' copied, ' + stats.membersSkipped.length + ' skipped (already in the new database)');
    console.log('Payments: ' + stats.paysAdded + ' copied, ' + stats.paysSkipped + ' skipped (belong to skipped members)');
    console.log('Check-ins: ' + stats.checksAdded + ' copied');
    if (stats.membersSkipped.length) console.log('\nSkipped members (already present, review if needed):\n  - ' + stats.membersSkipped.join('\n  - '));

    if (apply) { await n.query('commit'); console.log('\nDONE. The data has been copied into the NEW database.'); }
    else { await n.query('rollback'); console.log('\nDRY RUN finished. Nothing was changed. Run again with --apply to copy for real.'); }
  } catch (e) {
    await n.query('rollback').catch(() => {});
    console.error('\nFAILED, and nothing was changed in the NEW database:', e.message);
    process.exitCode = 1;
  } finally {
    await o.end().catch(() => {}); await n.end().catch(() => {});
  }
})();
