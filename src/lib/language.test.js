/**
 * Query language: interpret in English, answer in the user's language
 * (client note, 2026-09-01).
 *
 * The wiring (which pipeline steps read the English interpretation, what the
 * caches key on) lives in handleSearch; these tests cover the three decisions
 * this module makes on its own:
 *
 *   1. whether a query spends a detection call at all (looksNonEnglish),
 *   2. whether a detection can be trusted (parseDetectResponse — fail-open
 *      to English on anything less), and
 *   3. whether a translated answer can be shown (isPlausibleTranslation —
 *      fail-open to the English answer on anything less).
 */

import { describe, it, expect } from 'vitest';
import {
  looksNonEnglish, englishQueryLanguage, keepsDesignations,
  buildDetectPrompt, parseDetectResponse, resolveQueryLanguage,
  buildTranslatePrompt, isPlausibleTranslation, localizeSummary,
} from './language';

/** An Ai stub whose run() replays canned texts (and records its calls). */
const aiStub = (...texts) => {
  const calls = [];
  let i = 0;
  return {
    calls,
    run(model, opts) {
      calls.push({ model, opts });
      const t = texts[Math.min(i++, texts.length - 1)];
      if (t instanceof Error) return Promise.reject(t);
      return Promise.resolve({ response: t });
    },
  };
};

/** An Ai that must never be reached — the free-heuristic path. */
const aiForbidden = () => ({
  run() { throw new Error('ai.run must not be called on this path'); },
});

describe('looksNonEnglish', () => {
  it('treats ordinary English queries as English, costing nothing', () => {
    expect(looksNonEnglish('How bright should a skating rink be?')).toBe(false);
    expect(looksNonEnglish('office lighting levels for open plan')).toBe(false);
    expect(looksNonEnglish("what's new in RP-8?")).toBe(false);
    expect(looksNonEnglish('RP-8-25+E2')).toBe(false);
    expect(looksNonEnglish('')).toBe(false);
  });

  it('flags non-Latin scripts', () => {
    expect(looksNonEnglish('道路照明の基準')).toBe(true);       // Japanese
    expect(looksNonEnglish('освещение офиса')).toBe(true);      // Russian
    expect(looksNonEnglish('사무실 조명')).toBe(true);           // Korean
  });

  it('flags Latin diacritics and inverted punctuation', () => {
    expect(looksNonEnglish('¿Qué tan brillante debe ser una pista de patinaje?')).toBe(true);
    expect(looksNonEnglish('niveles de iluminación para oficinas')).toBe(true);
    expect(looksNonEnglish('Wie hell muss ein Büro sein?')).toBe(true);
  });

  it('flags plain-ASCII non-English via function and domain words', () => {
    // No diacritic anywhere — the word list is what catches these.
    expect(looksNonEnglish('iluminacion de oficinas')).toBe(true);
    expect(looksNonEnglish('eclairage pour bureau')).toBe(true);
    expect(looksNonEnglish('welke verlichting voor kantoor')).toBe(true);
  });

  it('flags plain-ASCII languages the word list does not know (the Swahili miss, 2026-09-04)', () => {
    // The client's exact query: Latin script, no diacritics, no listed word —
    // it sailed through as English and was embedded raw, retrieving LM-83 for
    // an office-lighting question. The inverse guard catches it: none of its
    // words read as English.
    expect(looksNonEnglish('njia bora ya kuwasha mwangaza kwenye ofisi ni ipi?')).toBe(true);
    expect(looksNonEnglish('taa za ofisi')).toBe(true);                       // Swahili keywords
    expect(looksNonEnglish('cara terbaik menerangi ruang kantor')).toBe(true); // Indonesian
    expect(looksNonEnglish('paano ilawan ang opisina')).toBe(true);            // Tagalog
    // An English loanword is not enough to read as English (1 of 5 words).
    expect(looksNonEnglish('standard ya taa za ofisi')).toBe(true);
  });

  it('the inverse guard never taxes recognizable English', () => {
    // Jargon-heavy but still majority-recognizable — stays free.
    expect(looksNonEnglish('veiling luminance office computation')).toBe(false);
    expect(looksNonEnglish('parking garage illuminance requirements')).toBe(false);
    expect(looksNonEnglish('emergency egress lighting for stairwells')).toBe(false);
    // A single unknown word gives the detector nothing to judge by.
    expect(looksNonEnglish('natatorium')).toBe(false);
  });
});

