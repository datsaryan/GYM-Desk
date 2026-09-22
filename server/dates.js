// Date helpers that work on plain 'YYYY-MM-DD' strings so time zones never shift a date.
const TZ = process.env.APP_TZ || 'Asia/Kolkata';

function todayISO(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now);
}
const parseISO = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const toISO = (d) => d.toISOString().slice(0, 10);
function isValidISO(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && toISO(parseISO(s)) === s;
}
// Adds calendar months, clamping to the last day (31 Jan + 1 month = 28/29 Feb).
function addMonths(iso, n) {
  const d = parseISO(iso);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d.getUTCDate(), last));
  return toISO(t);
}
module.exports = { TZ, todayISO, isValidISO, addMonths };
