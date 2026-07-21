/**
 * Citation Formatter
 * Formats IES standard citations per ANSI/IES style guidelines.
 * Copyright Rule: Never quote more than 15 words from a single source.
 */

/**
 * Compose the full display name of a standard: designation + descriptive
 * title, e.g. "ANSI/IES RP-2-20+E1 Recommended Practice: Lighting Retail
 * Spaces". Client requirement: EVERY search result shows the full title, not
 * the bare designation. Handles titles that already embed the designation
 * (common in PDF metadata) without duplicating it.
 *
 * @param {string} designation - e.g. "ANSI/IES RP-2-20+E1"
 * @param {string|null} title - descriptive title from the standards table
 * @returns {string}
 */
export function composeStandardName(designation, title) {
  const d = (designation || '').trim();
  const t = (title || '').trim();
  if (!t) return d;
  if (!d) return t;
  // Title already carries the full designation → use the title as-is.
  if (t.toUpperCase().startsWith(d.toUpperCase())) return t;
  // Title starts with the bare id ("RP-2-20 Lighting Retail Spaces") →
  // reattach the designation's prefix ("ANSI/IES ") instead of duplicating.
  const coreId = d.replace(/^ANSI\/IES\s+/i, '');
  if (coreId !== d && t.toUpperCase().startsWith(coreId.toUpperCase())) {
    return `${d.slice(0, d.length - coreId.length)}${t}`;
  }
  return `${d} ${t}`;
}

/**
 * Format a full citation for an application record.
 * @param {Object} app - Application row (from D1 or formatted)
 * @param {string|null} section - Optional section override
 * @param {number|null} pageNumber - Optional page number override
 * @param {string|null} title - Standard's descriptive title (from D1 standards
 *   table) — appended to the designation so every citation carries the full
 *   standard name (client requirement, both result render paths).
 * @returns {string}
 */
export function formatCitation(app, section = null, pageNumber = null, title = null) {
  // Prefer the Standard_Full field (e.g. "ANSI/IES RP-9-20") over abbreviated Standard
  const designation = app.Standard_Full || app.standardFull || app.Standard || app.standard || '';
  const tableRef = app.Table_Ref || app.tableRef || '';
  const rowRef = app.Row_Ref || app.rowRef || '';

  let citation = composeStandardName(designation, title);

  if (tableRef) citation += `, ${tableRef}`;
  if (rowRef) citation += `, ${rowRef}`;
  if (section) citation += `, Section ${section}`;
  if (pageNumber) citation += `, p. ${pageNumber}`;

  return citation;
}

/**
 * Format a citation from raw standard metadata (e.g. for PDF chunk results).
 * @param {Object} standard - Standard row from D1
 * @param {number} pageNumber
 * @param {string|null} section
 * @returns {string}
 */
export function formatStandardCitation(standard, pageNumber = null, section = null) {
  const designation = standard.full_designation || standard.id;
  const title = standard.title || '';

  let citation = `${designation} ${title}`;
  if (section) citation += `, Section ${section}`;
  if (pageNumber) citation += `, p. ${pageNumber}`;
  return citation;
}

/**
 * Validate that a citation string meets IES requirements.
 * @param {string} text - Citation text to validate
 * @returns {{ valid: boolean, issues: string[] }}
 */
export function validateCitation(text) {
  const issues = [];

  if (!/ANSI\/IES\s+[A-Z]+-\d+-\d+/.test(text)) {
    issues.push('Missing ANSI/IES standard designation (e.g. ANSI/IES RP-9-20)');
  }
  if (!/p\.\s*\d+|Section\s+\d+|Table\s+[A-Z]/.test(text)) {
    issues.push('Missing location reference (page number, section, or table)');
  }

  return { valid: issues.length === 0, issues };
}

/**
 * Check AI-generated text for copyright violations.
 * Enforces:
 *   - Max 15 words per quoted passage
 *   - Max 1 quote per source
 * @param {string} text - AI-generated response text
 * @returns {Array<{type: string, detail: string}>} Array of violations (empty if clean)
 */
export function checkCopyrightViolations(text) {
  const violations = [];

  // Check for long quoted passages (>15 words between quotes)
  const quotedPassages = text.match(/"[^"]{30,}"/g) || [];
  for (const passage of quotedPassages) {
    const wordCount = passage.split(/\s+/).length;
    if (wordCount > 17) { // 15 words + 2 for the quote marks themselves
      violations.push({
        type: 'long_quote',
        detail: `Quoted passage is ~${wordCount - 2} words (max 15): "${passage.substring(0, 60)}..."`,
      });
    }
  }

  // Check for prohibited reproduction phrases
  const prohibited = [
    'all rights reserved',
    'reproduced with permission',
    'copyright ies',
  ];
  for (const phrase of prohibited) {
    if (text.toLowerCase().includes(phrase)) {
      violations.push({
        type: 'prohibited_phrase',
        detail: `Contains prohibited phrase: "${phrase}"`,
      });
    }
  }

  return violations;
}
