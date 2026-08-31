/**
 * Regression tests for the 260820 client feedback round (the "Note", DO062,
 * DO064, DO070–DO079).
 *
 * One describe block per item, in the client's numbering, so a future reader can
 * find the behaviour a given piece of feedback asked for. The Worker-side items
 * are here; the browser-side halves (the chapter card, the drop-down, the
 * formula notice, the guided empty state) live in src/frontend/index.test.js,
 * and the pure rules live beside their libraries
 * (src/lib/section-titles.test.js, formula.test.js, no-results.test.js).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  trustedSectionLabel, attachSectionTitles, citedStandardDesignation,
  findCitingPageInExcerpts, guardFormula, baseEdition, buildComparisonContext,
  addMissingEditionCards, assetsFromExcerpts,
} from './search';
import {
  generateResponse, tokenBudget, stripFormulasFromAnswer, stripOpeningFluff,
} from '../lib/ai-summary';

// ─── DO071: an untrustworthy section number is suppressed, not printed ─────────

describe('trustedSectionLabel (DO071)', () => {
  it('keeps the numbering a standard actually prints', () => {
    for (const n of ['13.4', '3.3.4', 'A.1.1.3', 'Annex A', '8']) {
      expect(trustedSectionLabel(n)).toBe(n);
    }
  });

  it('drops the artefacts of a font that ate its separators', () => {
    // The client's example: a card headed "131 - PATTERNS OF LIGHT WITHIN THE
    // OCCUPANTS' FIELD OF VIEW", naming a section LP-1-24 does not have.
    for (const n of ['131', '1810', '21211', '2025']) {
      expect(trustedSectionLabel(n)).toBe(null);
    }
  });

  it('leaves a non-numeric label the chunker assigns alone', () => {
    expect(trustedSectionLabel('References')).toBe('References');
  });

  it('drops a stray single capital', () => {
    expect(trustedSectionLabel('A')).toBe(null);
  });
});

describe('attachSectionTitles (DO071 + DO073)', () => {
  const sectionsFor = (sections) => ({
    DB: {
      prepare(sql) {
        const stmt = {
          bind() { return stmt; },
          async all() {
            if (/sections_json/.test(sql)) {
              return { results: [{ id: 'LP-1-24', sections_json: JSON.stringify(sections) }] };
            }
            throw new Error(`unexpected SQL: ${sql}`);
          },
        };
        return stmt;
      },
    },
  });

  const resultWith = (section) => {
    const excerpt = { text: 'x', pageNumber: 77, section, chunkType: 'text' };
    return { resultType: 'excerpt', application: { standard: 'LP-1-24' }, excerpt, excerpts: [excerpt] };
  };

  it('attaches the chapter a section belongs to, with its printed title (DO073)', async () => {
    const results = [resultWith('13.4')];
    await attachSectionTitles(
      sectionsFor({ '13.0': 'Light + Distribution', '13.4': 'Light Distribution on Task Plane (Uniformity)' }),
      results,
    );
    expect(results[0].excerpt.chapter).toEqual({ number: '13', title: 'Light + Distribution' });
    expect(results[0].excerpt.sectionTitle).toBe('Light Distribution on Task Plane (Uniformity)');
  });

  it('clears a section number the document cannot have printed (DO071)', async () => {
    const results = [resultWith('131')];
    await attachSectionTitles(sectionsFor({ '131': 'Patterns of Light within the occupants' }), results);
    expect(results[0].excerpt.section).toBe(null);
    expect(results[0].excerpt.sectionTitle).toBe(null);
    expect(results[0].excerpt.chapter).toBeUndefined();
  });

  it('re-sanitizes a title already in D1, so the corpus need not be re-ingested', async () => {
    // The stored title carries a SECOND heading — the two-column merge of DO071.
    const results = [resultWith('A.1.1.3')];
    await attachSectionTitles(
      sectionsFor({
        'Annex A': 'Field Measurements',
        'A.1.1.3': 'Regular Area With Single Row of Individual A.1.1.6 Regular Area With Uniform Indirect Lighting.The',
      }),
      results,
    );
    expect(results[0].excerpt.sectionTitle).toBe('Regular Area With Single Row of Individual');
    expect(results[0].excerpt.chapter).toEqual({ number: 'Annex A', title: 'Field Measurements' });
  });

  it('prefers the chapter spelled with its separator over a bare list item', async () => {
    // Measured on LP-1-24: its specification appendix numbers a clause "1.",
    // which reads as a chapter-1 heading beside the real "1.0 Light + Quality".
    const results = [resultWith('1.1')];
    await attachSectionTitles(
      sectionsFor({ '1': 'Install lighting equipment in accordance', '1.0': 'Light + Quality', '1.1': 'Human Needs Served by Lighting' }),
      results,
    );
    expect(results[0].excerpt.chapter).toEqual({ number: '1', title: 'Light + Quality' });
  });

  it('takes the longer reading when the two spellings are the same heading cut short', async () => {
    // Also LP-1-24: chapter 21 is recorded as both "The Phases" and the whole
    // "The Phases of the Lighting Design Process".
    const results = [resultWith('21.2')];
    await attachSectionTitles(
      sectionsFor({ '21': 'The Phases of the Lighting Design Process', '21.0': 'The Phases', '21.2': 'Design Development' }),
      results,
    );
    expect(results[0].excerpt.chapter.title).toBe('The Phases of the Lighting Design Process');
  });

  it('still gives the card its chapter when no titles were ever indexed', async () => {
    const results = [resultWith('8.7.2.4')];
    await attachSectionTitles({
      DB: { prepare: () => ({ bind() { return this; }, async all() { return { results: [] }; } }) },
    }, results);
    expect(results[0].excerpt.chapter).toEqual({ number: '8', title: null });
  });
});

// ─── DO064: a reference-marker chip opens the BODY page that cites the work ────

describe('citedStandardDesignation (DO064)', () => {
  it('reads the standard a bibliography entry cites', () => {
    expect(citedStandardDesignation(
      '5. Illuminating Engineering Society. ANSI/IES LS-7-20, Lighting Science: Vision – Eye and Brain. New York: IES; 2020.'
    )).toBe('LS-7-20');
  });

  it('is null for a reference that cites no IES standard', () => {
    expect(citedStandardDesignation(
      '3. Crawford BH. The scotopic visibility function. Proc Phys Soc B. 1949;62(5):321-334.'
    )).toBe(null);
  });
});

describe('findCitingPageInExcerpts (DO064)', () => {
  // Real text: LS-2-20 p. 10 refers the reader to LS-7-20 in its body.
  const excerptIndex = {
    'LS-2-20': [
      { chunk_type: 'text', page_number: 16, excerpt_text: 'additional information, this can limit the utility of illuminance.', score: 0.4 },
      { chunk_type: 'text', page_number: 10, excerpt_text: 'or scotopic. (Refer to ANSI/IES LS-7-20, Lighting Science: Vision – Eye and Brain for additional information.)', score: 0.5 },
      { chunk_type: 'reference', page_number: 27, excerpt_text: '5. Illuminating Engineering Society. ANSI/IES LS-7-20, Lighting Science: Vision – Eye and Brain.', score: 0.6 },
    ],
  };

  it('finds the earliest retrieved body page that names the cited work', () => {
    expect(findCitingPageInExcerpts(excerptIndex, 'LS-2-20', 'LS-7-20')).toBe(10);
  });

  it('never answers with the bibliography page — that is what it is replacing', () => {
    expect(findCitingPageInExcerpts(excerptIndex, 'LS-2-20', 'LS-7-20')).not.toBe(27);
  });

  it('matches a body citation that drops the edition', () => {
    const index = { 'RP-8-25': [{ chunk_type: 'text', page_number: 12, excerpt_text: 'refer to IES TM-15 for classification', score: 0.5 }] };
    expect(findCitingPageInExcerpts(index, 'RP-8-25', 'TM-15-20')).toBe(12);
  });

  it('does not mistake RP-43 for RP-4 — the family needs a boundary', () => {
    const index = {
      'G-1-22': [{ chunk_type: 'text', page_number: 30, excerpt_text: 'as described in ANSI/IES RP-43-25 for exterior applications', score: 0.5 }],
    };
    expect(findCitingPageInExcerpts(index, 'G-1-22', 'RP-4-20')).toBe(null);
    expect(findCitingPageInExcerpts(index, 'G-1-22', 'RP-43-25')).toBe(30);
  });

  it('is null with nothing to go on', () => {
    expect(findCitingPageInExcerpts(excerptIndex, 'LS-2-20', null)).toBe(null);
    expect(findCitingPageInExcerpts(undefined, 'LS-2-20', 'LS-7-20')).toBe(null);
    expect(findCitingPageInExcerpts(excerptIndex, 'RP-1-24', 'LS-7-20')).toBe(null);
  });
});

// ─── DO072: the formula never leaves the Worker ────────────────────────────────

describe('guardFormula (DO072)', () => {
  it('strips the equation lines and flags the passage', () => {
    const excerpt = guardFormula({
      text: [
        'A.1.1.3 Regular Area With Single Row of Individual Luminaires. The average illuminance,',
        'Eavg, in such a space (SeeFigure A-1c) can be determined from:',
        'Q(_______N− 1)+____P',
      ].join('\n'),
      pageNumber: 68, section: 'A.1.1.3', chunkType: 'text',
    });
    expect(excerpt.formulaOmitted).toBe(true);
    expect(excerpt.text).not.toMatch(/_{3,}/);
    expect(excerpt.text).toContain('Regular Area With Single Row of Individual Luminaires');
  });

  it('empties a passage that was nothing but the equation, so the card prints the notice', () => {
    const excerpt = guardFormula({
      text: 'Q(_______N− 1)+____P\nEavg = , N\nwhere:',
      pageNumber: 68, section: 'A.1.1.3', chunkType: 'text',
    });
    expect(excerpt.formulaOmitted).toBe(true);
    expect(excerpt.text).toBe('');
  });

  it('leaves prose untouched, and adds no flag', () => {
    const excerpt = guardFormula({
      text: 'Uniformity, the even distribution of illuminance across a task plane, is desirable.',
      pageNumber: 77, section: '13.4', chunkType: 'text',
    });
    expect(excerpt.formulaOmitted).toBeUndefined();
    expect(excerpt.text).toContain('Uniformity');
  });
});

// ─── DO072a: the AI Guide describes a formula, never writes one ────────────────

describe('stripFormulasFromAnswer (DO072a)', () => {
  it('keeps the sentence and drops the equation — the client\'s own wording', () => {
    const out = stripFormulasFromAnswer(
      'The calculation for LM-84 test data involves an exponential decay formula, as seen in Annex B. '
      + 'This formula, ΦtbLM-84 = ΦLM-84 · exp(−t·αLM-84), is used to approximate the luminous flux maintenance over time.'
    );
    expect(out).not.toContain('Φ');
    expect(out).toContain('This formula');
    expect(out).toContain('approximate the luminous flux maintenance over time');
    expect(out).toContain('Annex B');
  });

  it('is a no-op on an answer with no formula in it', () => {
    const text = 'According to ANSI/IES TM-28-20, Section 5.2, p. 12, projected lumen maintenance is described in Annex B.';
    expect(stripFormulasFromAnswer(text)).toBe(text);
  });
});

// ─── The prompts: what the model is actually told ─────────────────────────────

/** Capture the user prompt generateResponse builds, without a real model. */
async function capturePrompt(results, opts) {
  let prompt = null;
  let options = null;
  const ai = {
    run: vi.fn(async (_model, o) => {
      prompt = o.messages[1].content;
      options = o;
      return { response: 'An answer citing ANSI/IES RP-43-25, Section 6.2, p. 34.' };
    }),
  };
  await generateResponse(ai, 'what changed?', results, opts);
  return { prompt, options };
}

