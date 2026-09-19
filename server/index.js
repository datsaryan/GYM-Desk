const { makePool, migrate } = require('./db');
const { createApp } = require('./app');

(async () => {
  let secret = process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'development') {
      secret = 'dev-only-secret-not-for-production';
      console.warn('JWT_SECRET not set. Using an insecure development secret.');
    } else {
      console.error('JWT_SECRET is required. Set it to a long random string.');
      process.exit(1);
    }
  }
  const pool = makePool();
  await migrate(pool);
  const app = createApp({ pool, jwtSecret: secret, setupKey: process.env.SETUP_KEY || '' });
  const port = Number(process.env.PORT) || 3000;
  const server = app.listen(port, () => console.log('Gym Desk listening on port ' + port));
  const stop = () => server.close(() => pool.end().then(() => process.exit(0)));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
})().catch((e) => { console.error(e); process.exit(1); });
