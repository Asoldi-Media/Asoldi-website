# Security – Exposed Secrets (Resolved)

GitHub/Google may have alerted you because **these were previously committed** and are now removed or replaced with placeholders. If you had already pushed the repo, assume they were exposed and take the steps below.

## 1. Firebase (firebase-applet-config.json)

**What was exposed:** Firebase client config (apiKey, projectId, appId, authDomain, etc.) for project `marketing-automation-472214`.

**What we did:** Replaced the file with placeholders. Use either:

- **Option A – Local file (do not commit):** Copy `firebase-applet-config.example.json` to `firebase-applet-config.json`, fill in real values from [Firebase Console](https://console.firebase.google.com/) → Project settings. Add `firebase-applet-config.json` to `.gitignore` if you want to keep a local real config.
- **Option B – Env vars:** Set build-time env vars (e.g. in Hostinger or CI) and have the app read from `import.meta.env` (see below).

**Rotate / restrict (recommended):**

1. In [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Credentials, find the **API key** that was in the config.
2. Restrict it: Application restrictions (e.g. HTTP referrers for your domains) and/or API restrictions (only the APIs you need, e.g. Firebase).
3. Or create a new key, update your Firebase app config, and delete the old key.

Firebase client API keys are meant to be used in frontend code; restricting them by domain/API limits abuse.

---

## 2. Admin email (firestore.rules)

**What was exposed:** An admin email address used in Firestore security rules.

**What we did:** Replaced it with the placeholder `YOUR_ADMIN_EMAIL` in `firestore.rules`.

**What you should do:** Before deploying rules, replace `YOUR_ADMIN_EMAIL` in `firestore.rules` with the real admin email, then run:

```bash
firebase deploy --only firestore:rules
```

Do not commit the real email if the repo is public; use a private repo or deploy rules from a local/CI environment where the file is not pushed.

---

## 3. GEMINI_API_KEY

**Status:** Optional since 2026-11-19: only audio and video of client uploads use Gemini; pictures use `ANTHROPIC_API_KEY`. Only placeholders were in the repo (`.env.example` with `MY_GEMINI_API_KEY`). Real keys should live in:

- Local: `.env.local` (in `.gitignore`)
- Hosting: Environment variables in your host (e.g. Hostinger) or GitHub Actions secrets.

Never commit `.env` or `.env.local` with real values.

---

## Summary

| Item              | Action taken                    | Your action                                      |
|-------------------|----------------------------------|--------------------------------------------------|
| Firebase config   | Replaced with placeholders       | Restrict/rotate key; use env or local file       |
| Admin email       | Replaced with YOUR_ADMIN_EMAIL   | Set real email when deploying rules (don’t commit if public) |
| GEMINI_API_KEY    | Only example in repo            | Keep real key in env only                        |