const RESULT = {
  resultType: 'excerpt',
  application: { standard: 'RP-43-25', standardFull: 'ANSI/IES RP-43-25', fullName: 'RP-43-25', category: 'RP-43-25' },
  citation: 'ANSI/IES RP-43-25, p. 34',
  excerpt: { text: 'Outdoor lighting requirements are set out here.', pageNumber: 34, section: '6.2', sectionTitle: 'Outdoor Lighting Requirements', chunkType: 'text' },
  excerpts: [{ text: 'Outdoor lighting requirements are set out here.', pageNumber: 34, section: '6.2', sectionTitle: 'Outdoor Lighting Requirements', chunkType: 'text' }],
  relevanceScore: 0.7,
};

describe('comparison prompt (DO062)', () => {
  it('asks for findings grouped by chapter, bolded, with the section title beside the number', async () => {
    const { prompt } = await capturePrompt([RESULT], {
      mode: 'comparison',
      comparison: {
        current: { id: 'RP-43-25', name: 'ANSI/IES RP-43-25', url: null },
        deprecated: [{ id: 'RP-43-22', name: 'ANSI/IES RP-43-22', url: null }],
      },
    });
    expect(prompt).toMatch(/Group the findings by CHAPTER/);
    expect(prompt).toMatch(/\*\*6\.2 Outdoor Lighting Requirements\*\*/);
    expect(prompt).toMatch(/Order the\s*\n?chapters by number/);
    expect(prompt).toMatch(/section TITLE/);
    expect(prompt).toMatch(/Give the PAGE in brackets/);
    // The three fixed sections survive the restructuring.
    expect(prompt).toContain('What appears to be new');
    expect(prompt).toContain('Likely technical updates');
    expect(prompt).toContain('Possible deletions');
    // And so does the DO028 grounding rule.
    expect(prompt).toMatch(/MUST appear verbatim in the excerpts above/);
  });

  it('carries the section title into the excerpt locator, so the model can name a chapter', async () => {
    const { prompt } = await capturePrompt([RESULT], {
      mode: 'comparison',
      comparison: { current: null, deprecated: [] },
    });
    expect(prompt).toContain('§6.2 Outdoor Lighting Requirements');
  });

  it('gets the longer budget the client asked for', () => {
    expect(tokenBudget('comparison')).toBe(6000);
    expect(tokenBudget('comparison')).toBeGreaterThan(tokenBudget('guide'));
  });
});

