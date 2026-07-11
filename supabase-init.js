/* supabase-init.js — shared Supabase client + session keep-alive
 *
 * Goals:
 *  1) One Supabase client, one storage key, one source of truth for the whole app.
 *  2) persistSession + autoRefreshToken are EXPLICIT (Supabase defaults can drift).
 *  3) Keep the session alive for the whole day with two mechanisms:
 *     a) Activity-based refresh: any user click/keypress/scroll/touch calls
 *        sb.auth.refreshSession() (debounced, max once per 30 min). This keeps
 *        the access token fresh and exercises the refresh token so it doesn't
 *        appear idle.
 *     b) Leader-tab coordination: when multiple tabs are open, only ONE tab
 *        (the leader) hits Supabase for refresh; other tabs listen on a
 *        BroadcastChannel and read the updated session from localStorage.
 *  4) Soft warning UI: when the access token is within 5 minutes of expiring,
 *     show a small "Session expiring soon — stay signed in?" toast with a
 *     button. If the user clicks it OR is active, we refresh. If they ignore
 *     it, we redirect to login.html once the token is actually dead.
 *  5) Server-side note: for the session to actually last > 24h, the Supabase
 *     project must have a long refresh-token expiry (default on hosted is
 *     28 days for paid, but verify in Dashboard → Authentication → Sign In/Up
 *     → Sessions → "Refresh token expiry"). This file can only keep the
 *     client active; the server decides the hard ceiling.
 *
 * Usage: include BEFORE the page's auth script.
 *   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
 *   <script src="supabase-init.js"></script>
 *   <script> window.sb.auth.getSession().then(...) </script>
 */
