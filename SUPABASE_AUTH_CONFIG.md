# Supabase Auth — Session Length

The viewer (login, account, register, profile-edit, index) authenticates via
Supabase on the client. To make the session last "for the same day", two
layers have to agree:

## Client (already done — shipped in this commit)

`supabase-init.js` is the single source of truth for the Supabase client.

- One client, one stable `storageKey` (`ocean-mvp-auth`).
- `persistSession: true` + `autoRefreshToken: true` (explicit, not default).
- **Activity-based keep-alive**: any click / key / scroll / touch / mousemove
  refreshes the session in the background, debounced, max once per 30 min.
- **Tab coordination**: when multiple tabs are open, only the leader tab
  hits Supabase for refresh; the others piggyback on `BroadcastChannel` +
  the standard `storage` event. No more N tabs × N refreshes per hour.
- **Background tick** every 2 min: if the access token is within 5 min of
  expiry, refresh proactively.
- **Soft warning toast**: "Session expiring soon — Stay" with one click to
  refresh, instead of a hard redirect. Auto-mounted into `<body>`.
- **Graceful refresh failure**: if the refresh token is truly dead, the
  page's existing auth init bounces to `login.html` cleanly (no loops).

## Server (action needed in Supabase dashboard)

Client keep-alive can keep the user signed in for a long time, but the
**hard ceiling is the Supabase project's refresh-token expiry**. That setting
lives in the dashboard, not in code:

1. Open https://supabase.com/dashboard/project/wfdpfeptmyiqifgwqpzu
2. Go to **Authentication → Sign In / Up → Sessions**
3. Set:
   - **Access token (JWT) expiry**: keep 3600s (1h) — auto-refresh handles
     this transparently.
   - **Refresh token expiry**: bump to `2592000` (30 days). This is the
     real "stay signed in for the day" lever. Default on hosted Supabase
     is 28 days for paid plans, but verify the actual value shown in the
     dashboard — the Free tier sometimes has shorter defaults.

If you ever need to change this without a dashboard visit, the env vars
are `JWT_EXPIRY` and `REFRESH_TOKEN_EXPIRY` (in seconds) on the Supabase
project's API container.

## What changed in this commit

| File | Change |
|---|---|
| `supabase-init.js` | **NEW** — shared client, keep-alive, tab coordination, warning toast |
| `index.html` | Drop inline `createClient`; load `supabase-init.js`; reuse `window.sb` |
| `login.html` | Same |
| `account.html` | Same |
| `register.html` | Same |
| `profile-edit.html` | Same |

## Verifying the fix locally

After deploy (cache-bust the URL with `?v=20260610`):

1. Sign in once. Check `localStorage.getItem('ocean-mvp-auth')` in DevTools —
   the value should now be a non-empty object with `access_token`,
   `refresh_token`, `expires_at`.
2. Open DevTools → Network → filter `auth/v1`. Move the mouse around the
   page. You should see at most one `token?grant_type=refresh_token` per
   30 min, not one per page load.
3. Open the same site in 3 tabs. Only one tab (the leader) should fire
   refresh requests; the others stay silent and read the updated token
   from `localStorage`.
4. Wait for the access token to be < 5 min from expiry. A "Session
   expiring soon — Stay" toast should appear in the bottom-right.
   Click **Stay** → no redirect, no re-login.