describe('adaptive guide prompt (the client\'s "Note": responses must not ramble)', () => {
  it('tells the model to size the answer to the question, and permits one paragraph', async () => {
    const { prompt, options } = await capturePrompt([RESULT], { mode: 'guide' });
    expect(prompt).toMatch(/LENGTH — decide it from the question/);
    expect(prompt).toMatch(/ONE specific answer that ONE standard covers gets ONE short paragraph/);
    expect(prompt).toMatch(/broad question .* gets 3–5 substantial paragraphs/);
    expect(options.max_tokens).toBe(3000);
  });

  it('permits — and shapes — an "the standards do not cover this" answer', async () => {
    const { prompt } = await capturePrompt([RESULT], { mode: 'guide' });
    expect(prompt).toMatch(/IF YOU CANNOT ANSWER/);
    expect(prompt).toMatch(/Standards@ies\.org/);
    expect(prompt).toMatch(/Do not assemble an answer out of adjacent material/);
  });

  it('no longer demands a "Further reading" section on every answer', async () => {
    const { prompt } = await capturePrompt([RESULT], { mode: 'guide' });
    expect(prompt).toMatch(/Omit the heading entirely when it would not/);
    expect(prompt).not.toMatch(/Close with "Further reading": at least one/);
  });

  it('forbids formulae in every mode (DO072a)', async () => {
    for (const mode of ['guide', 'comparison']) {
      const { prompt } = await capturePrompt([RESULT], { mode, comparison: { current: null, deprecated: [] } });
      expect(prompt).toMatch(/NEVER write a formula/);
    }
  });

  it('honours an explicit brief style, and caps the tokens as well as asking', async () => {
    const { prompt, options } = await capturePrompt([RESULT], { mode: 'guide', answerStyle: 'brief' });
    expect(prompt).toMatch(/at most TWO short paragraphs/);
    expect(options.max_tokens).toBe(tokenBudget('guide', 'brief'));
    expect(tokenBudget('guide', 'brief')).toBeLessThan(tokenBudget('guide', 'auto'));
  });

  it('honours an explicit full style', async () => {
    const { prompt } = await capturePrompt([RESULT], { mode: 'guide', answerStyle: 'full' });
    expect(prompt).toMatch(/3–5 substantial paragraphs, covering each standard/);
  });

  it('tells the model a formula is present without showing it one (DO072a)', async () => {
    const withFormula = {
      ...RESULT,
      excerpt: { ...RESULT.excerpt, text: 'The average illuminance can be determined from:', formulaOmitted: true },
      excerpts: [{ ...RESULT.excerpts[0], text: 'The average illuminance can be determined from:', formulaOmitted: true }],
    };
    const { prompt } = await capturePrompt([withFormula], { mode: 'guide' });
    expect(prompt).toMatch(/a formula is printed here — describe it, never reproduce it/);
  });
});

