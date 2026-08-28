/**
 * Formula detection and redaction (client DO072 / DO072a).
 *
 * "Formulae do not display properly. If we can display them accurately (perhaps
 *  as a screenshot?) great. If not, it would be better to return 'Open in
 *  Library to see formula' than to display them inaccurately."
 * "Do not display formulae in the AI Guide. The text-only representation can be
 *  misleading and/or inaccurate. Instead, could just print 'This formula is used
 *  to approximate…'"
 *
 * WHY the text is mangled, and why it cannot be fixed by parsing harder: a PDF
 * equation is a LAYOUT, not a string. pdfjs hands us the glyph runs in reading
 * order with no notion of numerator/denominator, so a fraction bar arrives as a
 * run of underscores and the numerator lands beside — not above — the
 * denominator:
 *
 *   Q(___________N− 1)+ P            (LP-9-25 p. 68, Annex A.1.1.3)
 *   Eavg = ,   N
 *
 * Nothing downstream can reassemble that. So the rule this module implements is
 * the client's: say a formula is there, link to the page that prints it
 * properly, and never show the reconstruction.
 *
 * Plain ESM JS (no TypeScript) so the Worker, the frontend test harness and the
 * Node ingest scripts can all import it.
 */

/** The line a card prints where a formula was (client DO072). */
export const FORMULA_NOTICE = 'Formula not shown — open the standard in the Library to see it.';

/** What the AI Guide's prose keeps where a formula was (client DO072a). */
export const AI_FORMULA_PLACEHOLDER = '';

// A fraction bar. pdfjs renders the rule above a denominator as a run of
// underscores, so this is the single most reliable signal that a line is an
// equation rather than prose.
const BAR_RE = /_{3,}/g;

// Operators and relations that essentially never appear in IES prose.
// Deliberately EXCLUDES the en dash (–) and hyphen: "LS-7-20, Vision – Eye and
// Brain" is a title, not an equation. U+2212 MINUS SIGN is included; it is what
// the equation fonts actually emit.
const MATH_RE = /[≡≤≥≠≈∝∞∫∑√±×÷⁄∂∆∏−]/g;

// Greek letters used as symbols (Φ, λ, τ, θ, α …). One on its own is not proof —
// "absorptance, α" is a definition — so this only ever counts toward a score.
const GREEK_RE = /[ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩαβγδεζηθικλμνξοπρστυφχψω]/g;

// Unicode super/subscripts, the other half of a symbol's notation.
const SUPERSUB_RE = /[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻ⁿ₀₁₂₃₄₅₆₇₈₉ₐₑₒₓ]/g;

// "X = …": an equals sign with something symbol-shaped in front of it. Prose
// uses "=" almost never; a ratio ("15:1") uses a colon.
const EQUATION_RE = /[A-Za-z0-9)\]ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩαβγδεζηθικλμνξοπρστυφχψω]\s*=(?!=)/g;

// A relation that STANDS IN for "=" in a definition ("τ(λ) ≡ Φ(λ)out"). Counted
// as an equation only alongside a Greek symbol, because IES prose uses these
// operators in ordinary sentences — "within ±10% of target", "ratios of ≥0.7" —
// and treating them as evidence on their own is what made this module mangle
// criteria (it deleted the operator and kept the number, changing the meaning).
const RELATION_RE = /[≡≤≥≠≈∝]/;

const count = (text, re) => (String(text || '').match(re) || []).length;

/**
 * The raw signals, exposed so tests (and a future tuning pass) can see WHY a
 * passage was judged one way or the other.
 */
export function formulaSignals(text) {
  const t = String(text || '');
  const letters = count(t, /[A-Za-z]/g);
  return {
    bars: count(t, BAR_RE),
    math: count(t, MATH_RE),
    greek: count(t, GREEK_RE),
    supersub: count(t, SUPERSUB_RE),
    equations: count(t, EQUATION_RE),
    length: t.length,
    letterRatio: t.length ? letters / t.length : 0,
  };
}

