/**
 * Tables and figures as locators (client DO086).
 *
 * The fixtures are the client's own examples: RP-1-24's sound-absorption table
 * (Table C-1, p. 62) and its photometric-web figure (Figure 5-1, p. 26).
 */

import { describe, it, expect } from 'vitest';
import {
  parseCaptionLine, extractDocumentAssets, matchAssets, asksForAsset, assetQueryTerms,
} from './document-assets.js';

const page = (number, lines) => ({ number, text: lines.join('\n'), lines: lines.map(text => ({ text })) });

const RP1_PAGES = [
  page(18, [
    'Table 2-1 Recommended Maximum Ceiling Luminance Gradients From Uplights',
    'Some prose about the table follows here for context.',
  ]),
  page(26, [
    'Figure 5-1 Photometric web diagrams for the six indoor luminaire classifications',
    'The classifications are described in the section above.',
  ]),
  page(62, [
    'Table C-1 Sound Absorption Coefficients for Various Materials',
    'Material 125 Hz 250 Hz 500 Hz',
  ]),
];

describe('parseCaptionLine', () => {
  it('reads a table caption, label and all', () => {
    expect(parseCaptionLine('Table C-1 Sound Absorption Coefficients for Various Materials')).toEqual({
      kind: 'table',
      label: 'Table C-1',
      caption: 'Sound Absorption Coefficients for Various Materials',
    });
  });

  it('reads a figure caption, and normalizes "Fig."', () => {
    expect(parseCaptionLine('Fig. 13-19 Overhead downlights produce poor uniformity')).toEqual({
      kind: 'figure',
      label: 'Figure 13-19',
      caption: 'Overhead downlights produce poor uniformity',
    });
  });

  it('refuses a cross-reference inside running text', () => {
    expect(parseCaptionLine('Table 4-1')).toBe(null);
    expect(parseCaptionLine('Table 4-1 see the values in the annex')).toBe(null);
  });

  it('refuses a list-of-figures line', () => {
    expect(parseCaptionLine('Table C-1 Sound Absorption Coefficients . . . . . . . . . 62')).toBe(null);
    expect(parseCaptionLine('Figure 5-1 Photometric web diagrams          26')).toBe(null);
  });

  it('refuses a caption that is not a name', () => {
    // Running text continuing a sentence: a caption opens with a capital.
    expect(parseCaptionLine('Table 4-1 and the values it contains are discussed below')).toBe(null);
    expect(parseCaptionLine('Table 4-1 the')).toBe(null);      // too short
    expect(parseCaptionLine('Tabletop lighting for a restaurant')).toBe(null);
  });
});

describe('extractDocumentAssets', () => {
  it('finds every caption with its page', () => {
    const assets = extractDocumentAssets(RP1_PAGES);
    expect(assets).toEqual([
      { kind: 'table', label: 'Table 2-1', caption: 'Recommended Maximum Ceiling Luminance Gradients From Uplights', page: 18 },
      { kind: 'figure', label: 'Figure 5-1', caption: 'Photometric web diagrams for the six indoor luminaire classifications', page: 26 },
      { kind: 'table', label: 'Table C-1', caption: 'Sound Absorption Coefficients for Various Materials', page: 62 },
    ]);
  });

  it('joins a caption cut at the column boundary (measured on RP-1-24)', () => {
    // "Table 4-2 UGR Values and Corresponding Descriptive" / "Glare Criteria".
    // Joined only on GEOMETRY — same font, same margin — so a fixture without
    // line positions joins nothing.
    const geo = (text, fontSize = 9, x = 63) => ({ text, fontSize, x });
    const assets = extractDocumentAssets([{
      number: 29,
      text: '',
      lines: [
        geo('Table 4-2 UGR Values and Corresponding Descriptive'),
        geo('Glare Criteria'),
        geo('The UGR method is described in the section above.', 10, 317),
      ],
    }]);
    expect(assets[0].caption).toBe('UGR Values and Corresponding Descriptive Glare Criteria');
  });

  it('never joins the table\'s own first data row', () => {
    const geo = (text) => ({ text, fontSize: 9, x: 63 });
    const assets = extractDocumentAssets([{
      number: 71,
      text: '',
      lines: [
        geo('Table C-1 Sound Absorption Coefficients for Various Materials'),
        geo('Material 125 Hz 250 Hz 500 Hz'),
      ],
    }]);
    expect(assets[0].caption).toBe('Sound Absorption Coefficients for Various Materials');
  });

  it('keeps the FIRST printing when a caption is repeated', () => {
    const assets = extractDocumentAssets([
      page(26, ['Table 11-2 Photometric Quantities']),
      page(27, ['Table 11-2 Photometric Quantities (continued)']),
    ]);
    expect(assets).toHaveLength(1);
    expect(assets[0].page).toBe(26);
  });
});

describe('matchAssets — the client\'s failing searches', () => {
  const assets = extractDocumentAssets(RP1_PAGES);

  it('finds Table C-1 for "the table that shows sound coefficients for various materials"', () => {
    const found = matchAssets(assets, 'Where is the table that shows sound coefficients for various materials?');
    expect(found.map(a => a.label)).toContain('Table C-1');
    expect(found[0].page).toBe(62);
  });

  it('finds Table C-1 for "the sound absorption coefficient for linoleum"', () => {
    const found = matchAssets(assets, 'what is the sound absorption coefficient for linoleum?');
    expect(found[0].label).toBe('Table C-1');
  });

  it('finds Figure 5-1 for a photometric-web question', () => {
    const found = matchAssets(assets, 'images of what classifications for indoor fixtures look like — photometric web diagrams');
    expect(found.map(a => a.label)).toContain('Figure 5-1');
  });

  it('finds the ceiling-gradient table the client asked about', () => {
    const found = matchAssets(assets, 'maximum ceiling luminance gradient from uplights for critical surfaces');
    expect(found[0].label).toBe('Table 2-1');
  });

  it('matches nothing when the query is about something else', () => {
    expect(matchAssets(assets, 'recommended illuminance for a hotel lobby')).toEqual([]);
  });

  it('needs two matching words unless the reader asked for a table or figure', () => {
    // "materials" alone is one word — not enough on its own …
    expect(matchAssets(assets, 'materials')).toEqual([]);
    // … but it is when the question is explicitly about a table.
    expect(matchAssets(assets, 'table of materials').map(a => a.label)).toContain('Table C-1');
  });

  it('returns NOTHING for a table the document does not have (measured on RP-1-24)', () => {
    // RP-1-24 has no light-loss-factor table. Without a relevance floor this
    // query filled its quota with five unrelated figures.
    expect(matchAssets(assets, 'table of light loss factors')).toEqual([]);
  });

  it('matches on whole words, so "light" does not match "Lighting"', () => {
    const lightingOnly = [
      { kind: 'figure', label: 'Figure 2-1', caption: 'Lighting quality: the integration of three considerations', page: 11 },
    ];
    expect(matchAssets(lightingOnly, 'table of light loss factors')).toEqual([]);
  });
});

describe('asksForAsset / assetQueryTerms', () => {
  it('recognizes a request for a table, figure or image', () => {
    expect(asksForAsset('where is the table of light loss factors')).toBe(true);
    expect(asksForAsset('I need photometric web diagrams')).toBe(true);
    expect(asksForAsset('illuminance for a walkway')).toBe(false);
  });

  it('drops the words that identify nothing', () => {
    expect(assetQueryTerms('Where is the table that shows sound coefficients?'))
      .toEqual(['sound', 'coefficients']);
  });
});
