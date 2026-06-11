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
  /^how\s+(?:bright|much\s+light|many\s+(?:lux|footcandles?|fc))\s+(?:should|does?|is)\s+(?:(?:an|the|a)\s+)?/i,
  // "what lux/fc/illuminance for an office?"
  /^what\s+(?:are\s+the\s+)?(?:recommended\s+)?(?:lux|fc|footcandles?|illuminance|light\s+levels?|lighting)\s+(?:levels?\s+)?(?:for|in|at)\s+(?:(?:an|the|a)\s+)?/i,
  // "what lighting is recommended for a warehouse?"
  /^what\s+lighting\s+(?:is\s+)?(?:recommended|required|specified)\s+(?:for|in|at)\s+(?:(?:an|the|a)\s+)?/i,
  // "IES lighting recommendations/requirements/standards for X"
  /^(?:ies\s+)?lighting\s+(?:recommendations?|requirements?|standards?|levels?|design)\s+(?:for|in|at|of)\s+(?:(?:an|the|a)\s+)?/i,
  // "recommended illuminance for X" / "required lux for X"
  /^(?:recommended|required|suggested|typical)\s+(?:illuminance|lux|light\s+levels?)\s+(?:for|in|at)\s+(?:(?:an|the|a)\s+)?/i,
  // trailing noise
];

const TRAILING_NOISE = [
  /\s+lighting\s+(?:requirements?|recommendations?|standards?|levels?|design)\s*$/i,
  /\s+(?:illuminance|lux|fc|footcandle)\s+(?:levels?|requirements?|values?)\s*$/i,
  /\s+(?:requirements?|recommendations?)\s*$/i,
  // dangling copula left from "how bright should X be?" patterns
  /\s+be[\s?.!]*$/i,
  /[?!.]+\s*$/,
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

  // ── Outdoor / Pedestrian (RP-43-25 vocabulary) ──
  'walkway':         'walkway pedestrian path sidewalk footpath promenade common pedestrian',
  'outdoor dining':  'outdoor dining restaurant patio terrace alfresco features perimeters',
  'plaza':           'plaza outdoor public space pedestrian gathering features perimeters',
  'park':            'park recreation outdoor landscape pathway common pedestrian playground',
  'playground':      'playground play area common pedestrian recreation outdoor children',
  'pedestrian':      'pedestrian walkway footpath sidewalk common path special',
  'spectator':       'spectator seating viewing audience stadium arena venue',
  'amphitheater':    'amphitheater grass area outdoor seating performance venue',
  'cycling':         'cycling bicycle bike path mixed cycling pedestrian',
  'mixed-use path':  'mixed cycling pedestrian path bicycle multi-use',
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

  // ── IES Technical Terminology (per IlluminanceTables_Reference_260421) ──
  'veiling':         'veiling reflection contrast specular semi-specular glare task',
  'veiling reflection': 'veiling reflection specular contrast task surface',
  'class of play':   'class of play sports skill level competitive recreational broadcast',
  'uniformity':      'uniformity ratio max min avg coefficient variation distribution',
  'uniformity ratio': 'uniformity ratio UR max min illuminance distribution',
  'coefficient of variation': 'coefficient variation CV statistics standard deviation uniformity',
  'cv':              'coefficient variation CV uniformity standard deviation',
  'ratio basis':     'ratio basis max avg min uniformity calculation plane',
  'task surface':    'task surface TS height visual task work plane',
  'maintained illuminance': 'maintained illuminance target consensus light loss factor LLF',
  'mesopic':         'mesopic adaptation S/P ratio spectrum low light scotopic photopic',
  's/p ratio':       'S/P ratio spectrum mesopic TM-24 light source spectrum adjustment',
  'tm-24':           'TM-24 spectrum adjustment P-Y categories visually demanding tasks',
  'tm24':            'TM-24 spectrum adjustment P-Y categories visually demanding tasks',
  'light loss factor': 'light loss factor LLF dirt depreciation maintenance lumen depreciation RP-36',
  'illuminance category': 'illuminance category A through Y RP-10 Table A-2 letter code',
  'category':        'illuminance category letter code A B C D E F G H I J K L M N O P Q R S T U V W X Y',
  'rp-10':           'RP-10 illuminance categories Table A-2 common applications',
  'lighting zone':   'lighting zone LZ0 LZ1 LZ2 LZ3 LZ4 outdoor environmental ambient',
  'lz0':             'LZ0 lighting zone no ambient lighting natural darkness',
  'lz1':             'LZ1 lighting zone low ambient rural residential',
  'lz2':             'LZ2 lighting zone moderate ambient suburban',
  'lz3':             'LZ3 lighting zone moderately high ambient urban commercial',
  'lz4':             'LZ4 lighting zone high ambient downtown entertainment',
  'glare rating':    'glare rating BUG backlight uplight outdoor luminaire',
  'uplight':         'uplight skyglow light pollution outdoor BUG',
  'spectrum':        'spectrum CCT color temperature S/P ratio circadian',
  'controls':        'controls dimming occupancy daylight tuning curfew',
  'curfew':          'curfew dimming nighttime outdoor lighting reduction',
  'annex a':         'Annex A general notes governing criteria maintained illuminance',
  'general notes':   'general notes governing criteria tolerance age adjustment',
  'task':            'task visual task work plane localized task lighting',
  'area':            'area room space general lighting whole space',
  'older adults':    'older adults seniors over 65 visually impaired RP-28 illuminance double',
  'seniors':         'seniors older adults over 65 RP-28 illuminance recommendations doubled',
  'security lighting': 'security lighting G-1 minimum maintained safety vehicular',
  'tolerance':       'tolerance ±10 percent acceptable design predicted value',
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

// ─── Version-Comparison Intent Detection ──────────────────────────────────────

const VERSION_COMPARE_PATTERNS = [
  /\bwhat(?:'s|\s+is|\s+has)?\s+new\b/i,
  /\bwhat\s+(?:has\s+)?changed\b/i,
  /\bwhat(?:'s|\s+is)?\s+different\b/i,
  /\bdifference[s]?\s+between\b/i,
  /\bcompared?\s+(?:to|with|against)\b/i,
  /\b(?:added|revised|removed)\s+in\b/i,
  /\bversion\s+comparison\b/i,
  /\bupdated?\s+(?:from|since)\b/i,
];

/**
 * Detect if a user query is asking for a "what's new" / version comparison.
 * The search layer can use this to:
 *  - allow indexing of deprecated standards into the result set
 *  - present ADDED/REVISED automatically and gate REMOVED behind opt-in
 *
 * @returns {boolean}
 */
export function isVersionComparisonQuery(query) {
  if (!query) return false;
  return VERSION_COMPARE_PATTERNS.some(re => re.test(query));
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