/**
 * Does this text contain a formula we must not display?
 *
 * Deliberately narrow, and it got narrower after review: an over-eager detector
 * is WORSE than none, because everything downstream then deletes symbols out of
 * ordinary prose. Two rejected temptations, both real IES sentences:
 *
 *   "Maintained values are within ±10% of target, and ratios of ≥0.7 apply."
 *   "The luminous flux Φ, the wavelength λ and the efficacy η are defined in LS-1."
 *
 * Counting operators or Greek letters as evidence flagged both, and the stripper
 * then removed the operator while keeping the number — turning a criterion into
 * a different criterion. So the ONLY evidence accepted is:
 *
 *   • a fraction bar (three or more underscores — pdfjs's rendering of the rule
 *     over a denominator, and nothing IES prose contains), or
 *   • an assignment: "X =" together with at least one symbol, which is what an
 *     equation is. "≡" counts as the assignment only beside a Greek symbol.
 */
export function hasFormula(text) {
  const s = formulaSignals(text);
  if (s.bars > 0) return true;
  const symbols = s.math + s.greek + s.supersub;
  const assigns = s.equations > 0 || (RELATION_RE.test(String(text || '')) && s.greek > 0);
  return assigns && symbols > 0;
}

/**
 * Is the text so dominated by the formula that nothing readable survives
 * redaction? Used to decide between "prose with the formula removed" and the
 * bare notice.
 */
export function isMostlyFormula(text) {
  if (!hasFormula(text)) return false;
  const s = formulaSignals(text);
  return s.letterRatio < 0.55 || s.bars >= 3;
}

/**
 * One line of an excerpt: is this line the formula itself, rather than prose
 * that happens to mention one?
 *
 * A formula line is short, symbol-dense and carries no sentence.
 */
export function isFormulaLine(line) {
  const t = String(line || '').trim();
  if (!t) return false;
  if (!hasFormula(t)) return false;
  const s = formulaSignals(t);
  const words = t.split(/\s+/).filter(Boolean);
  // A sentence of prose that cites a formula ("…can be determined from:") has
  // many words and few symbols.
  if (s.bars > 0 && words.length <= 14) return true;
  return words.length <= 12 || s.letterRatio < 0.5;
}

/** Is this token the ANCHOR of an equation — the thing that makes it one? */
function isEquationAnchor(token) {
  const t = String(token || '');
  if (!t) return false;
  if (/_{3,}/.test(t)) return true;
  if (/[A-Za-z0-9)\]ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩαβγδεζηθικλμνξοπρστυφχψω]\s*=(?!=)/.test(t) || t === '=') return true;
  return /[≡≈∝∫∑√∂∆∏]/.test(t);
}

/**
 * Is this token part of the equation AROUND an anchor, rather than a word of the
 * sentence the equation sits in?
 *
 * "A word" is the test, not "a symbol": an ordinary word — three or more letters
 * and nothing else — ends the run. That is what keeps "This formula, X = Y, is
 * used to approximate…" from losing "used to approximate", and what stopped this
 * function from eating "±", "≥" and Greek letters out of prose that has no
 * equation in it at all.
 */
function isEquationPart(token) {
  const t = String(token || '').trim();
  if (!t) return false;
  // A plain word (optionally closed by sentence punctuation) is prose. This is
  // what keeps "is used to approximate…" out of the run — an earlier version
  // treated every short token as symbolic and ate the "is".
  if (/^[A-Za-z][A-Za-z]{2,}[.,;:)]?$/.test(t)) return false;
  if (isEquationAnchor(t)) return true;
  // A lone capital is a variable ("N", "P"); a lone lowercase word is prose
  // ("a", "of", "in").
  if (/^[A-Z][.,;:)]?$/.test(t)) return true;
  if (/^[a-z]{1,2}[.,;:)]?$/.test(t)) return false;
  // Symbols, subscripted variables, operators and numbers: "Eavg,", "Φ(λ)out",
  // "·", "8)", "+64P".
  return /[^A-Za-z\s]/.test(t)
    || /[ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩαβγδεζηθικλμνξοπρστυφχψω]/.test(t);
}