(function () {
  'use strict';

  const SUPABASE_URL = 'https://wfdpfeptmyiqifgwqpzu.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_W6wnJkT70jb69JUZgM1dow_nabPZycR';
  const APP_BASE_URL = 'https://livefishedge.github.io/view/';
  const STORAGE_KEY = 'ocean-mvp-auth'; // stable, app-wide
  const ACTIVITY_REFRESH_MIN_MS = 30 * 60 * 1000; // 30 min
  const EXPIRY_WARN_MS = 5 * 60 * 1000; // 5 min before JWT exp
  const TAB_CHANNEL = 'ocean-mvp-auth-tab';

  if (!window.supabase || !window.supabase.createClient) {
    console.error('[supabase-init] supabase-js not loaded; aborting init');
    return;
  }

  // ---------- One client, explicit options ----------
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storage: window.localStorage,
      storageKey: STORAGE_KEY,
      flowType: 'pkce',
    },
  });
  window.sb = sb;
  window.OMV_APP_BASE_URL = APP_BASE_URL;
  window.omvAuthRedirectUrl = function (path) {
    return new URL(path, APP_BASE_URL).href;
  };

  // ---------- Tab coordination ----------
  // Only the leader tab does network refreshes; others piggyback on
  // localStorage updates broadcast via the channel.
  let isLeader = false;
  let channel = null;
  try {
    channel = new BroadcastChannel(TAB_CHANNEL);
  } catch (e) {
    // Older browsers: fall back to storage events only.
    channel = null;
  }
  try {
    if (!sessionStorage.getItem(STORAGE_KEY + ':leader')) {
      sessionStorage.setItem(STORAGE_KEY + ':leader', '1');
      isLeader = true;
    }
  } catch (e) { /* sessionStorage may be unavailable; default to leader */ isLeader = true; }

  if (channel) {
    channel.addEventListener('message', (ev) => {
      if (!ev || !ev.data) return;
      if (ev.data.type === 'session-refreshed') {
        // Another tab refreshed; our local copy will be updated by
        // supabase-js's own storage listener. Nothing to do.
      } else if (ev.data.type === 'request-refresh') {
        if (isLeader) safeRefresh('tab-request');
      }
    });
  }

  // ---------- Activity-based keep-alive ----------
  let lastActivityRefresh = 0;
  let activityTimer = null;

  function scheduleActivityRefresh(reason) {
    if (activityTimer) return; // debounced
    activityTimer = setTimeout(() => {
      activityTimer = null;
      const now = Date.now();
      if (now - lastActivityRefresh < ACTIVITY_REFRESH_MIN_MS) return;
      // Only the leader actually hits the network.
      if (!isLeader) {
        if (channel) channel.postMessage({ type: 'request-refresh' });
        lastActivityRefresh = now; // pretend, so we don't spam leader
        return;
      }
      safeRefresh('activity:' + reason);
    }, 500); // debounce burst of events
  }

  ['click', 'keydown', 'scroll', 'touchstart', 'mousemove'].forEach((evt) => {
    window.addEventListener(evt, () => scheduleActivityRefresh(evt), { passive: true });
  });

  // ---------- Background tick (safety net) ----------
  // Even without user activity, check token expiry every 2 minutes and refresh
  // if it's within the EXPIRY_WARN_MS window. This protects users who are
  // watching a Play-loop or static map for long periods.
  setInterval(() => {
    if (!isLeader) return;
    sb.auth.getSession().then(({ data }) => {
      const s = data && data.session;
      if (!s) return;
      const msToExp = (s.expires_at ? s.expires_at * 1000 : 0) - Date.now();
      if (msToExp > 0 && msToExp < EXPIRY_WARN_MS) {
        safeRefresh('tick-near-expiry');
      }
    }).catch(() => {});
  }, 2 * 60 * 1000);

  // ---------- Core safe refresh ----------
  async function safeRefresh(reason) {
    try {
      const { data, error } = await sb.auth.refreshSession();
      if (error) {
        // Refresh failed → session is dead. Don't redirect here; let the
        // page's auth init detect the missing session and bounce to login.
        console.warn('[supabase-init] refresh failed:', reason, error.message);
        return null;
      }
      lastActivityRefresh = Date.now();
      if (channel) channel.postMessage({ type: 'session-refreshed', at: lastActivityRefresh });
      return data && data.session;
    } catch (e) {
      console.warn('[supabase-init] refresh threw:', reason, e && e.message);
      return null;
    }
  }

  // ---------- Soft warning toast ----------
  // Pages that want the warning can call window.OMV_auth.attachExpiryWarning().
  // Default: enabled, auto-mounted into <body> if not already present.
  function ensureToast() {
    let toast = document.getElementById('omv-session-toast');
    if (toast) return toast;
    toast = document.createElement('div');
    toast.id = 'omv-session-toast';
    toast.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2000',
      'max-width:320px', 'padding:12px 14px', 'border-radius:10px',
      'background:rgba(20,30,45,0.96)', 'color:#e0e6ee',
      'border:1px solid #f59e0b', 'box-shadow:0 8px 24px rgba(0,0,0,0.4)',
      'font:13px/1.4 system-ui,-apple-system,Segoe UI,sans-serif',
      'display:none', 'align-items:center', 'gap:10px',
    ].join(';');
    toast.innerHTML =
      '<span style="flex:1">Session expiring soon. Stay signed in?</span>' +
      '<button id="omv-session-stay" type="button" ' +
      'style="all:unset;cursor:pointer;padding:6px 10px;border-radius:6px;' +
      'background:#1a7f7a;color:#fff;font-weight:700;font-size:12px">Stay</button>' +
      '<button id="omv-session-dismiss" type="button" ' +
      'style="all:unset;cursor:pointer;padding:6px 8px;border-radius:6px;' +
      'color:#7a8fa6;font-size:12px">×</button>';
    document.body.appendChild(toast);
    toast.querySelector('#omv-session-stay').addEventListener('click', () => {
      safeRefresh('user-stay-clicked').then(() => hideToast());
    });
    toast.querySelector('#omv-session-dismiss').addEventListener('click', () => {
      hideToast();
    });
    return toast;
  }
  function showToast() {
    const t = ensureToast();
    t.style.display = 'flex';
  }
  function hideToast() {
    const t = document.getElementById('omv-session-toast');
    if (t) t.style.display = 'none';
  }
  // Watch session expiry and toggle toast.
  sb.auth.onAuthStateChange((_event, session) => {
    if (!session) { hideToast(); return; }
    const msToExp = (session.expires_at ? session.expires_at * 1000 : 0) - Date.now();
    if (msToExp > 0 && msToExp < EXPIRY_WARN_MS) showToast();
    else hideToast();
  });

  // ---------- Public helpers ----------
  window.OMV_auth = {
    sb,
    isLeader: () => isLeader,
    refresh: safeRefresh,
    showExpiryWarning: showToast,
    hideExpiryWarning: hideToast,
  };
})();
