/**
 * The banner menus shared by List Standards (/contents) and My Bookmarks
 * (/bookmarks) — client 9/29/26 DO#4: "harmonize 'profile' menus at top right
 * of Lens, Bookmarks & List Standards pages. All to include: Log in (if not
 * logged in); Subscribe (if not a subscriber); User email (if logged in);
 * Subscribed until ### ##, #### (if subscriber); Disable AI Guide (… something
 * to indicate toggled on); My Bookmarks (gray out and '(this page)' … if it is
 * the active page); Sign Out (if logged in). Add to all … menus: 'FAQ'", plus
 * 9/29/26 DO#3 "Share feedback", 10/02/26 #1 "Tutorials" and DO091 preferred
 * units.
 *
 * The search page (index.html) keeps its own copy of the same items, because
 * there they are wired into its filter state; this file renders the identical
 * menus for the two pages that have no such state. Usage:
 *
 *   <div id="library-tools-menu" data-site-menu="tools" data-current="contents"></div>
 *   <div id="account-menu" data-site-menu="profile" data-current="bookmarks"></div>
 *   <script src="/utils/site-menu.js"></script>
 *
 * Preferences go through /api/preferences (the same per-account record the
 * search page reads) and are mirrored to the same localStorage keys, so a
 * change made here is what the search page shows next.
 */
