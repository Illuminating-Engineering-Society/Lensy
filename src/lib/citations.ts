/**
 * Citation Formatter
 * Formats IES standard citations per ANSI/IES style guidelines.
 * Copyright Rule: Never quote more than 15 words from a single source.
 */

/** Fields formatCitation reads — a D1 application row OR a formatted result. */
interface CitationInput {
  Standard_Full?: string | null; standardFull?: string | null;
  Standard?: string | null; standard?: string | null;
  Table_Ref?: string | null; tableRef?: string | null;
  Row_Ref?: string | number | null; rowRef?: string | number | null;
}

interface StandardCitationInput {
  full_designation?: string | null;
  id: string;
  title?: string | null;
}

export interface CopyrightViolation {
  type: 'long_quote' | 'prohibited_phrase';
  detail: string;
}

/**
 * Compose the full display name of a standard: designation + descriptive
 * title, e.g. "ANSI/IES RP-2-20+E1 Recommended Practice: Lighting Retail
 * Spaces". Client requirement: EVERY search result shows the full title, not
 * the bare designation. Handles titles that already embed the designation
 * (common in PDF metadata) without duplicating it.
 */
export function composeStandardName(designation: string | null | undefined, title: string | null | undefined): string {
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
 * Format a full citation for an application record. `title` (the standard's
 * descriptive title from D1) is appended so every citation carries the full
 * standard name — client requirement, both result render paths.
 */
export function formatCitation(
  app: CitationInput,
  section: string | null = null,
  pageNumber: number | null = null,
  title: string | null = null,
): string {
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

/** Format a citation from raw standard metadata (e.g. for PDF chunk results). */
export function formatStandardCitation(
  standard: StandardCitationInput,
  pageNumber: number | null = null,
  section: string | null = null,
): string {
  const designation = standard.full_designation || standard.id;
  const title = standard.title || '';

  let citation = `${designation} ${title}`;
  if (section) citation += `, Section ${section}`;
  if (pageNumber) citation += `, p. ${pageNumber}`;
  return citation;
}

/** Validate that a citation string meets IES requirements. */
export function validateCitation(text: string): { valid: boolean; issues: string[] } {
  const issues: string[] = [];

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
 * Enforces: max 15 words per quoted passage; no prohibited reproduction phrases.
 */
export function checkCopyrightViolations(text: string): CopyrightViolation[] {
  const violations: CopyrightViolation[] = [];

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
  const prohibited = ['all rights reserved', 'reproduced with permission', 'copyright ies'];
  for (const phrase of prohibited) {
    if (text.toLowerCase().includes(phrase)) {
      violations.push({ type: 'prohibited_phrase', detail: `Contains prohibited phrase: "${phrase}"` });
    }
  }

  return violations;
}