// ─── DO083: a reaffirmed printing is not a prior edition ──────────────────────

describe('baseEdition (DO083)', () => {
  it('strips an errata suffix and a reaffirmation marker', () => {
    expect(baseEdition('RP-8-25+E2')).toBe('RP-8-25');
    expect(baseEdition('LM-63-19R25')).toBe('LM-63-19');
    expect(baseEdition('LS-2-20(R2023)')).toBe('LS-2-20');
    expect(baseEdition('TM-31-20(R26)')).toBe('TM-31-20');
  });

  it('leaves an ordinary designation alone', () => {
    expect(baseEdition('RP-8-18')).toBe('RP-8-18');
    expect(baseEdition('TM-31-17')).toBe('TM-31-17');
  });
});

describe('the comparison target skips a reaffirmed twin (DO083)', () => {
  const edition = (id, deprecated) => ({
    resultType: 'excerpt',
    isDeprecated: !!deprecated,
    application: { standard: id, standardFull: `ANSI/IES ${id}` },
    standardLink: `https://lighting.ies.org/${id}`,
    excerpt: { text: 'x', pageNumber: 1, section: '1.1', chunkType: 'text' },
    excerpts: [],
    relevanceScore: 0.5,
    citation: id,
  });

  it('compares TM-31-20(R26) against TM-31-17, not against TM-31-20', () => {
    const ctx = buildComparisonContext(
      [edition('TM-31-20'), edition('TM-31-20', true), edition('TM-31-17', true)],
      null,
      { id: 'TM-31-20', fullDesignation: 'ANSI/IES TM-31-20(R26)', title: 'Measurement Uncertainty', webUrl: null },
    );
    expect(ctx.deprecated.map(d => d.id)).toEqual(['TM-31-17']);
    // The reaffirmed printing stays listed, so the reader can still open it.
    expect(ctx.alsoDeprecated.map(d => d.id)).toContain('TM-31-20');
  });

  it('reports no prior edition when the only "prior" one IS the current one', () => {
    const ctx = buildComparisonContext(
      [edition('LS-2-20'), edition('LS-2-20', true)],
      null,
      { id: 'LS-2-20', fullDesignation: 'ANSI/IES LS-2-20(R2023)', title: 'Concepts', webUrl: null },
    );
    expect(ctx.deprecated).toEqual([]);
    expect(ctx.current.id).toBe('LS-2-20');
    // And it SAYS so, rather than leaving the prompt to find a prior edition it
    // was simultaneously forbidden from using.
    expect(ctx.reaffirmedOnly).toBe(true);
  });

  it('does not flag reaffirmedOnly on an ordinary comparison', () => {
    const ctx = buildComparisonContext(
      [edition('RP-8-25'), edition('RP-8-22', true)],
      null,
      { id: 'RP-8-25', fullDesignation: 'ANSI/IES RP-8-25', title: 'Roadway', webUrl: null },
    );
    expect(ctx.reaffirmedOnly).toBe(false);
  });

  it('asks the model to say there is nothing to compare, and for nothing else', async () => {
    const { prompt } = await capturePrompt([RESULT], {
      mode: 'comparison',
      comparison: {
        current: { id: 'LS-2-20', name: 'ANSI/IES LS-2-20(R2023)', url: null },
        deprecated: [],
        alsoDeprecated: [{ id: 'LS-2-20', name: 'ANSI/IES LS-2-20', url: null }],
        reaffirmedOnly: true,
      },
    });
    expect(prompt).toMatch(/NO prior edition to compare against/);
    expect(prompt).toMatch(/reaffirmation republishes a standard unchanged/);
    // None of the four analysis sections may be written.
    expect(prompt).toMatch(/Do NOT write the "Extent of the changes"/);
    expect(prompt).not.toMatch(/Identify the current and the most recent deprecated edition/);
  });

  it('still compares two genuinely different editions', () => {
    const ctx = buildComparisonContext(
      [edition('RP-8-25'), edition('RP-8-22', true), edition('RP-8-18', true)],
      null,
      { id: 'RP-8-25', fullDesignation: 'ANSI/IES RP-8-25', title: 'Roadway', webUrl: null },
    );
    expect(ctx.deprecated.map(d => d.id)).toEqual(['RP-8-22']);
    expect(ctx.alsoDeprecated.map(d => d.id)).toEqual(['RP-8-18']);
  });

  it('does not add a second card for a reaffirmed printing', () => {
    const results = [edition('TM-31-20')];
    const editions = [
      { id: 'TM-31-20', status: 'Active', fullDesignation: 'ANSI/IES TM-31-20(R26)', title: 'x', webUrl: null },
      { id: 'TM-31-20R26', status: 'Deprecated', fullDesignation: 'ANSI/IES TM-31-20', title: 'x', webUrl: null, supersededBy: null },
      { id: 'TM-31-17', status: 'Deprecated', fullDesignation: 'ANSI/IES TM-31-17', title: 'x', webUrl: null, supersededBy: 'TM-31-20' },
    ];
    const ids = addMissingEditionCards(results, editions).map(r => r.application.standard);
    expect(ids).toContain('TM-31-17');
    expect(ids.filter(id => baseEdition(id) === 'TM-31-20')).toEqual(['TM-31-20']);
  });
});