(function () {
  'use strict';

  var SUBSCRIBE_URL = 'https://store.ies.org/ies/subscriptions/';
  var FEEDBACK_URL = 'https://ies.org/contact-us/';
  var GUIDE_KEY = 'lensy.pref.aiGuide';
  var UNITS_KEY = 'lensy.pref.units';
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  var ICONS = {
    search: 'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z',
    library: 'M4 19.5V5a1 1 0 011-1h2a1 1 0 011 1v14.5M10 19.5V5a1 1 0 011-1h2a1 1 0 011 1v14.5M16.5 19.5l-2-14 2.5-.5 2.5 14z',
    list: 'M4 6h16M4 12h16M4 18h10',
    video: 'M15 10l4.55-2.28A1 1 0 0121 8.62v6.76a1 1 0 01-1.45.9L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z',
    faq: 'M8.2 9a4 4 0 017.6 1.5c0 2-3 2.75-3 4.5M12 18h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
    user: 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z',
    cart: 'M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.3 4.6a1 1 0 00.9 1.4H19M9 21a1 1 0 100-2 1 1 0 000 2zm8 0a1 1 0 100-2 1 1 0 000 2z',
    guide: 'M15.5 8.5l-2 5-5 2 2-5 5-2z',
    units: 'M4 7h16M4 12h10M4 17h6M17 14l3 3-3 3',
    bookmark: 'M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z',
    feedback: 'M8 10h8M8 14h5M21 12a8.5 8.5 0 01-12.6 7.4L3 21l1.6-5.4A8.5 8.5 0 1121 12z',
    signout: 'M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1',
    login: 'M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1',
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function svg(name, extra) {
    var circle = name === 'guide' ? '<circle cx="12" cy="12" r="9"/>' : '';
    return '<svg class="w-4 h-4 ' + (extra || 'text-gray-500') + ' shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">'
      + circle + '<path stroke-linecap="round" stroke-linejoin="round" d="' + ICONS[name] + '"/></svg>';
  }

  /** A link, or — when it is the page being viewed — a greyed "(this page)" row. */
  function link(opts) {
    if (opts.current) {
      return '<span class="menu-item text-gray-400 cursor-default" aria-current="page">'
        + svg(opts.icon, 'text-gray-400') + esc(opts.label) + ' <span class="text-[11px]">(this page)</span></span>';
    }
    var attrs = opts.newTab ? ' target="_blank" rel="noopener"' : '';
    return '<a href="' + esc(opts.href) + '"' + attrs + (opts.id ? ' id="' + opts.id + '"' : '')
      + ' class="menu-item' + (opts.cls ? ' ' + opts.cls : '') + '"'
      + (opts.title ? ' title="' + esc(opts.title) + '"' : '') + '>'
      + svg(opts.icon, opts.iconCls) + esc(opts.label) + '</a>';
  }

  function toolsMenu(current) {
    return [
      link({ href: '/', icon: 'search', label: 'Search with IES Lens', current: current === 'search', title: 'Search the IES standards with IES Lens' }),
      link({ href: 'https://lighting.ies.org', icon: 'library', label: 'Browse Lighting Library', newTab: true, title: 'Open the IES Lighting Library in a new browser tab' }),
      link({ href: '/contents', icon: 'list', label: 'List Standards', current: current === 'contents', title: 'Every current IES standard in the Lighting Library' }),
      link({ href: '/tutorials', icon: 'video', label: 'Tutorials', newTab: true, cls: 'border-t border-gray-100', title: 'Video tutorials for the IES Lighting Library and IES Lens' }),
      link({ href: '/tutorials#faq', icon: 'faq', label: 'FAQ', newTab: true, title: 'Frequently asked questions' }),
    ].join('');
  }

  function profileMenu(current) {
    return ''
      // Signed-out visitors (a shared collection opened without an account).
      + '<div data-when="anonymous" class="hidden">'
      + link({ href: '/login?returnTo=' + encodeURIComponent(location.pathname + location.search), icon: 'login', label: 'Log in', id: 'menu-login' })
      + link({ href: SUBSCRIBE_URL, icon: 'cart', label: 'Subscribe', newTab: true, title: 'Subscribe to the Lighting Library' })
      + '</div>'
      + '<div data-when="signed-in">'
      + '<p id="menu-email" class="px-4 py-2.5 text-sm font-medium text-gray-700 border-b border-gray-100 truncate">Signed in</p>'
      + '<div class="menu-item cursor-default" title="Your subscription">' + svg('user')
      + '<span class="min-w-0"><span id="menu-tier-label" class="font-bold">Lighting Library</span>'
      + '<span id="menu-sub-until" class="hidden block text-[11px] text-gray-500"></span></span></div>'
      + link({ href: SUBSCRIBE_URL, icon: 'cart', label: 'Subscribe', newTab: true, id: 'menu-subscribe', cls: 'hidden', title: 'Subscribe to the Lighting Library to unlock full access' })
      + '<button type="button" id="menu-guide" class="menu-item" title="The AI Guide summarizes and curates IES Lens results">'
      + svg('guide') + '<span id="menu-guide-label">Disable AI Guide</span>'
      + '<span id="menu-guide-switch" class="ml-auto relative inline-block w-8 h-[18px] rounded-full shrink-0 transition" style="background-color:#FFAA00">'
      + '<span class="absolute top-[3px] left-[3px] w-3 h-3 rounded-full bg-white shadow transition" style="transform:translateX(14px)"></span></span>'
      + '</button>'
      + '<button type="button" id="menu-units" class="menu-item" title="Choose which units illuminance values show first">'
      + svg('units') + '<span id="menu-units-label">Preferred units: <strong>SI</strong> (lux / m)</span></button>'
      + link({ href: '/bookmarks', icon: 'bookmark', label: 'My Bookmarks', current: current === 'bookmarks', title: 'Your bookmark collections' })
      + link({ href: FEEDBACK_URL, icon: 'feedback', label: 'Share feedback', newTab: true, title: 'Send feedback about the IES Lighting Library and IES Lens' })
      + link({ href: '/logout', icon: 'signout', iconCls: 'text-gray-400', label: 'Sign out', id: 'menu-signout', cls: 'border-t border-gray-100 text-gray-500' })
      + '</div>';
  }

  function readPref(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function writePref(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* private mode */ } }

  var state = { guide: readPref(GUIDE_KEY) !== 'false', units: readPref(UNITS_KEY) === 'uscs' ? 'uscs' : 'si' };

  function paint() {
    var label = document.getElementById('menu-guide-label');
    if (label) label.textContent = state.guide ? 'Disable AI Guide' : 'Enable AI Guide';
    var sw = document.getElementById('menu-guide-switch');
    if (sw) {
      sw.style.backgroundColor = state.guide ? '#FFAA00' : '#D1D5DB';
      if (sw.firstElementChild) sw.firstElementChild.style.transform = state.guide ? 'translateX(14px)' : 'translateX(0)';
    }
    var units = document.getElementById('menu-units-label');
    if (units) units.innerHTML = state.units === 'uscs'
      ? 'Preferred units: <strong>USCS</strong> (fc / ft)'
      : 'Preferred units: <strong>SI</strong> (lux / m)';
  }

  function save(prefs) {
    fetch('/api/preferences', {
      method: 'PUT', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prefs),
    }).catch(function () { /* the mirror keeps this browser right */ });
  }

  function load() {
    fetch('/api/preferences', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (data) {
        var p = (data && (data.preferences || data)) || {};
        if (typeof p.ai_guide === 'boolean') { state.guide = p.ai_guide; writePref(GUIDE_KEY, String(p.ai_guide)); }
        if (p.units === 'si' || p.units === 'uscs') { state.units = p.units; writePref(UNITS_KEY, p.units); }
        paint();
      })
      .catch(function () { /* fail soft */ });
  }

  function formatDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    return m ? MONTHS[Number(m[2]) - 1] + ' ' + Number(m[3]) + ', ' + m[1] : null;
  }

  function onAuth(user) {
    var signedIn = !!user;
    var nodes = document.querySelectorAll('[data-when]');
    for (var i = 0; i < nodes.length; i++) {
      var when = nodes[i].getAttribute('data-when');
      nodes[i].classList.toggle('hidden', signedIn ? when !== 'signed-in' : when !== 'anonymous');
    }
    if (!signedIn) return;

    var email = document.getElementById('menu-email');
    if (email) email.textContent = user.email || user.name || 'Signed in';
    // DO111: name the subscription, never the tool.
    var lite = user.tier === 'lite' || user.tier === 'none';
    var tier = document.getElementById('menu-tier-label');
    if (tier) tier.textContent = lite ? 'No subscription' : 'Lighting Library';
    var until = document.getElementById('menu-sub-until');
    var date = lite ? null : formatDate(user.subscriptionExpiresAt);
    if (until) { until.textContent = date ? 'Subscribed until ' + date : ''; until.classList.toggle('hidden', !date); }
    var sub = document.getElementById('menu-subscribe');
    if (sub) sub.classList.toggle('hidden', !lite);

    // auth-gate's chip carries the IdP logout URL with its return parameters.
    var chip = document.querySelector('#lensy-user-chip a');
    var href = chip && chip.getAttribute && chip.getAttribute('href');
    var signout = document.getElementById('menu-signout');
    if (href && signout) signout.setAttribute('href', href);
    load();
  }

  function render() {
    var tools = document.querySelector('[data-site-menu="tools"]');
    if (tools) tools.innerHTML = toolsMenu(tools.getAttribute('data-current'));
    var profile = document.querySelector('[data-site-menu="profile"]');
    if (profile) profile.innerHTML = profileMenu(profile.getAttribute('data-current'));

    var guide = document.getElementById('menu-guide');
    if (guide) guide.addEventListener('click', function () {
      state.guide = !state.guide;
      writePref(GUIDE_KEY, String(state.guide));
      save({ ai_guide: state.guide });
      paint();
    });
    var units = document.getElementById('menu-units');
    if (units) units.addEventListener('click', function () {
      state.units = state.units === 'uscs' ? 'si' : 'uscs';
      writePref(UNITS_KEY, state.units);
      save({ units: state.units });
      paint();
    });
    paint();

    document.addEventListener('lensy:auth', function (e) { onAuth(e.detail || null); });
    if (window.lensyUser) onAuth(window.lensyUser);
    else if (window.lensyAnonymous) onAuth(null);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render);
  else render();
})();