describe('keepsDesignations', () => {
  it('passes when every designation survives', () => {
    expect(keepsDesignations('que cambio en RP-8-25?', 'what changed in RP-8-25?')).toBe(true);
    expect(keepsDesignations('no designation here', 'nothing here either')).toBe(true);
  });

  it('fails when a designation was dropped or mangled', () => {
    expect(keepsDesignations('que cambio en RP-8-25?', 'what changed in the roadway standard?')).toBe(false);
    expect(keepsDesignations('ANSI/IES LM-79 testing', 'testing per LM-80')).toBe(false);
  });
});

describe('parseDetectResponse', () => {
  const q = 'niveles de iluminación para oficinas';

  it('reads a clean detection', () => {
    const out = parseDetectResponse(
      '{"language": "es", "languageName": "Spanish", "english": "illuminance levels for offices"}', q,
    );
    expect(out).toEqual({
      language: 'es', languageName: 'Spanish',
      english: 'illuminance levels for offices', translated: true,
    });
  });

  it('finds the JSON inside surrounding chatter', () => {
    const out = parseDetectResponse(
      'Sure! {"language":"fr","languageName":"French","english":"office lighting"} Hope that helps.', q,
    );
    expect(out.language).toBe('fr');
    expect(out.translated).toBe(true);
  });

  it('an "en" verdict means English with the query unchanged', () => {
    const out = parseDetectResponse('{"language":"en","languageName":"English","english":"whatever"}', 'cafe lighting');
    expect(out).toEqual(englishQueryLanguage('cafe lighting'));
  });

  it('rejects unreadable or incomplete answers', () => {
    expect(parseDetectResponse('It looks Spanish to me.', q)).toBe(null);
    expect(parseDetectResponse('{"language": ', q)).toBe(null);
    expect(parseDetectResponse('{"language":"es","languageName":"Spanish"}', q)).toBe(null);
    expect(parseDetectResponse('{"language":"spanish","english":"x"}', q)).toBe(null);
    expect(parseDetectResponse('', q)).toBe(null);
    expect(parseDetectResponse(null, q)).toBe(null);
  });

  it('rejects a translation that lost a designation', () => {
    const out = parseDetectResponse(
      '{"language":"es","languageName":"Spanish","english":"what changed in the roadway standard?"}',
      '¿qué cambió en RP-8-25?',
    );
    expect(out).toBe(null);
  });

  it('rejects a "translation" that is the query echoed back', () => {
    expect(parseDetectResponse(
      `{"language":"es","languageName":"Spanish","english":"${q}"}`, q,
    )).toBe(null);
  });

  it('falls back to the code when the language name is garbage', () => {
    const out = parseDetectResponse(
      '{"language":"es","languageName":"<script>x</script>","english":"office lighting"}', q,
    );
    expect(out.languageName).toBe('es');
  });
});

describe('resolveQueryLanguage', () => {
  it('never spends a model call on a confidently English query', async () => {
    const out = await resolveQueryLanguage(aiForbidden(), 'How bright should a skating rink be?');
    expect(out).toEqual(englishQueryLanguage('How bright should a skating rink be?'));
  });

  it('detects and translates in one call', async () => {
    const ai = aiStub('{"language":"es","languageName":"Spanish","english":"how bright should a skating rink be?"}');
    const out = await resolveQueryLanguage(ai, '¿Qué tan brillante debe ser una pista de patinaje?');
    expect(out.translated).toBe(true);
    expect(out.language).toBe('es');
    expect(out.english).toBe('how bright should a skating rink be?');
    expect(ai.calls.length).toBe(1);
    expect(ai.calls[0].opts.messages[0].content).toContain('pista de patinaje');
  });

  it('fails open to English when every model errors or answers garbage', async () => {
    const q = '¿Qué tan brillante debe ser una pista?';
    expect(await resolveQueryLanguage(aiStub(new Error('down'), new Error('down')), q))
      .toEqual(englishQueryLanguage(q));
    expect(await resolveQueryLanguage(aiStub('no JSON here', 'still none'), q))
      .toEqual(englishQueryLanguage(q));
  });
});

