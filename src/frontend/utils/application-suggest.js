/**
 * Application names in the search box's auto-suggest (Dan, Teams 11/11/26).
 *
 *   "auto-filter would continue to display document titles (under the
 *    'Standards' header) but also display application names (under a new
 *    'Illuminance Recommendations' header) … always displaying Document
 *    Designation & Application Name in full but truncating top hierarchy as
 *    necessary to fit each result on a single line:
 *    e.g. 'RP-9-23 Lobbies > Reception Lobbies > Desktop'"
 *
 * The index is every Active illuminance row's hierarchy (GET
 * /api/applications/names — names only, never a value), fetched once; matching
 * runs here so a keystroke costs no request, as in the old Illuminance Selector.
 *
 * WHAT ONE SUGGESTION IS. Not a row: a hierarchy PATH, cut at the deepest level
 * the typed words reach. "desk" finds "… > Reception lobbies > Desktop" (a row),
 * but also "Shopping Mall, Interior > Information Desks", whose two rows are
 * "Min" and "Max" — listing those as two "desk" results would be noise, and so
 * would every Lighting Zone or Class of Play variant of one application. A
 * suggestion therefore carries the codes of EVERY row under its path, and the
 * search pins those rows to the top of the results.
 *
 * THE TOP LEVEL (Dan, Teams 11/12/26 #4: "the auto-filter needs to include all
 * 'top' levels of hierarchy … searches should include phrases like 'casino' or
 * 'hotel'"). Each row also carries its table banner ("INTERIOR - HOSPITALITY"):
 * it is shown as the first level of the path — the first to be trimmed when the
 * line is too long — and it is matched, but it never decides where the path is
 * cut. "hospitality" therefore lists that banner's APPLICATIONS (Ballroom,
 * Guest Room, …), and "hospitality lobby" narrows to the lobbies under it.
 *
 * The tables do not print "hotel" or "casino" anywhere — RP-9's banner is
 * "Hospitality" and its casino rows are "Gaming" — so a short list of everyday
 * words (ALIASES) stands in for the printed one.
 *
 * A classic script (the page has no bundler) that also loads under vitest:
 * everything hangs off one global, `LensApplicationSuggest`.
 */
