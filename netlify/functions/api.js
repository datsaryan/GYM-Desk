// Standby copy of Gym Desk for Netlify. It runs the same Express app against the same Neon database.
// It never runs migrations (Render does that on boot) and it can never create a new gym (setupKey is empty).
const serverless = require('serverless-http');
const { makePool } = require('../../server/db');
const { createApp } = require('../../server/app');

if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is required (use the same value as on Render).');
const app = createApp({ pool: makePool(), jwtSecret: process.env.JWT_SECRET, setupKey: '' });
const run = serverless(app);

// Netlify passes the visitor's address in headers. Express (and the login rate limiter) only look at
// the connection address, so copy it across. Without this every visitor would share one rate limit.
exports.handler = (event, context) => {
  const h = event.headers || {};
  const ip = h['x-nf-client-connection-ip'] || String(h['x-forwarded-for'] || '').split(',')[0].trim();
  if (ip) {
    const rc = event.requestContext || {};
    event.requestContext = { ...rc, identity: { ...(rc.identity || {}), sourceIp: ip } };
  }
  return run(event, context);
};