describe('buildDetectPrompt / buildTranslatePrompt', () => {
  it('the detect prompt names the query and demands designations verbatim', () => {
    const p = buildDetectPrompt('¿qué cambió en RP-8-25?');
    expect(p).toContain('¿qué cambió en RP-8-25?');
    expect(p).toContain('EXACTLY as written');
    expect(p).toContain('"language"');
  });

  it('the translate prompt pins the locator forms the UI hyperlinks', () => {
    const p = buildTranslatePrompt('See Section 8.6.1.4, p. 42.', 'Spanish');
    expect(p).toContain('into Spanish');
    expect(p).toContain('"§8.6.1.4"');
    expect(p).toContain('"p. 42"');
    expect(p).toContain('Extent of the changes');
  });
});

describe('isPlausibleTranslation', () => {
  const source = 'According to ANSI/IES RP-8-25, roadway lighting design considers pedestrian conflict areas. See §4.2, p. 21.';

  it('accepts a faithful translation', () => {
    expect(isPlausibleTranslation(source,
      'Según ANSI/IES RP-8-25, el diseño de alumbrado vial considera las áreas de conflicto peatonal. Véase §4.2, p. 21.',
    )).toBe(true);
  });

  it('rejects emptiness, a summary, and a lost designation', () => {
    expect(isPlausibleTranslation(source, '')).toBe(false);
    expect(isPlausibleTranslation(source, null)).toBe(false);
    expect(isPlausibleTranslation(source, 'Sí.')).toBe(false);
    expect(isPlausibleTranslation(source,
      'Según la norma de alumbrado vial, el diseño considera las áreas de conflicto peatonal. Véase §4.2, p. 21.',
    )).toBe(false);
  });
});

describe('localizeSummary', () => {
  const spanish = { language: 'es', languageName: 'Spanish', english: 'office lighting', translated: true };
  const summary = () => ({
    text: 'According to ANSI/IES RP-1-24, office lighting design balances task illuminance and glare. See §4.2, p. 21.',
    watermark: 'w', disclaimer: 'd', mode: 'guide',
  });

  it('no-ops for an English query, a null summary, and a degraded one', async () => {
    const s = summary();
    expect(await localizeSummary(aiForbidden(), s, englishQueryLanguage('x'))).toBe(s);
    expect(await localizeSummary(aiForbidden(), null, spanish)).toBe(null);
    const degraded = { ...summary(), degraded: true };
    expect(await localizeSummary(aiForbidden(), degraded, spanish)).toBe(degraded);
  });

  it('swaps in the translation and keeps the English for curation', async () => {
    const translated = 'Según ANSI/IES RP-1-24, el diseño de iluminación de oficinas equilibra la iluminancia de la tarea y el deslumbramiento. Véase §4.2, p. 21.';
    const s = summary();
    const out = await localizeSummary(aiStub(translated), s, spanish);
    expect(out.text).toBe(translated);
    expect(out.textEnglish).toBe(s.text);
    expect(out.language).toBe('es');
    // Everything else on the summary travels unchanged.
    expect(out.watermark).toBe('w');
    expect(out.mode).toBe('guide');
  });

  it('fails open to the English answer — and marks nothing — when no model produces a plausible translation', async () => {
    const s = summary();
    // First model loses the designation, the rest error: the English ships,
    // and the absent `language` is what keeps it out of the caches.
    const out = await localizeSummary(
      aiStub('Según la norma, el diseño equilibra la iluminancia y el deslumbramiento. Véase §4.2, p. 21.',
        new Error('down'), new Error('down')),
      s, spanish,
    );
    expect(out).toBe(s);
    expect(out.language).toBeUndefined();
  });
});