describe('comparison prompt — extent of the changes (DO083)', () => {
  it('asks how extensive the substantive changes are, and why it matters', async () => {
    const { prompt } = await capturePrompt([RESULT], {
      mode: 'comparison',
      comparison: {
        current: { id: 'RP-43-25', name: 'ANSI/IES RP-43-25', url: null },
        deprecated: [{ id: 'RP-43-22', name: 'ANSI/IES RP-43-22', url: null }],
      },
    });
    expect(prompt).toContain('Extent of the changes');
    expect(prompt).toMatch(/HOW EXTENSIVE/);
    expect(prompt).toMatch(/WHY MIGHT THAT MATTER/);
    expect(prompt).toMatch(/Extensive, Moderate or Minimal/);
  });

  it('carries the word budgets for each of the three extents', async () => {
    const { prompt } = await capturePrompt([RESULT], {
      mode: 'comparison',
      comparison: { current: null, deprecated: [] },
    });
    expect(prompt).toMatch(/800–1200 words; never exceed ~1500/);
    expect(prompt).toMatch(/500–1000 words; never exceed ~1200/);
    expect(prompt).toMatch(/100–300 words; never exceed ~500/);
    expect(prompt).toMatch(/Do NOT pad a Minimal comparison/);
  });

  it('defines "substantive" the way the client did', async () => {
    const { prompt } = await capturePrompt([RESULT], {
      mode: 'comparison', comparison: { current: null, deprecated: [] },
    });
    expect(prompt).toMatch(/significant modification or expansion/);
  });
});

