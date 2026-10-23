# Admin CMS & password reset (OTP) setup

## Admin access

- **URL:** `https://yourdomain.com/admin` (e.g. asoldi.com/admin)
- **Username:** `asoldi.com` (or `ADMIN_USERNAME`). There is no default password: on a first boot without `ADMIN_PASSWORD` the server writes a random one to `<dataDir>/secrets/initial-admin-password`.

Set these in production (e.g. Hostinger env or `.env`):

- `ADMIN_USERNAME` – admin login name (default: asoldi.com)
- `ADMIN_PASSWORD` – optional first-boot admin password (only used when no admin exists yet)
- `ADMIN_SECRET` – optional token-signing secret. When unset, the server generates one in `<dataDir>/secrets/admin-secret` and keeps it across deploys. Tokens expire after 30 days (`AUTH_TOKEN_MAX_AGE_DAYS`). Failed logins are rate-limited per account and IP.

On first run, if the admin data file does not exist yet, the server creates the default admin. Runtime data is stored outside the git-tracked app files by default, under `.builds/data` on the server, or in `APP_DATA_DIR` if you override it. After first login, change the password via **Admin → “Change my password”** in the sidebar.

## Users (employees)

- Only users listed in **Admin → Users** can log in at `/login` as “Ansatt”.
- Passwords are stored hashed (bcrypt); they are **not** visible in the CMS, only set or reset.
- You can add users, set/change their password, and delete users. When you implement OTP reset, updating the password in the CMS is the same as when they reset via email—both call the same backend and overwrite the stored hash.

## Running locally

- **Frontend only:** `npm run dev` (Vite on port 3000). Login/Admin API will not work unless the API is running.
- **API only (for use with Vite):** In a second terminal run `npm run dev:api` (Express on port 3001). Vite proxies `/api` to port 3001.
- **Production:** `npm run build` then `npm start`. One server serves both the built app and the API.

## Setting up OTP / email password reset

To add “Forgot password” with email OTP (e.g. with kontakt@asoldi.com or another domain):

### 1. Choose an SMTP provider

Use one of:

- **Nodemailer** with your own SMTP (e.g. your host’s SMTP, or a transactional provider).
- **SendGrid** – API key, good deliverability.
- **Mailgun** – API or SMTP.
- **Resend** – simple API.
- **Hostinger / your host** – if they give you SMTP (e.g. `mail.yourdomain.com`), use that with Nodemailer.

### 2. Install and configure

```bash
npm install nodemailer
```

Create a transporter (e.g. in `server.js` or `lib/email.js`):

```js
import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,      // e.g. smtp.hostinger.com or smtp.sendgrid.net
  port: Number(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,    // e.g. kontakt@asoldi.com
    pass: process.env.SMTP_PASS,
  },
});
```

Add to `.env` (and never commit real values):

- `SMTP_HOST`
- `SMTP_PORT` (often 587)
- `SMTP_USER` (e.g. kontakt@asoldi.com)
- `SMTP_PASS`
- Optionally `SMTP_FROM` (e.g. "Asoldi <kontakt@asoldi.com>")

### 3. OTP flow on the backend

- **Request OTP:** New endpoint e.g. `POST /api/auth/forgot-password` with `{ username }`.  
  - Find user by username.  
  - Generate a short-lived OTP (e.g. 6 digits, store in memory or in a small table with expiry, e.g. 10 minutes).  
  - Send email via `transporter.sendMail({ to: userEmail, subject: '...', text: 'Your code: 123456' })`.  
  - Return success (do not leak whether the user exists).
- **Verify OTP and set new password:** e.g. `POST /api/auth/reset-password` with `{ username, otp, newPassword }`.  
  - Verify OTP and expiry.  
  - Call the same logic you use in the CMS to update password: e.g. `await store.updateUserPassword(userId, newPassword)` (or update by username).  
  - Invalidate the OTP.  
  - Return success.

Then point the “Glemt passord?” page to a form that calls these two endpoints (request OTP → enter OTP + new password → submit). After a successful reset, the password is updated in the same store the CMS uses, so the new password works for “Ansatt” login and you can still change it again from Admin → Users.

### 4. Using a different “from” address

If you use kontakt@asoldi.com (or any other domain), configure that address in your host or email provider (Hostinger, etc.) and use the same credentials in `SMTP_USER` / `SMTP_PASS`. The “from” in `sendMail` should match the domain to avoid spam issues.

This setup is reusable: same admin and user store can be used on other projects; deploy with the same persistent app data directory and env and use `yourdomain.com/admin` for each.
