/**
 * PASS Buddy Check — Cloudflare Worker
 * PASS Employee Location Safety Pilot — internal use only
 *
 * Milestone 0: Scaffolding
 * - Health check endpoint live
 * - Route stubs in place for all future milestones (commented out until built)
 * - Durable Object class exported
 * - Static app shell served for all non-API routes
 */

import { CheckinAlarmDO } from './workers/alarm.js';
import { handleRequestOtp, handleVerifyOtp, handleLogout } from './auth.js';
import { handleRegister, handleRosterImport } from './register.js';

// Required: Cloudflare must see the DO class exported from the entry point
export { CheckinAlarmDO };

// ─────────────────────────────────────────────────────────────────────────────
// Route table
// Each entry: [METHOD, '/path/:param', handlerFunction]
// Uncomment routes as milestones are completed.
// ─────────────────────────────────────────────────────────────────────────────
const routes = [
  // Health (M0)
  ['GET',   '/api/health',                    handleHealth],

  // Auth (M2)
  ['POST',  '/api/auth/request-otp',          handleRequestOtp],
  ['POST',  '/api/auth/verify-otp',           handleVerifyOtp],
  ['POST',  '/api/auth/logout',               handleLogout],

  // Registration (M3)
  ['POST',  '/api/register',                  handleRegister],

  // Check-in (M4)
  // ['POST',  '/api/checkin',                   handleCheckin],
  // ['GET',   '/api/checkin/active',            handleGetActiveCheckin],

  // ETA update (M5)
  // ['PATCH', '/api/checkin/:id/eta',           handleEtaUpdate],

  // Check-out (M6)
  // ['POST',  '/api/checkin/:id/checkout',      handleCheckout],

  // Active board (M8)
  // ['GET',   '/api/board',                     handleBoard],

  // Admin — members (M9)
  // ['GET',   '/api/admin/members',             handleAdminListMembers],
  // ['POST',  '/api/admin/members',             handleAdminAddMember],
  // ['PATCH', '/api/admin/members/:id',         handleAdminUpdateMember],

  // Admin — pending requests (M9)
  // ['GET',   '/api/admin/requests',            handleAdminListRequests],
  // ['POST',  '/api/admin/requests/:id/decide', handleAdminDecideRequest],

  // Admin — roster import (M3)
  ['POST',  '/api/admin/roster/import',       handleRosterImport],

  // Analytics (M12)
  // ['GET',   '/api/admin/analytics',           handleAdminAnalytics],
];

// ─────────────────────────────────────────────────────────────────────────────
// Main fetch handler
// ─────────────────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // All /api/* routes go through the API router
    if (url.pathname.startsWith('/api/')) {
      return routeApi(request, url, env);
    }

    // Everything else: serve the app shell
    // In M4, this is replaced by Workers Assets serving /public/
    return serveAppShell();
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// API router — simple path/method matching, no dependency needed
// ─────────────────────────────────────────────────────────────────────────────
async function routeApi(request, url, env) {
  try {
    for (const [method, pattern, handler] of routes) {
      const params = matchRoute(method, pattern, request.method, url.pathname);
      if (params !== null) {
        return await handler(request, env, params);
      }
    }
    return json({ error: 'Not found' }, 404);
  } catch (err) {
    console.error('[pass-buddy-check] API error:', err?.message ?? err);
    return json({ error: 'Internal server error' }, 500);
  }
}

/**
 * Match a route pattern against an incoming method + path.
 * Returns a params object on match, null on no match.
 * Supports :named segments (e.g., /api/checkin/:id/checkout).
 */
function matchRoute(method, pattern, reqMethod, reqPath) {
  if (method !== reqMethod) return null;
  const pp = pattern.split('/');
  const rp = reqPath.split('/');
  if (pp.length !== rp.length) return null;
  const params = {};
  for (let i = 0; i < pp.length; i++) {
    if (pp[i].startsWith(':')) {
      params[pp[i].slice(1)] = rp[i];
    } else if (pp[i] !== rp[i]) {
      return null;
    }
  }
  return params;
}

// ─────────────────────────────────────────────────────────────────────────────
// Handlers — M0 (health only)
// ─────────────────────────────────────────────────────────────────────────────
async function handleHealth(_request, env) {
  return json({
    ok:            true,
    app:           env.APP_NAME ?? 'PASS Buddy Check',
    sms_enabled:   env.SMS_ENABLED === 'true',
    email_enabled: env.EMAIL_ENABLED === 'true',
    timestamp:     new Date().toISOString(),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// App shell — placeholder until M4 builds the real UI
// ─────────────────────────────────────────────────────────────────────────────
function serveAppShell() {
  return new Response(APP_SHELL_HTML, {
    headers: {
      'Content-Type':           'text/html; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options':        'DENY',
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type':           'application/json',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Placeholder HTML — replaced in M4 by Workers Assets + real UI
// ─────────────────────────────────────────────────────────────────────────────
const APP_SHELL_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="theme-color" content="#1a2744" />
  <title>PASS Buddy Check</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #1a2744;
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100dvh;
      margin: 0;
      padding: 1rem;
    }
    .card {
      background: #243260;
      border-radius: 16px;
      padding: 2.5rem 2rem;
      max-width: 360px;
      width: 100%;
      text-align: center;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    }
    .badge {
      display: inline-block;
      background: #c8a951;
      color: #1a2744;
      font-size: 0.7rem;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      padding: 0.3rem 0.85rem;
      border-radius: 99px;
      margin-bottom: 1.25rem;
    }
    h1 { font-size: 1.75rem; margin: 0 0 0.5rem; font-weight: 700; }
    p  { color: #8899bb; margin: 0; font-size: 0.95rem; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">PASS Region IV</div>
    <h1>Buddy Check</h1>
    <p>Employee Location Safety Pilot<br>Coming soon.</p>
  </div>
</body>
</html>`;
