# PASS Buddy Check

**PASS Employee Location Safety Pilot — internal use only.**
Do not share with FAA management or agency personnel without explicit direction
from Ben Struck.

---

## What this is

A standalone web-based check-in/check-out system for FAA field workers.
Members check in before visiting a remote or higher-risk location, designate a
buddy, and receive automatic alerts if they don't check out on time.

Part of the PASS Employee Location Safety Pilot (Phase 2).
Location library portal: `what3words.passregioniv.workers.dev` (separate repo).

---

## First-time setup

### 1. Prerequisites
- Node.js 20+
- Wrangler CLI: `npm install -g wrangler`
- Cloudflare account (Workers Paid plan — $5/mo; required for Durable Objects)

### 2. Clone and install
```bash
git clone https://github.com/YOUR-ORG/pass-buddy-check.git
cd pass-buddy-check
npm install
```

### 3. Create the D1 database
```bash
npm run db:create
```
Copy the `database_id` from the output and paste it into `wrangler.toml`:
```toml
database_id = "paste-id-here"
```

### 4. Run the database migration
```bash
npm run db:migrate:local   # local dev
npm run db:migrate         # production (after deploy)
```

### 5. Generate VAPID keys for Web Push
```bash
npm run vapid:gen
```
Set the output values as Wrangler secrets:
```bash
wrangler secret put VAPID_PUBLIC_KEY
wrangler secret put VAPID_PRIVATE_KEY
wrangler secret put VAPID_SUBJECT    # enter: mailto:bstruck@passnational.org
```

### 6. Set remaining secrets
```bash
wrangler secret put JWT_SECRET       # any random string, 32+ characters
```

### 7. Run locally
```bash
npm run dev
# → http://localhost:8787
# → http://localhost:8787/api/health   (verify deploy)
```

### 8. Deploy to production
```bash
npm run deploy
```

---

## GitHub auto-deploy (one-time setup)

After the repo is on GitHub, push to `main` auto-deploys via GitHub Actions.

**One manual step:**
1. Go to: GitHub repo → **Settings → Secrets and variables → Actions**
2. Click **New repository secret**
3. Name: `CLOUDFLARE_API_TOKEN`
   Value: a Cloudflare API token with `Workers Scripts:Edit` + `D1:Edit` permissions
   (Create at: Cloudflare dashboard → My Profile → API Tokens → Create Token)

After that, every `git push origin main` deploys automatically.

---

## Secrets reference

| Secret | Required for | Set with |
|---|---|---|
| `JWT_SECRET` | Session tokens | `wrangler secret put JWT_SECRET` |
| `VAPID_PUBLIC_KEY` | Web Push | `wrangler secret put VAPID_PUBLIC_KEY` |
| `VAPID_PRIVATE_KEY` | Web Push | `wrangler secret put VAPID_PRIVATE_KEY` |
| `VAPID_SUBJECT` | Web Push | `wrangler secret put VAPID_SUBJECT` |
| `TWILIO_ACCOUNT_SID` | SMS (Phase 2) | `wrangler secret put TWILIO_ACCOUNT_SID` |
| `TWILIO_AUTH_TOKEN` | SMS (Phase 2) | `wrangler secret put TWILIO_AUTH_TOKEN` |
| `TWILIO_VERIFY_SID` | SMS (Phase 2) | `wrangler secret put TWILIO_VERIFY_SID` |
| `TWILIO_FROM_NUMBER` | SMS (Phase 2) | `wrangler secret put TWILIO_FROM_NUMBER` |
| `RESEND_API_KEY` | Email (Phase 2) | `wrangler secret put RESEND_API_KEY` |

---

## SMS / email stub mode

During the pilot, SMS and email are specced but not active:
- `SMS_ENABLED=false` (default in `wrangler.toml`): SMS payloads are formatted
  and logged to the Worker console. Nothing is sent. No Twilio account needed.
- `EMAIL_ENABLED=false`: same for email.

To activate Phase 2 SMS: add Twilio secrets above, then set
`SMS_ENABLED = "true"` in `wrangler.toml` and redeploy.

---

## URLs

| URL | Purpose |
|---|---|
| `pass-buddy-check.passregioniv.workers.dev` | Member check-in/out |
| `pass-buddy-check.passregioniv.workers.dev/board` | Active safety board (Cloudflare Access) |
| `pass-buddy-check.passregioniv.workers.dev/admin` | Admin panel (Cloudflare Access) |

---

## Build milestones

- **M0** ✅ Scaffolding, schema, deploy pipeline
- **M1** Database schema verified, test seed
- **M2** SMS OTP auth
- **M3** Self-service registration + Velarium roster import
- **M4** Check-in flow UI
- **M5** ETA update
- **M6** Check-out
- **M7** Durable Object alarms (reminder + overdue)
- **M8** Active board
- **M9** Admin panel
- **M10** PWA + Web Push
- **M11** Purge job
- **M12** Analytics view
- **M13** Hardening + pilot (Ben, Chris, Brent, Cherrie, Ezra)
- **M14** SMS activation (Phase 2)
- **M15** Email activation (Phase 2)
- **M16** Cloudflare Access expansion — FRs + safety contacts (Phase 2)
