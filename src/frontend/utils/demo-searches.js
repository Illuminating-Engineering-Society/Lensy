/**
 * The "Try searching for" demo searches (client wireframe, DO32) — read by the
 * search page and by the Worker.
 *
 * ONE list for both because search analytics leave exact copies of these out
 * (Dan, Teams 11/19/26 #7: "block exact copies of the 'Try Searching For'
 * searches … from counting towards 'trending topics'"): a click on a demo is a
 * reader trying the product, not a reader asking a question, and the first
 * demo alone was 40 of a month's 1,187 searches. If the page showed one
 * wording and the analytics excluded another, the exclusion would silently
 * stop working the day a demo was reworded.
 *
 * Each entry carries the filter state that makes it a good demonstration.
 * Each state names EVERY content kind rather than the ones it wants on: the
 * defaults have all four selected (DO57), so a partial state would leave
 * Definitions and References switched on in a demo that means to exclude them.
 * Every demo leaves the AI Guide ON, matching the default: a demo that
 * silently un-pressed the toggle would read as the control breaking.
 *
 * A classic script: `globalThis` when there is no window (the Worker).
 */
(function () {
  (typeof window !== 'undefined' ? window : globalThis).LENS_DEMO_SEARCHES = [
    { query: 'What are considerations for lighting parking garages?',
      state: { body: true, tables: true, definitions: false, references: false, guide: true } },
    { query: 'Provide a list of references in IES standards related to human vision.',
      state: { body: false, tables: false, definitions: false, references: true, guide: true } },
    { query: 'What is new in the current version of ANSI/IES RP-43?',
      state: { body: true, tables: true, definitions: false, references: false, compare: true, guide: true } },
    { query: 'Show me recommended illuminance levels for lighting walkways',
      state: { tables: true, body: false, definitions: false, references: false, guide: true } },
  ];
})();