// ─── DO084: the AHJ notice reaches the model and the card ─────────────────────

describe('the AHJ notice in the prompt and on the summary (DO084)', () => {
  const NOTICE = 'IES standards and guidance do not supersede applicable laws…';

  it('tells the model the notice is displayed and not to repeat it', async () => {
    const { prompt } = await capturePrompt([RESULT], { mode: 'guide', authorityNotice: NOTICE });
    expect(prompt).toContain(NOTICE);
    expect(prompt).toMatch(/Do NOT repeat it or paraphrase it/);
  });

  it('says nothing about a notice when there is none', async () => {
    const { prompt } = await capturePrompt([RESULT], { mode: 'guide' });
    expect(prompt).not.toMatch(/compliance notice is already displayed/);
  });

  it('returns the notice on the summary, so a cached answer keeps it', async () => {
    const ai = { run: async () => ({ response: 'Egress lighting is covered by ANSI/IES RP-8-25, Section 4.1, p. 12.' }) };
    const summary = await generateResponse(ai, 'egress lighting', [RESULT], {
      mode: 'guide', authorityNotice: NOTICE,
    });
    expect(summary.authorityNotice).toBe(NOTICE);
  });

  it('keeps the notice even when every model fails', async () => {
    const ai = { run: async () => { throw new Error('capacity'); } };
    const summary = await generateResponse(ai, 'egress lighting', [RESULT], {
      mode: 'guide', authorityNotice: NOTICE,
    });
    expect(summary.degraded).toBe(true);
    expect(summary.authorityNotice).toBe(NOTICE);
  });
});

