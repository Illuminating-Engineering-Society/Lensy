/**
 * "Cite as" under every bookmark (Dan, Teams 11/13/26 #2):
 *
 *   Illuminating Engineering Society. RP-##-yy* Recommended Practice: ______,
 *   Table A-1, p. 38. New York: IES; YYYY, https://lighting.ies.org/BJXuxu#page=42.
 *
 * "…where 'p. 38' is the printed page number and the URL links to Vitrium page
 *  number; if reference is to an entire standard then remove the table/page
 *  portion."
 */

import { describe, it, expect } from 'vitest';
import { buildCiteAs, catalogueIdFor, citeLocator, designationYear } from './cite-as';

const RP43 = {
  id: 'RP-43-25',
  full_designation: 'ANSI/IES RP-43-25',
  title: 'Recommended Practice: Lighting Exterior Applications',
  published_date: '2025-12-19',
  vitrium_web_url: 'https://lighting.ies.org/dpgQ4A',
};

describe('buildCiteAs', () => {
  it('cites an illuminance row by table and PRINTED page, linking the PDF page', () => {
    const cite = buildCiteAs(RP43, {
      result_type: 'tables',
      // What a search card saves: formatCitation(designation + title, table, row).
      resource_title: 'ANSI/IES RP-43-25 Recommended Practice: Lighting Exterior Applications, Table A-1, Row 109',
      page_number: 42, page_label: '38',
      library_url: 'https://lighting.ies.org/dpgQ4A#page=42',
    });
    expect(cite.text).toBe(
      'Illuminating Engineering Society. ANSI/IES RP-43-25 Recommended Practice: Lighting Exterior Applications, '
      + 'Table A-1, p. 38. New York: IES; 2025');
    expect(cite.url).toBe('https://lighting.ies.org/dpgQ4A#page=42');
    expect(cite.line).toBe(`${cite.text}, https://lighting.ies.org/dpgQ4A#page=42.`);
  });

  it('drops the table/page portion for a whole standard', () => {
    const cite = buildCiteAs(RP43, {
      result_type: 'body',
      resource_title: 'ANSI/IES RP-43-25 Recommended Practice: Lighting Exterior Applications',
      page_number: null, library_url: 'https://lighting.ies.org/dpgQ4A',
    });
    expect(cite.line).toBe(
      'Illuminating Engineering Society. ANSI/IES RP-43-25 Recommended Practice: Lighting Exterior Applications. '
      + 'New York: IES; 2025, https://lighting.ies.org/dpgQ4A.');
  });

  it('falls back to the PDF page when no printed label was resolved', () => {
    const cite = buildCiteAs(RP43, { result_type: 'references', resource_title: 'x', page_number: 79 });
    expect(cite.text).toContain(', p. 79. New York: IES; 2025');
    // No link of its own → the standard's front cover.
    expect(cite.url).toBe('https://lighting.ies.org/dpgQ4A');
  });

  it('cites a passage or table-of-contents bookmark by its section', () => {
    const cite = buildCiteAs(RP43, {
      result_type: 'body',
      resource_title: 'ANSI/IES RP-43-25 Recommended Practice: Lighting Exterior Applications, Section 8.6.1.4 Outdoor Dining, p. 33',
      page_number: 42, page_label: '33',
    });
    expect(cite.text).toContain('Applications, Section 8.6.1.4, p. 33. New York');
  });

  it('reads the table from a listed table\'s own title', () => {
    expect(citeLocator({
      result_type: 'tables',
      resource_title: 'ANSI/IES RP-8-25+E2 Recommended Practice: Lighting Roadway and Parking Facilities, Table 17-1: Parking Lots, p. 17-4',
      application_name: 'Table 17-1: Parking Lots', page_number: 385, page_label: '17-4',
    })).toBe('Table 17-1, p. 17-4');
    // The title alone is enough when the citation carries none.
    expect(citeLocator({
      result_type: 'tables', resource_title: 'ANSI/IES RP-2-20+E1',
      application_name: 'Table B.3 Recommended Illuminance', page_number: 72,
    })).toBe('Table B.3, p. 72');
  });

  it('reads the table of a legacy illuminance bookmark from its snapshot', () => {
    expect(citeLocator({
      result_type: 'tables', resource_title: null, page_number: 60,
      snapshot_data: JSON.stringify({ Table_Ref: 'Table A-2', Hor_Lux: 300 }),
    })).toBe('Table A-2, p. 60');
  });

  it('never mistakes prose for a label, or a table for a section', () => {
    expect(citeLocator({ result_type: 'tables', resource_title: 'X, Table of Contents', page_number: 3 })).toBe('p. 3');
    expect(citeLocator({ result_type: 'body', resource_title: 'X, Table A-1', page_number: 3 })).toBe('p. 3');
    expect(citeLocator({ result_type: 'body', resource_title: 'X, Section Annex A Field Measurements' })).toBe('Annex A');
    expect(citeLocator({ result_type: 'definitions', resource_title: 'ANSI/IES LS-1-25 Lighting Science' })).toBe('');
  });

  it('takes the year from the designation, then from the catalogue date', () => {
    // The Library release date is not the edition: RP-6-24 was released in 2025.
    expect(buildCiteAs({
      id: 'RP-6-24', full_designation: 'ANSI/IES RP-6-24', title: 'Recommended Practice: Lighting Sports and Recreational Areas',
      published_date: '2025-02-11',
    }, { result_type: 'body' }).text).toMatch(/IES; 2024$/);
    // A reaffirmed printing keeps its edition year.
    expect(buildCiteAs({
      id: 'LM-63-19', full_designation: 'ANSI/IES LM-63-19(R25)', title: 'Approved Method: IES Standard File Format',
      published_date: '2025-08-14',
    }, { result_type: 'body' }).text).toMatch(/IES; 2019$/);
    // A designation with no year falls back to the catalogue date…
    expect(buildCiteAs({ id: 'LS-1', title: 'Lighting Science: Nomenclature', published_date: '2025-12-17' },
      { result_type: 'definitions' }).text).toMatch(/IES; 2025$/);
    // …and with no date anywhere the imprint stands alone rather than inventing one.
    expect(buildCiteAs({ id: 'LS-1', title: 'Lighting Science: Nomenclature' }, { result_type: 'definitions' }).text)
      .toBe('Illuminating Engineering Society. LS-1 Lighting Science: Nomenclature. New York: IES');
  });

  it('resolves a definition bookmark (filed under "LS-1-25") to the catalogue\'s LS-1 row', () => {
    expect(catalogueIdFor('LS-1-25')).toBe('LS-1');
    expect(catalogueIdFor('LS-1')).toBe('LS-1');
    expect(catalogueIdFor('LS-10-20')).toBe('LS-10-20');
    expect(catalogueIdFor('RP-43-25')).toBe('RP-43-25');
    expect(catalogueIdFor(null)).toBeNull();
    const cite = buildCiteAs({
      id: 'LS-1', full_designation: 'ANSI/IES LS-1-25',
      title: 'Lighting Science: Nomenclature and Definitions for Illuminating Engineering',
      published_date: '2025-12-17', vitrium_web_url: 'https://ies.org/standards/definitions/',
    }, { result_type: 'definitions', library_url: 'https://ies.org/standards/definitions/parking-lamp/' });
    expect(cite.line).toBe('Illuminating Engineering Society. ANSI/IES LS-1-25 Lighting Science: Nomenclature and Definitions '
      + 'for Illuminating Engineering. New York: IES; 2025, https://ies.org/standards/definitions/parking-lamp/.');
  });

  it('prints the designation alone when the catalogue title is not a title', () => {
    const junk = buildCiteAs({ id: 'RP-27.3-07', full_designation: 'ANSI/IES RP-27.3-07', title: 'RP_2705Cover', published_date: '2007-05-17' },
      { result_type: 'body' });
    expect(junk.text).toBe('Illuminating Engineering Society. ANSI/IES RP-27.3-07. New York: IES; 2007');
  });

  it('names ASHRAE as the publisher of the joint 90.1 standard', () => {
    const cite = buildCiteAs({
      id: 'ASHRAE-IES-90.1-2025', full_designation: 'ANSI/ASHRAE/IES 90.1-2025', title: 'ASHRAE-IES-90.1-2025',
      published_date: '2025-10-31', vitrium_web_url: 'https://lighting.ies.org/2AfKJz',
    }, { result_type: 'body', page_number: 12, library_url: 'https://lighting.ies.org/2AfKJz#page=12' });
    expect(cite.line).toBe('ASHRAE. ANSI/ASHRAE/IES 90.1-2025, p. 12. Peachtree Corners, GA: ASHRAE; 2025, https://lighting.ies.org/2AfKJz#page=12.');
  });

  it('rewrites a stored Vitrium viewer host onto the branded Library host', () => {
    const cite = buildCiteAs({ ...RP43, vitrium_web_url: 'https://view.protectedpdf.com/dpgQ4A' }, { result_type: 'body' });
    expect(cite.url).toBe('https://lighting.ies.org/dpgQ4A');
  });

  it('cites nothing for a standard the catalogue does not hold, or a link that is not http(s)', () => {
    expect(buildCiteAs(null, { result_type: 'body', page_number: 1 })).toBeNull();
    expect(buildCiteAs(undefined, {})).toBeNull();
    const cite = buildCiteAs({ id: 'RP-1-24', title: 'Recommended Practice: Lighting Office Spaces' },
      { result_type: 'body', library_url: 'javascript:alert(1)' });
    expect(cite.url).toBeNull();
    expect(cite.line).toBe('Illuminating Engineering Society. RP-1-24 Recommended Practice: Lighting Office Spaces. New York: IES; 2024.');
  });
});

describe('designationYear', () => {
  it('reads the edition year off every designation shape in the catalogue', () => {
    expect(designationYear('ANSI/IES RP-43-25')).toBe(2025);
    expect(designationYear('RP-8-25+E2')).toBe(2025);
    expect(designationYear('ANSI/IES LM-63-19(R25)')).toBe(2019);
    expect(designationYear('LS-6-20+E1 (R2025)')).toBe(2020);
    expect(designationYear('RP-27.3-07')).toBe(2007);
    expect(designationYear('RP-33-99')).toBe(1999);
    expect(designationYear('ASHRAE-IES-90.1-2025')).toBe(2025);
    expect(designationYear('LS-1')).toBeNull();
    expect(designationYear(null)).toBeNull();
  });
});
