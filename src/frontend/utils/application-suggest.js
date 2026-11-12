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

  function words(text) {
    return String(text == null ? '' : text).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  }

  /**
   * The API payload → the rows the matcher reads. Tolerates a malformed entry
   * (skipped) rather than failing the whole list.
   */
  function prepareIndex(payload) {
    var standards = (payload && Array.isArray(payload.standards)) ? payload.standards : [];
    var apps = (payload && Array.isArray(payload.applications)) ? payload.applications : [];
    var rows = [];
    for (var i = 0; i < apps.length; i++) {
      var a = apps[i];
      if (!a || typeof a.c !== 'string' || !Array.isArray(a.p)) continue;
      var standard = standards[a.s];
      if (typeof standard !== 'string' || !standard) continue;
      var levels = a.p.map(function (l) { return String(l == null ? '' : l).trim(); }).filter(Boolean);
      if (levels.length === 0) continue;
      rows.push({
        code: a.c,
        standard: standard,
        levels: levels,
        levelWords: levels.map(words),
      });
    }
    return rows;
  }

  /** Does any word of this level START with the token? ("desk" → Desks, Desktop.) */
  function levelHasToken(levelWords, token) {
    for (var i = 0; i < levelWords.length; i++) {
      if (levelWords[i].indexOf(token) === 0) return true;
    }
    return false;
  }

  /**
   * The suggestions for what has been typed, best first.
   *
   * Every typed word must begin a word somewhere in the row's hierarchy; the
   * suggestion is the path down to the deepest level any of them reaches.
   * Ranking: the path's last level IS the typed text → starts with it → holds
   * every typed word → the rest; then the shallower path (an application
   * before one of its variants — "Classrooms" before eight sports' "Class I"),
   * then the shorter name, then document order.
   */
  function suggestApplications(rows, typed, limit) {
    var max = limit > 0 ? limit : DEFAULT_LIMIT;
    var phrase = String(typed == null ? '' : typed).trim().toLowerCase();
    if (phrase.length < MIN_QUERY_LENGTH || !Array.isArray(rows) || rows.length === 0) return [];
    var tokens = words(phrase);
    if (tokens.length === 0) return [];

    var byPath = new Map();
    var order = 0;
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      var deepest = -1;
      var matchedAll = true;
      for (var t = 0; t < tokens.length; t++) {
        var at = -1;
        for (var l = row.levels.length - 1; l >= 0; l--) {
          if (levelHasToken(row.levelWords[l], tokens[t])) { at = l; break; }
        }
        if (at < 0) { matchedAll = false; break; }
        if (at > deepest) deepest = at;
      }
      if (!matchedAll) continue;

      var path = row.levels.slice(0, deepest + 1);
      var key = row.standard + '\u0000' + path.join('\u0000').toLowerCase();
      var entry = byPath.get(key);
      if (!entry) {
        var leaf = path[path.length - 1];
        var leafLower = leaf.toLowerCase();
        var leafWords = row.levelWords[deepest];
        var inLeaf = 0;
        for (var k = 0; k < tokens.length; k++) if (levelHasToken(leafWords, tokens[k])) inLeaf++;
        entry = {
          standard: row.standard,
          levels: path,
          codes: [],
          rowCount: 0,
          rank: leafLower === phrase ? 0
            : leafLower.indexOf(phrase) === 0 ? 1
            : inLeaf === tokens.length ? 2
            : 3,
          leafLength: leaf.length,
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
        if (child === parent || child.standard !== parent.standard) continue;
        if (child.levels.length <= parent.levels.length) continue;
        var under = true;
        for (var x = 0; x < parent.levels.length; x++) {
          if (child.levels[x].toLowerCase() !== parent.levels[x].toLowerCase()) { under = false; break; }
        }
        if (!under) continue;
        for (var c = 0; c < child.codes.length && parent.codes.length < MAX_PINNED_CODES; c++) {
          if (parent.codes.indexOf(child.codes[c]) < 0) parent.codes.push(child.codes[c]);
        }
      }
    }

    entries.sort(function (a, b) {
      return (a.rank - b.rank) || (a.levels.length - b.levels.length)
        || (a.leafLength - b.leafLength) || (a.order - b.order);
    });

    return entries.slice(0, max).map(function (s) {
      return {
        standard: s.standard,
        levels: s.levels,
        codes: s.codes,
        rowCount: s.rowCount,
        // What lands in the search box, and what the search runs on.
        query: s.standard + ' ' + s.levels.join(SEPARATOR),
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
   * the page bolds the flagged runs, as the old tool did ("**Desk**top").
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
      for (var i = 0; i < tokens.length; i++) {
        if (word.indexOf(tokens[i]) === 0) { hitLength = tokens[i].length; break; }
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
    prepareIndex: prepareIndex,
    suggestApplications: suggestApplications,
    visibleLevels: visibleLevels,
    highlightParts: highlightParts,
  };
})(typeof window !== 'undefined' ? window : globalThis);