// ─── DO088: no fluff in the first sentence ────────────────────────────────────

describe('stripOpeningFluff (DO088)', () => {
  it('drops the two openings the client flagged', () => {
    const a = stripOpeningFluff(
      'For a LZ2 roadway, the illuminance target is a crucial aspect of lighting design. '
      + 'According to ANSI/IES RP-43-25, LZ2 is defined as a developed area with moderate anthropogenic light.'
    );
    expect(a).toMatch(/^According to ANSI\/IES RP-43-25/);

    const b = stripOpeningFluff(
      'Luminance plays a crucial role in lighting design as it affects the visibility of objects and scenes. '
      + 'According to ANSI/IES RP-1-24, luminance is a measurable quantity.'
    );
    expect(b).toMatch(/^According to ANSI\/IES RP-1-24/);
  });

  it('keeps the opening the client marked GOOD', () => {
    const good = 'Egress lighting refers to the illumination provided to ensure safe evacuation of a building '
      + 'during an emergency, such as a power outage. According to ANSI/IES RP-4-20, emergency egress lighting is required.';
    expect(stripOpeningFluff(good)).toBe(good);
  });

  it('never removes a sentence that cites something', () => {
    const cited = 'ANSI/IES RP-8-25 is a crucial aspect of roadway design. It also covers parking.';
    expect(stripOpeningFluff(cited)).toBe(cited);
  });

  it('never leaves the answer empty', () => {
    const only = 'Uniformity is a crucial aspect of lighting design.';
    expect(stripOpeningFluff(only)).toBe(only);
  });

  it('leaves a heading alone', () => {
    const withHeading = '## Overview\nLuminance plays a crucial role in lighting design. And then this.';
    expect(stripOpeningFluff(withHeading)).toBe(withHeading);
  });

  // The shape every other case here misses: the model does not always put the
  // filler in front of the substance on ONE line. When it writes the opener as
  // its own short paragraph, the block holds nothing after the sentence — and
  // the "never leave the answer empty" guard used to refuse on that alone, so
  // the fluff reached the reader. Found against production, 2026-08-31.
  it('drops a filler opener that is its own paragraph', () => {
    const para = 'Luminance plays a crucial role in lighting design as it affects the visibility of objects and scenes.'
      + '\n\nAccording to ANSI/IES RP-1-24, Section 4.2, luminance is a measurable quantity.';
    expect(stripOpeningFluff(para)).toBe('According to ANSI/IES RP-1-24, Section 4.2, luminance is a measurable quantity.');
  });

  it('keeps a filler-shaped paragraph when it is the whole answer', () => {
    const only = 'Uniformity is a crucial aspect of lighting design.\n\n';
    expect(stripOpeningFluff(only)).toBe(only);
  });

  it('keeps a standalone opening paragraph that cites something', () => {
    const cited = 'ANSI/IES RP-8-25 is a crucial aspect of roadway design.\n\nIt also covers parking.';
    expect(stripOpeningFluff(cited)).toBe(cited);
  });

  it('is applied by generateResponse', async () => {
    const ai = { run: async () => ({
      response: 'For a LZ2 roadway, the illuminance target is a crucial aspect of lighting design. '
        + 'According to ANSI/IES RP-43-25, Section 6.2, p. 34, the criteria are set out by lighting zone.',
    }) };
    const summary = await generateResponse(ai, 'illuminance target for a LZ2 roadway', [RESULT]);
    expect(summary.text).toMatch(/^According to ANSI\/IES RP-43-25/);
  });
});