(function (root) {
  'use strict';

  /** Typed text shorter than this suggests nothing — one letter matches half the tables. */
  var MIN_QUERY_LENGTH = 2;
  var DEFAULT_LIMIT = 8;
  /** How many rows one suggestion may pin (the Worker enforces the same cap). */
  var MAX_PINNED_CODES = 12;
  var SEPARATOR = ' > ';
  /** A typed word this long may complete to an alias ("hote" → hotel). */
  var ALIAS_PREFIX_LENGTH = 4;

  /**
   * Everyday word → the word the tables print. Every target is a word that
   * appears in a banner or an application name; a target that matches nothing
   * is simply inert. Extend freely — one line per word.
   */
  var ALIASES = {
    // RP-9 Hospitality
    hotel: ['hospitality'], motel: ['hospitality'], resort: ['hospitality'], lodging: ['hospitality'],
    casino: ['gaming'], gambling: ['gaming'],
    // RP-29 Healthcare
    hospital: ['healthcare'], clinic: ['healthcare'], medical: ['healthcare'],
    // RP-2 Retail
    store: ['retail'], shop: ['retail'], shopping: ['retail'],
    // RP-3 Educational facilities
    school: ['educational'], college: ['educational'], university: ['educational'], campus: ['educational'],
    // RP-41 Theaters and houses of worship
    church: ['worship'], temple: ['worship'], mosque: ['worship'], synagogue: ['worship'], chapel: ['worship'],
    theatre: ['theaters'],
    // RP-7 Industrial
    factory: ['industrial'], manufacturing: ['industrial'],
    // RP-11 Residential
    home: ['residential'], house: ['residential'], apartment: ['residential'], dwelling: ['residential'],
    // RP-28 Older adults
    senior: ['older'], elderly: ['older'],
    // RP-6 Sports
    athletic: ['sports'], stadium: ['sports'],
  };
  var ALIAS_KEYS = Object.keys(ALIASES);

  function words(text) {
    return String(text == null ? '' : text).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  }

  /** "lobbies" → "lobby", "desks" → "desk"; anything else unchanged. */
  function singular(word) {
    if (word.length > 4 && /ies$/.test(word)) return word.slice(0, -3) + 'y';
    if (word.length > 4 && /(?:ch|sh|ss|x|z)es$/.test(word)) return word.slice(0, -2);
    if (word.length > 3 && /[^s]s$/.test(word)) return word.slice(0, -1);
    return word;
  }

  /** The table words a typed word also stands for. */
  function aliasTargets(token) {
    var out = [];
    var base = singular(token);
    for (var i = 0; i < ALIAS_KEYS.length; i++) {
      var key = ALIAS_KEYS[i];
      if (key === token || key === base
          || (token.length >= ALIAS_PREFIX_LENGTH && key.indexOf(token) === 0)) {
        out = out.concat(ALIASES[key]);
      }
    }
    return out;
  }

  /** One typed word, prepared once per keystroke. */
  function prepareToken(token) {
    return { text: token, base: singular(token), aliases: aliasTargets(token) };
  }

  /**
   * How a level answers a typed word: 2 = a whole word of it ("desk" in
   * "Reception desk", "lobby" in "Lobbies"), 1 = the start of a word or an
   * alias ("desk" in "Desktop", "hotel" in "Hospitality"), 0 = not at all.
   */
  function levelMatch(levelWords, token) {
    var best = 0;
    for (var i = 0; i < levelWords.length; i++) {
      var word = levelWords[i];
      if (word === token.text || singular(word) === token.base) return 2;
      if (word.indexOf(token.text) === 0 || singular(word).indexOf(token.base) === 0) best = 1;
      else {
        for (var a = 0; a < token.aliases.length; a++) {
          if (word.indexOf(token.aliases[a]) === 0) { best = 1; break; }
        }
      }
    }
    return best;
  }

  /** Does the typed word itself (no alias) begin a word of this level? */
  function levelHasLiteral(levelWords, token) {
    for (var i = 0; i < levelWords.length; i++) {
      if (levelWords[i].indexOf(token.text) === 0 || singular(levelWords[i]).indexOf(token.base) === 0) return true;
    }
    return false;
  }

  /**
   * The API payload → the rows the matcher reads. Tolerates a malformed entry
   * (skipped) rather than failing the whole list. `g` — the row's table banner,
   * an index into `groups` — is optional: a payload without it still works.
   */
  function prepareIndex(payload) {
    var standards = (payload && Array.isArray(payload.standards)) ? payload.standards : [];
    var groups = (payload && Array.isArray(payload.groups)) ? payload.groups : [];
    var apps = (payload && Array.isArray(payload.applications)) ? payload.applications : [];
    var groupWords = groups.map(words);
    var rows = [];
    for (var i = 0; i < apps.length; i++) {
      var a = apps[i];
      if (!a || typeof a.c !== 'string' || !Array.isArray(a.p)) continue;
      var standard = standards[a.s];
      if (typeof standard !== 'string' || !standard) continue;
      var levels = a.p.map(function (l) { return String(l == null ? '' : l).trim(); }).filter(Boolean);
      if (levels.length === 0) continue;
      var group = (typeof a.g === 'number' && typeof groups[a.g] === 'string') ? groups[a.g].trim() : '';
      rows.push({
        code: a.c,
        standard: standard,
        group: group || null,
        groupWords: group ? groupWords[a.g] : [],
        levels: levels,
        levelWords: levels.map(words),
      });
    }
    return rows;
  }

  /**
   * The suggestions for what has been typed, best first.
   *
   * Every typed word must begin a word of the row's hierarchy or of its table
   * banner; the suggestion is the path down to the deepest APPLICATION level
   * any of them reaches (the banner's own applications when only the banner
   * matched). Ranking: the path's last level IS the typed text → starts with
   * it → holds every typed word → the rest → banner-only matches; then whole
   * words before partial ones ("hospital" finds Hospitals before
   * Hospitality), then the shallower path (an application before one of its
   * variants — "Classrooms" before eight sports' "Class I"), then the shorter
   * name, then document order.
   */
  function suggestApplications(rows, typed, limit) {
    var max = limit > 0 ? limit : DEFAULT_LIMIT;
    var phrase = String(typed == null ? '' : typed).trim().toLowerCase();
    if (phrase.length < MIN_QUERY_LENGTH || !Array.isArray(rows) || rows.length === 0) return [];
    var tokens = words(phrase).map(prepareToken);
    if (tokens.length === 0) return [];

    var byPath = new Map();
    var order = 0;
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      var deepest = -1;
      var matchedAll = true;
      var whole = true;
      for (var t = 0; t < tokens.length; t++) {
        var at = -1;
        var strength = 0;
        for (var l = row.levels.length - 1; l >= 0; l--) {
          strength = levelMatch(row.levelWords[l], tokens[t]);
          if (strength) { at = l; break; }
        }
        if (at < 0) {
          strength = levelMatch(row.groupWords, tokens[t]);
          if (!strength) { matchedAll = false; break; }
        }
        if (strength < 2) whole = false;
        if (at > deepest) deepest = at;
      }
      if (!matchedAll) continue;

      // Only the banner matched: the suggestion is the application under it.
      var bannerOnly = deepest < 0;
      if (bannerOnly) deepest = 0;

      var path = row.levels.slice(0, deepest + 1);
      var key = row.standard + '\u0000' + (row.group || '').toLowerCase() + '\u0000' + path.join('\u0000').toLowerCase();
      var entry = byPath.get(key);
      if (!entry) {
        var leaf = path[path.length - 1];
        var leafLower = leaf.toLowerCase();
        var leafWords = row.levelWords[deepest];
        var inLeaf = 0;
        for (var k = 0; k < tokens.length; k++) if (levelHasLiteral(leafWords, tokens[k])) inLeaf++;
        entry = {
          standard: row.standard,
          group: row.group,
          path: path,
          codes: [],
          rowCount: 0,
          rank: bannerOnly ? 4
            : leafLower === phrase ? 0
            : leafLower.indexOf(phrase) === 0 ? 1
            : inLeaf === tokens.length ? 2
            : 3,
          partial: whole ? 0 : 1,
          // Banner-only matches list a table's applications: document order.
          leafLength: bannerOnly ? 0 : leaf.length,
          order: order++,
        };
        byPath.set(key, entry);
      }
      entry.rowCount++;
      if (entry.codes.length < MAX_PINNED_CODES) entry.codes.push(row.code);
    }

    // A path also owns the rows BELOW it that matched deeper (typing "lobb"
    // yields both "Lobbies" and "Lobbies > Reception lobbies"): the shallower
    // suggestion pins its own rows first, then borrows from its descendants.
    var entries = Array.from(byPath.values());
    for (var e = 0; e < entries.length; e++) {
      var parent = entries[e];
      if (parent.codes.length >= MAX_PINNED_CODES) continue;
      for (var d = 0; d < entries.length; d++) {
        var child = entries[d];
        if (child === parent || child.standard !== parent.standard || child.group !== parent.group) continue;
        if (child.path.length <= parent.path.length) continue;
        var under = true;
        for (var x = 0; x < parent.path.length; x++) {
          if (child.path[x].toLowerCase() !== parent.path[x].toLowerCase()) { under = false; break; }
        }
        if (!under) continue;
        for (var c = 0; c < child.codes.length && parent.codes.length < MAX_PINNED_CODES; c++) {
          if (parent.codes.indexOf(child.codes[c]) < 0) parent.codes.push(child.codes[c]);
        }
      }
    }

    entries.sort(function (a, b) {
      return (a.rank - b.rank) || (a.partial - b.partial) || (a.path.length - b.path.length)
        || (a.leafLength - b.leafLength) || (a.order - b.order);
    });

    return entries.slice(0, max).map(function (s) {
      return {
        standard: s.standard,
        // What is DISPLAYED: the table banner first, then the application path.
        levels: s.group ? [s.group].concat(s.path) : s.path,
        codes: s.codes,
        rowCount: s.rowCount,
        // What lands in the search box, and what the search runs on: the
        // designation and the application path. The banner stays out — its
        // "INTERIOR"/"EXTERIOR" would be read as a location filter.
        query: s.standard + ' ' + s.path.join(SEPARATOR),
      };
    });
  }

  /**
   * The path as it is DISPLAYED with its `dropped` top levels removed — the
   * application name (the last level) is never dropped. The page drops levels
   * one at a time until the row fits on a single line.
   */
  function visibleLevels(levels, dropped) {
    var list = Array.isArray(levels) ? levels : [];
    var n = Math.max(0, Math.min(Number(dropped) || 0, list.length - 1));
    return { levels: list.slice(n), truncated: n > 0 };
  }

  /**
   * `text` split into runs, flagging the part of each word the reader typed —
   * the page bolds the flagged runs, as the old tool did ("**Desk**top"). A
   * plural the typed word reaches ("lobby" → "Lobbies") is flagged up to where
   * the two agree ("**Lobb**ies").
   */
  function highlightParts(text, typed) {
    var source = String(text == null ? '' : text);
    var tokens = words(typed).sort(function (a, b) { return b.length - a.length; });
    if (!source || tokens.length === 0) return [{ text: source, hit: false }];
    var parts = [];
    var re = /[A-Za-z0-9]+/g;
    var last = 0;
    var m;
    while ((m = re.exec(source)) !== null) {
      var word = m[0].toLowerCase();
      var hitLength = 0;
      for (var i = 0; i < tokens.length && !hitLength; i++) {
        if (word.indexOf(tokens[i]) === 0) hitLength = tokens[i].length;
      }
      for (var j = 0; j < tokens.length && !hitLength; j++) {
        if (singular(word).indexOf(singular(tokens[j])) !== 0) continue;
        var shared = 0;
        while (shared < word.length && shared < tokens[j].length && word[shared] === tokens[j][shared]) shared++;
        hitLength = shared;
      }
      if (!hitLength) continue;
      if (m.index > last) parts.push({ text: source.slice(last, m.index), hit: false });
      parts.push({ text: source.slice(m.index, m.index + hitLength), hit: true });
      last = m.index + hitLength;
    }
    if (last < source.length) parts.push({ text: source.slice(last), hit: false });
    return parts;
  }

  root.LensApplicationSuggest = {
    MIN_QUERY_LENGTH: MIN_QUERY_LENGTH,
    MAX_PINNED_CODES: MAX_PINNED_CODES,
    SEPARATOR: SEPARATOR,
    ALIASES: ALIASES,
    prepareIndex: prepareIndex,
    suggestApplications: suggestApplications,
    visibleLevels: visibleLevels,
    highlightParts: highlightParts,
  };
})(typeof window !== 'undefined' ? window : globalThis);