/**
 * Strip the equation out of a line of prose, keeping the sentence.
 *
 * Anchored, not token-by-token: a token is removed only as part of a RUN that
 * contains an anchor (a fraction bar or an assignment). A line with no anchor is
 * returned untouched even when it carries operators or Greek letters — the
 * review case that mattered, because deleting "≥" from "ratios of ≥0.7" leaves a
 * different criterion behind rather than an obviously missing one.
 */
export function stripInlineFormula(line) {
  const raw = String(line || '');
  if (!hasFormula(raw)) return raw;

  const tokens = raw.split(/(\s+)/);   // keep the whitespace, so spacing survives
  const isSpace = (t) => /^\s+$/.test(t);
  const drop = new Array(tokens.length).fill(false);
  let removed = 0;

  for (let i = 0; i < tokens.length; i++) {
    if (isSpace(tokens[i]) || drop[i]) continue;
    if (!isEquationAnchor(tokens[i].replace(/^[(,;:]+/, '').replace(/[),;:]+$/, ''))) continue;

    // Expand the run left and right over the equation's own tokens. The token
    // either side of an "=" is taken whatever it looks like: it is the equation's
    // left- and right-hand side by definition, and a variable name reads as an
    // ordinary word ("Eavg = Q(N − 1) + P").
    let from = i;
    let to = i;
    let adjacent = tokens[i].includes('=');
    for (let j = i - 1; j >= 0; j--) {
      if (isSpace(tokens[j])) continue;
      if (!isEquationPart(tokens[j]) && !adjacent) break;
      adjacent = false;
      from = j;
    }
    adjacent = tokens[i].includes('=');
    for (let j = i + 1; j < tokens.length; j++) {
      if (isSpace(tokens[j])) continue;
      if (!isEquationPart(tokens[j]) && !adjacent) break;
      adjacent = false;
      to = j;
    }
    for (let j = from; j <= to; j++) {
      if (!drop[j] && !isSpace(tokens[j])) removed++;
      drop[j] = true;
    }
  }
  if (removed === 0) return raw;

  const out = tokens.filter((t, i) => !drop[i]);
  return out.join('')
    // ", , is used" → ", is used"; "formula, is used" → "formula is used"
    .replace(/\s*,(\s*,)+/g, ',')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/\(\s*\)/g, '')
    .replace(/,\s*(?=(?:is|are|was|were|can|may|shall|should|gives|yields)\b)/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,;:]+/, '')
    .trim();
}

/**
 * Remove every formula from a passage, line by line.
 *
 * @param {string} text
 * @returns {{ text: string, redacted: number, mostlyFormula: boolean }}
 *   `text` is the readable remainder (possibly empty); `redacted` counts how
 *   many lines or inline runs were removed; `mostlyFormula` says the caller
 *   should print the notice instead of the remainder.
 */
export function redactFormulas(text) {
  const raw = String(text || '');
  if (!raw.trim()) return { text: raw, redacted: 0, mostlyFormula: false };
  if (!hasFormula(raw)) return { text: raw, redacted: 0, mostlyFormula: false };

  let redacted = 0;
  const kept = [];
  for (const line of raw.split(/\n+/)) {
    if (!line.trim()) continue;
    if (isFormulaLine(line)) { redacted++; continue; }
    const stripped = stripInlineFormula(line);
    if (stripped !== line) redacted++;
    if (stripped.trim()) kept.push(stripped.trim());
  }

  const out = kept.join('\n');
  // Nothing but symbols was in there, or what is left is too short to read as a
  // sentence: the caller prints the notice.
  const mostlyFormula = redacted > 0 && (
    out.replace(/\s+/g, '').length < 40 || isMostlyFormula(out)
  );
  return { text: out, redacted, mostlyFormula };
}
