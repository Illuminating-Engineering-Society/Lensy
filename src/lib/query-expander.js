/**
 * IES Query Expander
 *
 * Two jobs:
 *   1. Clean natural language questions down to their core topic
 *   2. Expand the topic with IES-specific synonyms to improve vector recall
 *
 * Both steps run before the query is embedded, so the vector captures
 * a richer semantic neighborhood than the raw user input alone.
 *
 * Example pipeline:
 *   "how bright should a spa be?"
 *     → clean  → "spa"
 *     → expand → "spa wellness relaxation therapeutic treatment room"
 *     → embed  → finds: Spas, Massage Therapy, Wellness Centers, etc.
 */

// ─── Natural Language Question Patterns ──────────────────────────────────────
// Strips common question prefixes/suffixes, leaving just the space/topic.
// Ordered from most-specific to least-specific to avoid over-stripping.

const QUESTION_PATTERNS = [
  // "how bright should a conference room be?"
  /^how\s+(?:bright|much\s+light|many\s+(?:lux|footcandles?|fc))\s+(?:should|does?|is)\s+(?:a|an|the)?\s*/i,
  // "what lux/fc/illuminance for an office?"
  /^what\s+(?:are\s+the\s+)?(?:recommended\s+)?(?:lux|fc|footcandles?|illuminance|light\s+levels?|lighting)\s+(?:levels?\s+)?(?:for|in|at)\s+(?:a|an|the)?\s*/i,
  // "what lighting is recommended for a warehouse?"
  /^what\s+lighting\s+(?:is\s+)?(?:recommended|required|specified)\s+(?:for|in|at)\s+(?:a|an|the)?\s*/i,
  // "IES lighting recommendations/requirements/standards for X"
  /^(?:ies\s+)?lighting\s+(?:recommendations?|requirements?|standards?|levels?|design)\s+(?:for|in|at|of)\s+(?:a|an|the)?\s*/i,
  // "recommended illuminance for X" / "required lux for X"
  /^(?:recommended|required|suggested|typical)\s+(?:illuminance|lux|light\s+levels?)\s+(?:for|in|at)\s+(?:a|an|the)?\s*/i,
  // trailing noise
];

const TRAILING_NOISE = [
  /\s+lighting\s+(?:requirements?|recommendations?|standards?|levels?|design)\s*$/i,
  /\s+(?:illuminance|lux|fc|footcandle)\s+(?:levels?|requirements?|values?)\s*$/i,
  /\s+(?:requirements?|recommendations?)\s*$/i,
];

// ─── IES Synonym Dictionary ───────────────────────────────────────────────────
// Keys are lowercase terms to match in the query (substring match).
// Values are additional terms appended to the query string before embedding.
// Chosen to match vocabulary actually used in IES standard table hierarchies.

const SYNONYMS = {
  // ── Healthcare ──
  'spa':             'spa wellness relaxation therapeutic treatment massage',
  'massage':         'massage therapy treatment room spa wellness',
  'patient room':    'patient room hospital bedroom healthcare ward',
  'operating room':  'operating room surgery surgical suite OR sterile',
  'emergency room':  'emergency room ER emergency department trauma bay',
  'exam room':       'exam room examination clinical healthcare medical office',
  'waiting room':    'waiting room waiting area lobby reception lounge',
  'corridor':        'corridor hallway aisle passageway circulation path',

  // ── Office ──
  'open office':     'open office workstation cubicle workspace bullpen',
  'conference room': 'conference room meeting room boardroom collaboration',
  'private office':  'private office executive office enclosed workspace',
  'break room':      'break room lunchroom kitchen cafeteria lounge',
  'copy room':       'copy room mail room reprographics office support',
  'reception':       'reception lobby front desk welcome area entrance',

  // ── Education ──
  'classroom':       'classroom lecture hall school learning educational',
  'library':         'library reading room media center study',
  'gymnasium':       'gymnasium gym fitness sports recreation',

  // ── Retail ──
  'retail':          'retail store shop merchandise display sales floor',
  'fitting room':    'fitting room dressing room changing room',
  'display':         'display merchandise showcase accent retail',

  // ── Industrial / Warehouse ──
  'warehouse':       'warehouse storage distribution industrial facility',
  'loading dock':    'loading dock shipping receiving industrial',
  'assembly':        'assembly line manufacturing production industrial',

  // ── Parking ──
  'parking garage':  'parking garage covered parking structure ramp deck',
  'parking lot':     'parking lot surface parking uncovered outdoor',
  'parking':         'parking garage surface lot covered uncovered',

  // ── Outdoor / Pedestrian ──
  'walkway':         'walkway pedestrian path sidewalk footpath promenade',
  'outdoor dining':  'outdoor dining restaurant patio terrace alfresco',
  'plaza':           'plaza outdoor public space pedestrian gathering',
  'park':            'park recreation outdoor landscape pathway',
  'building entrance': 'building entrance entry vestibule canopy approach',

  // ── Sports ──
  'skating rink':    'skating rink ice rink hockey rink recreational',
  'basketball':      'basketball gymnasium court sports multipurpose',
  'tennis':          'tennis court racquet sports outdoor recreational',
  'football':        'football field athletic sports stadium turf',
  'baseball':        'baseball field softball diamond sports outdoor',
  'soccer':          'soccer field football pitch athletic outdoor',
  'swimming pool':   'swimming pool natatorium aquatic center indoor outdoor',

  // ── Hospitality ──
  'hotel lobby':     'hotel lobby hospitality guest reception entrance',
  'guest room':      'guest room hotel bedroom hospitality lodging',
  'restaurant':      'restaurant dining food service hospitality',
  'ballroom':        'ballroom banquet event hall function hospitality',

  // ── Residential ──
  'kitchen':         'kitchen residential cooking food prep domestic',
  'bathroom':        'bathroom restroom toilet lavatory residential',
  'living room':     'living room lounge residential common area',
  'bedroom':         'bedroom sleeping residential private',
  'garage':          'garage residential parking indoor vehicle storage',

  // ── Religious / Cultural ──
  'church':          'church sanctuary worship religious chapel',
  'museum':          'museum gallery exhibit cultural display',
  'theater':         'theater auditorium performance arts stage',
};