describe('guide prompt — no restating the question (DO088)', () => {
  it('forbids the two openings by example', async () => {
    const { prompt } = await capturePrompt([RESULT], { mode: 'guide' });
    expect(prompt).toMatch(/FIRST SENTENCE: answer the question/);
    expect(prompt).toMatch(/is a crucial aspect of/);
    expect(prompt).toMatch(/do not restate it/);
  });
});

// ─── DO086: tables and figures reach the prompt and the fallback ──────────────

describe('assets in the prompt (DO086)', () => {
  it('names the table and its page, and says its contents are not visible', async () => {
    const withAsset = {
      ...RESULT,
      assets: [{ kind: 'table', label: 'Table C-1', caption: 'Sound Absorption Coefficients for Various Materials', page: 62, url: null }],
    };
    const { prompt } = await capturePrompt([withAsset], { mode: 'guide' });
    expect(prompt).toContain('Table C-1');
    expect(prompt).toContain('Sound Absorption Coefficients for Various Materials');
    expect(prompt).toContain('(p. 62)');
    expect(prompt).toMatch(/you cannot see its contents/);
  });

  it('tells the Guide to name a table rather than deny one exists', async () => {
    const { prompt } = await capturePrompt([RESULT], { mode: 'guide' });
    expect(prompt).toMatch(/NAME it and give its page/);
    expect(prompt).toMatch(/never say a table does not exist merely because it was not listed/);
  });
});

describe('assetsFromExcerpts — the pre-re-ingest fallback (DO086)', () => {
  it('reads a caption straight out of a retrieved passage', () => {
    const r = {
      resultType: 'excerpt',
      application: { standard: 'RP-1-24' },
      excerpt: {
        text: 'Table C-1 Sound Absorption Coefficients for Various Materials\nMaterial 125 Hz 250 Hz',
        pageNumber: 62, section: 'Annex C', chunkType: 'text',
      },
      excerpts: [],
    };
    expect(assetsFromExcerpts(r)).toEqual([
      { kind: 'table', label: 'Table C-1', caption: 'Sound Absorption Coefficients for Various Materials', page: 62 },
    ]);
  });

  it('is empty when no passage carries a caption', () => {
    const r = {
      resultType: 'excerpt',
      application: { standard: 'RP-1-24' },
      excerpt: { text: 'Uniformity, the even distribution of illuminance, is desirable.', pageNumber: 77, section: '13.4', chunkType: 'text' },
      excerpts: [],
    };
    expect(assetsFromExcerpts(r)).toEqual([]);
  });
});
