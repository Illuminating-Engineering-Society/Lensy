/**
 * Lensy SSO auth gate — include FIRST in <head> of every gated page:
 *   <script src="/utils/auth-gate.js"></script>
 *
 * Staff pages under /admin add the admin requirement:
 *   <script src="/utils/auth-gate.js" data-require-admin></script>
 *
 * Hides the entire page until GET /api/auth/me confirms an authorized IdP
 * session (ies_auth cookie from auth.ies.org), then reveals the app and adds
 * a user chip + Sign out to the header nav. Unauthenticated visitors get a
 * branded sign-in screen; authenticated-but-not-invited visitors get an
 * access-denied screen; with data-require-admin, signed-in non-admins get an
 * "administrators only" screen. The API is gated server-side too (every
 * /api/admin/* route runs requireAdminAccess) — this overlay is UX, not the
 * security boundary.
 */
(function () {
  'use strict';

  var GATE_ID = 'lensy-auth-gate';
  // Read before any await: document.currentScript is only set while the tag
  // is executing.
  var REQUIRE_ADMIN =
    !!(document.currentScript && document.currentScript.hasAttribute('data-require-admin'));
  // Pages carrying `data-public-when-share` stay open to anyone arriving on a
  // share link (client DO52): a shared collection is references and links, and
  // the whole point of sending one is that the recipient can read it. Saving it
  // into an account still requires signing in — the page asks for that itself.
  var PUBLIC_WHEN_SHARE =
    !!(document.currentScript && document.currentScript.hasAttribute('data-public-when-share'));

  // Hide everything before first paint. The gate overlay is exempt.
  document.documentElement.classList.add('auth-pending');
  var style = document.createElement('style');
  style.textContent =
    '.auth-pending body > :not(#' + GATE_ID + ') { display: none !important; }' +
    '#' + GATE_ID + ' { position: fixed; inset: 0; z-index: 9999; display: flex;' +
    ' align-items: center; justify-content: center; background: #F7F7F7;' +
    ' font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #2C2C2C; }' +
    'html:not(.auth-pending) #' + GATE_ID + ' { display: none; }';
  document.head.appendChild(style);

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var LOGO =
    '<div style="width:52px;height:52px;margin:0 auto 14px;border-radius:14px;background:#3A5068;display:flex;align-items:center;justify-content:center">' +
    '<svg style="width:30px;height:30px;color:#fff" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8">' +
    '<path stroke-linecap="round" stroke-linejoin="round" d="M12 3v1m0 16v1M4.22 4.22l.707.707M18.364 18.364l.707.707M3 12H2m20 0h-1M4.927 19.073l.707-.707M18.364 5.636l.707-.707M12 8a4 4 0 100 8 4 4 0 000-8z"/>' +
    '</svg></div>';

  function card(inner) {
    return (
      '<div style="max-width:400px;width:calc(100% - 32px);background:#fff;border-radius:16px;' +
      'box-shadow:0 4px 16px rgba(44,44,44,0.10);padding:36px 32px;text-align:center">' +
      LOGO + inner + '</div>'
    );
  }

  var BTN =
    'display:inline-block;margin-top:18px;padding:12px 22px;border-radius:10px;border:0;' +
    'background:#D95D2B;color:#fff;font-weight:600;font-size:15px;cursor:pointer;text-decoration:none';

  function gateEl() {
    var el = document.getElementById(GATE_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = GATE_ID;
      document.body.appendChild(el);
    }
    return el;
  }

  function showChecking() {
    gateEl().innerHTML = card(
      '<p style="color:#6b7280;font-size:14px;margin:0">Checking your session…</p>'
    );
  }

  function isLocalhost() {
    var h = location.hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
  }

  function showLogin(loginUrl) {
    var devBtn = isLocalhost()
      ? '<div><button id="lensy-dev-login" style="' + BTN +
        ';background:#3A5068;margin-top:10px;font-size:13px;padding:9px 16px">Dev login (local only)</button></div>'
      : '';
    gateEl().innerHTML = card(
      '<h1 style="font-size:22px;font-weight:700;margin:0 0 6px;letter-spacing:-0.01em">Lensy</h1>' +
      '<p style="color:#6b7280;font-size:14px;margin:0 0 4px">IES Standards Assistant</p>' +
      '<p style="color:#6b7280;font-size:14px;margin:12px 0 0">Sign in with your IES account to search the standards library.</p>' +
      '<div><a href="' + esc(loginUrl || '/login') + '" style="' + BTN + '">Sign in with IES</a></div>' +
      // IES sign-in is now first-party (auth.ies.org): every pre-existing
      // account sets a new password once, from an emailed link. Framing that
      // here keeps the detour from reading as a failure.
      '<p style="color:#9ca3af;font-size:12px;margin:16px 0 0;line-height:1.5">' +
      'First time since the IES sign-in upgrade? You&rsquo;ll be asked to set a new ' +
      'password &mdash; look for an email from IES after entering your address.</p>' +
      devBtn
    );
    var dev = document.getElementById('lensy-dev-login');
    if (dev) {
      dev.addEventListener('click', function () {
        // On an admin page, mint the cookie the page needs — otherwise local
        // dev could never reach /admin/*.
        var roles = REQUIRE_ADMIN ? ['member', 'administrator'] : ['member'];
        fetch('/api/auth/dev-login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'dev@example.com', isMember: true, roles: roles }),
        }).then(function () { location.reload(); });
      });
    }
  }

  // The ies_auth cookie is present and genuinely from the IdP, but this Worker
  // cannot read it — SESSION_ENCRYPTION_KEY / COOKIE_SIGNING_SECRET drifted out
  // of step with auth.ies.org. Signing in again cannot help, so don't offer it.
  function showMisconfigured(data) {
    gateEl().innerHTML = card(
      '<h1 style="font-size:20px;font-weight:700;margin:0 0 10px">Sign-in unavailable</h1>' +
      '<p style="color:#6b7280;font-size:14px;margin:0">Lensy cannot verify IES sign-in right now. ' +
      'This is a configuration problem on our side, not with your account.</p>' +
      '<p style="color:#9ca3af;font-size:12px;margin:12px 0 0">Please try again shortly, or contact ' +
      '<a href="mailto:Standards@ies.org" style="color:#3A5068">Standards@ies.org</a> if it persists.' +
      (data && data.detail ? ' (' + esc(data.detail) + ')' : '') + '</p>' +
      '<div><button onclick="location.reload()" style="' + BTN + '">Retry</button></div>'
    );
  }

  var DENY_TEXT = {
    revoked: 'Your access to Lensy has been revoked.',
    expired: 'Your guest access to Lensy has expired.',
    not_invited: 'Your IES account is signed in, but it does not have access to Lensy yet.',
  };

  function showDenied(data) {
    var msg = DENY_TEXT[data.reason] || DENY_TEXT.not_invited;
    gateEl().innerHTML = card(
      '<h1 style="font-size:20px;font-weight:700;margin:0 0 10px">No access</h1>' +
      '<p style="color:#6b7280;font-size:14px;margin:0">' + esc(msg) + '</p>' +
      (data.email ? '<p style="color:#9ca3af;font-size:12px;margin:10px 0 0">Signed in as ' + esc(data.email) + '</p>' : '') +
      '<p style="color:#6b7280;font-size:13px;margin:14px 0 0">Contact IES staff to request an invitation.</p>' +
      '<div><a href="' + esc(data.logoutUrl || '/logout') + '" style="' + BTN + ';background:#3A5068">Sign out</a></div>'
    );
  }

  // Signed in and allowed into Lensy, but this page is staff-only. Signing in
  // again changes nothing, so the way out is back to the app — not /login.
  function showNotAdmin(data) {
    var user = data.user || {};
    gateEl().innerHTML = card(
      '<h1 style="font-size:20px;font-weight:700;margin:0 0 10px">Administrators only</h1>' +
      '<p style="color:#6b7280;font-size:14px;margin:0">This is an IES staff page. Your account ' +
      'does not have the administrator role.</p>' +
      (user.email
        ? '<p style="color:#9ca3af;font-size:12px;margin:10px 0 0">Signed in as ' + esc(user.email) + '</p>'
        : '') +
      '<div><a href="/" style="' + BTN + '">Back to Lensy</a></div>' +
      '<p style="margin:12px 0 0"><a href="' + esc(data.logoutUrl || '/logout') +
      '" style="color:#3A5068;font-size:13px">Sign in as someone else</a></p>'
    );
  }

  function showError() {
    gateEl().innerHTML = card(
      '<h1 style="font-size:20px;font-weight:700;margin:0 0 10px">Something went wrong</h1>' +
      '<p style="color:#6b7280;font-size:14px;margin:0">Could not verify your session.</p>' +
      '<div><button onclick="location.reload()" style="' + BTN + '">Retry</button></div>'
    );
  }

  function addUserChip(data) {
    var nav = document.querySelector('header nav');
    if (!nav || document.getElementById('lensy-user-chip')) return;
    var chip = document.createElement('span');
    chip.id = 'lensy-user-chip';
    chip.className = 'flex items-center gap-2 pl-3 ml-1 border-l border-white/20 text-blue-200';
    chip.innerHTML =
      '<span class="hidden md:inline text-xs" title="' + esc(data.user.email) + '">' + esc(data.user.name) + '</span>' +
      '<a href="' + esc(data.logoutUrl || '/logout') + '" ' +
      'class="px-3 py-1.5 rounded-md text-blue-200 hover:text-white hover:bg-white/10 transition">Sign out</a>';
    nav.appendChild(chip);
  }

  function reveal(data) {
    document.documentElement.classList.remove('auth-pending');
    var el = document.getElementById(GATE_ID);
    if (el) el.remove();
    addUserChip(data);
    window.lensyUser = data.user;
    document.dispatchEvent(new CustomEvent('lensy:auth', { detail: data.user }));
  }

  /**
   * Reveal the page to a visitor with no Lensy access, for a share link only
   * (client DO52). `window.lensyAnonymous` tells the page to offer sign-in
   * instead of the actions that need an account.
   */
  function revealAnonymous(data) {
    window.lensyAnonymous = true;
    window.lensyLoginUrl = (data && data.loginUrl) || '/login';
    document.documentElement.classList.remove('auth-pending');
    var el = document.getElementById(GATE_ID);
    if (el) el.remove();
    addSignInChip(window.lensyLoginUrl);
    document.dispatchEvent(new CustomEvent('lensy:auth', { detail: null }));
  }

  function addSignInChip(loginUrl) {
    var nav = document.querySelector('header nav');
    if (!nav || document.getElementById('lensy-user-chip')) return;
    var chip = document.createElement('span');
    chip.id = 'lensy-user-chip';
    chip.className = 'flex items-center gap-2 pl-3 ml-1 border-l border-white/20 text-blue-200';
    chip.innerHTML =
      '<a href="' + esc(loginUrl) + '" ' +
      'class="px-3 py-1.5 rounded-md text-blue-200 hover:text-white hover:bg-white/10 transition">Sign in</a>';
    nav.appendChild(chip);
  }

  function onShareLink() {
    if (!PUBLIC_WHEN_SHARE) return false;
    try {
      return new URLSearchParams(location.search).has('share');
    } catch (err) {
      return false;
    }
  }

  // /api/auth/me mints the login URL, but only this page knows which page is
  // being gated — pass it so the IdP round-trip returns here, not to the root.
  function meUrl() {
    return '/api/auth/me?returnTo=' +
      encodeURIComponent(location.pathname + location.search);
  }

  function boot() {
    showChecking();
    fetch(meUrl(), { headers: { Accept: 'application/json' } })
      .then(function (res) {
        return res.json().then(function (data) { return { status: res.status, data: data }; });
      })
      .then(function (r) {
        if (r.status === 200 && r.data.authorized) {
          if (REQUIRE_ADMIN && !(r.data.user && r.data.user.isAdmin)) {
            return showNotAdmin(r.data);
          }
          return reveal(r.data);
        }
        // A share link is readable without an account (DO52) — for BOTH the
        // signed-out visitor and the signed-in one whose account has no Lensy
        // access, which is exactly the non-subscriber the client described.
        if (r.status === 401) return onShareLink() ? revealAnonymous(r.data) : showLogin(r.data.loginUrl);
        if (r.status === 403) return onShareLink() ? revealAnonymous(r.data) : showDenied(r.data);
        if (r.status === 503 && r.data.reason === 'sso_misconfigured') {
          return showMisconfigured(r.data);
        }
        return showError();
      })
      .catch(showError);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
