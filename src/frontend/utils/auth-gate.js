/**
 * Lensy SSO auth gate — include FIRST in <head> of every gated page:
 *   <script src="/utils/auth-gate.js"></script>
 *
 * Hides the entire page until GET /api/auth/me confirms an authorized IdP
 * session (ies_auth cookie from auth.ies.org), then reveals the app and adds
 * a user chip + Sign out to the header nav. Unauthenticated visitors get a
 * branded sign-in screen; authenticated-but-not-invited visitors get an
 * access-denied screen. The API is gated server-side too — this overlay is
 * UX, not the security boundary.
 */
(function () {
  'use strict';

  var GATE_ID = 'lensy-auth-gate';

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
      devBtn
    );
    var dev = document.getElementById('lensy-dev-login');
    if (dev) {
      dev.addEventListener('click', function () {
        fetch('/api/auth/dev-login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'dev@example.com', isMember: true }),
        }).then(function () { location.reload(); });
      });
    }
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

  function boot() {
    showChecking();
    fetch('/api/auth/me', { headers: { Accept: 'application/json' } })
      .then(function (res) {
        return res.json().then(function (data) { return { status: res.status, data: data }; });
      })
      .then(function (r) {
        if (r.status === 200 && r.data.authorized) return reveal(r.data);
        if (r.status === 401) return showLogin(r.data.loginUrl);
        if (r.status === 403) return showDenied(r.data);
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