// ─── Multi-Query Detector ─────────────────────────────────────────────────────

/**
 * Detect if a query contains multiple space types (comma/semicolon separated).
 * Returns an array: single-element for normal queries, multiple for multi-queries.
 *
 * "office lobby, conference room, break room" → ["office lobby", "conference room", "break room"]
 * "spa lighting" → ["spa lighting"]
 */
export function splitMultiQuery(query) {
  const trimmed = query.trim();

  // Split on comma or semicolon, filter out empty segments
  const parts = trimmed
    .split(/[,;]/)
    .map(p => p.trim())
    .filter(p => p.length >= 2);

  // Only treat as multi-query if we got 2+ meaningful parts
  if (parts.length >= 2) return parts;
  return [trimmed];
}

// ─── Query Cleaning ───────────────────────────────────────────────────────────

/**
 * Strip natural language question phrasing to extract the core topic.
 * "how bright should a spa be?" → "spa"
 */
export function cleanQuery(query) {
  let q = query.trim();

  for (const pattern of QUESTION_PATTERNS) {
    q = q.replace(pattern, '');
    if (q !== query.trim()) break; // stop after first match
  }

  for (const pattern of TRAILING_NOISE) {
    q = q.replace(pattern, '');
  }

  // Strip leading articles left over
  q = q.replace(/^(a|an|the)\s+/i, '').trim();

  return q || query.trim(); // fallback to original if over-stripped
}

// ─── Query Expansion ──────────────────────────────────────────────────────────

/**
 * Expand a cleaned query with IES-specific synonyms.
 * Returns the expanded string for embedding.
 *
 * The original query terms always come first so their signal dominates.
 * Synonym terms are appended to widen the semantic neighbourhood.
 */
export function expandQuery(query) {
  const cleaned = cleanQuery(query);
  const lower = cleaned.toLowerCase();

  const expansions = new Set();

  for (const [term, synonymText] of Object.entries(SYNONYMS)) {
    // Match on whole-word boundary to avoid "spa" matching "space"
    const wordBoundaryRe = new RegExp(`(?:^|\\s)${escapeRegex(term)}(?:\\s|$)`, 'i');
    if (wordBoundaryRe.test(lower)) {
      for (const word of synonymText.split(/\s+/)) {
        expansions.add(word.toLowerCase());
      }
    }
  }

  if (expansions.size === 0) return cleaned;

  // Remove expansion terms that already appear in the query
  const queryWords = new Set(lower.split(/\s+/));
  const newTerms = [...expansions].filter(t => !queryWords.has(t));

  if (newTerms.length === 0) return cleaned;
  return `${cleaned} ${newTerms.join(' ')}`;
}

/**
 * Full pipeline: clean + expand.
 * Use this before embedding a user query.
 */
export function prepareQueryForEmbedding(query) {
  return expandQuery(cleanQuery(query));
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
