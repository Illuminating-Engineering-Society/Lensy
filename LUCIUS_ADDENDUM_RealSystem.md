# Lucius Addendum: Integration with Current IDT System

## Executive Summary

After reviewing the **actual current Illuminance Selector** (idt.ies.org), the Lucius vision needs to be refined. The current system is already sophisticated with:
- 134 applications in a 68-column structured database
- Hierarchical category navigation
- Complete illuminance data (Horizontal, Vertical, Task metrics)
- Standard references and deep linking
- "My Projects" feature for saving lighting schedules
- Save/Print/Export functionality

**Lucius doesn't replace this system—it enhances it** by adding:
1. Natural language search as an alternative to category browsing
2. Contextual information from full PDF standards
3. Optional AI-generated explanations
4. Multi-application queries
5. Conversational interface for casual users who don't know the taxonomy

---

## Current System Analysis

### Interface Flow (As-Is)

**Method 1: Category Browsing**
```
Landing Page
    ↓
Select Category: "Healthcare"
    ↓
Expand Subcategory: "Hospitals and Ambulatory Care"
    ↓
Apply Filters: Healthcare Type, Indoor/Outdoor
    ↓
Select Application: "Spa"
    ↓
Click "SEARCH"
    ↓
View Illuminance Table
    ↓
[SAVE SEARCH] [PRINT TO PDF]
```

**Current UX:**
- Requires knowledge of IES taxonomy
- Works great for experienced professionals
- Difficult for newcomers ("Is a hotel spa under Healthcare or Hospitality?")
- Must know which standard to look in

### Database Schema (68 Columns)

**Application Hierarchy (6 levels deep):**
- `App`: Top-level (e.g., "Administration", "Healthcare", "Sports")
- `App_s1`: Sub-1 (e.g., "Copy rooms, print rooms")
- `App_s2`: Sub-2 (e.g., "General")
- `App_s3` through `App_s6`: Further specificity

**Illuminance Data (3 measurement types × ~8 fields each):**

1. **Horizontal Illuminance:**
   - `Hor_Cat`: Category (L, M, N, P, Q, R, etc.)
   - `Hor_Lux`: Lux value
   - `Hor_meters`: Height above floor
   - `Hor_Fc`: Footcandles
   - `Hor_ft`: Height in feet
   - `Hor_MxAvMn`: Max/Avg/Min designation
   - `Hor_CV`: Coefficient of variation
   - `Hor_U_Ratio`: Uniformity ratio (e.g., "3|1")
   - `Hor_U_RatBas`: Uniformity ratio basis (e.g., "Avg:Min")

2. **Vertical Illuminance:** (same structure as Horizontal)
   - `Ver_Cat`, `Ver_Lux`, `Ver_meters`, etc.

3. **Task Illuminance:** (same structure)
   - `Tsk_Cat`, `Tsk_Lux`, `Tsk_meters`, etc.

**Outdoor Lighting Guidance:**
- `Max_Glare`: BUG rating (G0-G5)
- `Max_Uplight`: BUG rating (U0-U5)
- `Light_Red_Curfn`: Curfew dimming percentage
- `Sht_Wav`: Short wavelength content (CCT guidance)
- `LZ`: Lighting Zone (LZ0-LZ4)

**Standard References:**
- `Standard Full`: e.g., "ANSI/IES RP-9-20"
- `Standard Code`: e.g., "RP-9"
- `Standard Tab`: e.g., "RP-9_A-1"
- `Row`: Row number in table
- `Application Code`: Unique ID (e.g., "RP-9_A-1_45")

**Links & Context:**
- `Link Type`: C (Chapter), T (Table), etc.
- `Link Text`: Display text
- `Link Mapping`: Deep link reference (e.g., "ANSI/IES RP-9-20_3.5")
- `Link URL`: External URL
- `Link File`: Attached file reference
- `App_Note_1` through `App_Note_4`: Footnote references

**Metadata:**
- `Task_or_Area`: T (Task) or A (Area)
- `Veil_Risk`: H (High), L (Low) - reflective veil risk
- `Class_Play`: Class of play (for sports)
- `Indoor/Outdoor?`: I or O
- `Is TM24?`: Boolean - TM-24 spectral adjustment eligible
- `Status`: Active/Deprecated

**Sample Application (Spa from Healthcare):**
```json
{
  "App": "Healthcare",
  "App_s1": "Hospitals and Ambulatory Care",
  "App_s2": "Spas",
  "Standard Full": "ANSI/IES RP-9-20",
  "Standard Tab": "RP-9_A-1",
  "Row": 45,
  "Application Code": "RP-9_A-1_45",
  "Indoor/Outdoor?": "I",
  "Task_or_Area": "A",
  "Hor_Cat": "L",
  "Hor_Lux": 75,
  "Hor_Fc": 7.5,
  "Hor_meters": 0,
  "Hor_MxAvMn": "Avg",
  "Hor_U_Ratio": "4|1",
  "Hor_U_RatBas": "Avg:Min",
  "Ver_Cat": "K",
  "Ver_Lux": 50,
  "Ver_Fc": 5,
  "Ver_meters": 1.52,
  "Ver_ft": 5,
  "Ver_U_Ratio": "6|1",
  "Ver_U_RatBas": "Avg:Min",
  "Link Mapping": "ANSI/IES RP-9-20_3.5"
}
```

---

## Lucius Enhancement Strategy

### Hybrid Interface: Search + Browse

**Option 1: Natural Language Search (New)**
```
User: "spa lighting requirements"
    ↓
Lucius: Semantic search across all applications
    ↓
Results: 
  - Healthcare: Spas (RP-9-20)
  - Hospitality: Hotel spas (RP-9-23)
  - Residential: Home spas (RP-3-20)
    ↓
Display: Full illuminance table + PDF context + AI explanation
```

**Option 2: Traditional Category Browse (Existing)**
```
User clicks: Healthcare → Hospitals → Spas
    ↓
Lucius: Shows same result as search
    ↓
Display: Full illuminance table + PDF context + AI explanation
```

**Key insight:** Both paths lead to the **same enhanced result page**. The difference is how you get there.

### Data Architecture

**Layer 1: Existing Structured Database (Primary Source)**
- 134 applications × 68 columns
- Already in SQL database (migrate to Cloudflare D1)
- This is the **authoritative source** for illuminance values
- No changes needed to this data

**Layer 2: Vector Search Index (New - For Discovery)**
- Generate embeddings for each application
- Searchable fields: `App + App_s1 + App_s2 + Category + Sub Category + App_Note_*`
- Example embedding text for "Spa" application:
  ```
  Healthcare Hospitals and Ambulatory Care Spas
  Area lighting for therapeutic and wellness facilities
  Relaxation environment with lower illuminance
  Source: ANSI/IES RP-9-20 Table A-1
  ```
- Enables semantic matching: "hotel wellness center" → finds "Spas"

**Layer 3: PDF Full-Text (New - For Context)**
- Index full text from standards PDFs
- Chunk by section (not by page)
- Link chunks to applications via `Link Mapping` field
- Example: RP-9-20 Section 3.5 explains *why* spas have lower light levels

**Layer 4: AI Summaries (New - For Explanation)**
- Generated on-demand (not stored)
- Input: Application data + PDF context + user query
- Output: Plain-language explanation
- Example: "Spa lighting prioritizes relaxation over task performance..."

### Enhanced Search Flow

**User Query:** "How bright should a spa be?"

**Backend Process:**
1. **Semantic Search** (Vectorize)
   - Generate embedding for "how bright should a spa be"
   - Find top 5 matching applications
   - Result: "Healthcare: Spas" scores highest

2. **Data Retrieval** (D1 Database)
   - Fetch full application record (all 68 columns)
   - Application Code: RP-9_A-1_45

3. **Context Retrieval** (PDF chunks via R2/Vectorize)
   - Use `Link Mapping`: "ANSI/IES RP-9-20_3.5"
   - Fetch Section 3.5 text from RP-9-20
   - Get surrounding context (intro, scope, footnotes)

4. **Related Applications** (Vectorize)
   - Find similar: "Hotel spas", "Home spas", "Patient rooms"
   - Based on vector similarity to original query

5. **Optional AI Summary** (Claude API)
   - Input: Application data + Section 3.5 text + Query
   - Generate: 2-3 paragraph explanation
   - Validate: Check copyright rules (<15 words per quote)

6. **Format Response:**
   ```json
   {
     "primary_result": {
       "application": "Healthcare: Hospitals and Ambulatory Care → Spas",
       "standard": "ANSI/IES RP-9-20",
       "illuminance": {
         "horizontal": {
           "category": "L",
           "lux": 75,
           "fc": 7.5,
           "height": "0 meters (floor level)",
           "uniformity": "4:1 (Avg:Min)"
         },
         "vertical": {
           "category": "K",
           "lux": 50,
           "fc": 5,
           "height": "1.52 m (5 ft)",
           "uniformity": "6:1 (Avg:Min)"
         }
       },
       "context": {
         "section": "3.5 Wellness and Spa Facilities",
         "excerpt": "Spa environments emphasize relaxation...",
         "vitrium_link": "https://vitrium.ies.org/RP-9-20#section=3.5"
       },
       "ai_summary": {
         "text": "Spa lighting is intentionally...",
         "disclaimer": "AI-generated...",
         "watermark": "IES Lucius..."
       }
     },
     "related_applications": [
       { "app": "Hospitality: Hotel spas", "standard": "RP-9-23" },
       { "app": "Healthcare: Patient rooms", "standard": "RP-9-20" }
     ],
     "actions": {
       "save_to_project": true,
       "export_pdf": true,
       "view_in_vitrium": "https://vitrium.ies.org/RP-9-20"
     }
   }
   ```

---

## Integration with "My Projects"

The current system has a **"My Projects"** feature where users can save lighting schedules. Lucius enhances this:

### Current "My Projects" (idt.ies.org/members/my-projects)
- Users manually create projects
- Add project details (name, type, client, location)
- Presumably can add lighting applications

### Lucius Enhancement: Save from Search

**New Workflow:**
```
User searches: "office building lighting"
    ↓
Lucius shows: Multiple applications
  - Office entrance
  - Office lobby
  - Office hallways
  - Office meeting rooms
  - Office restrooms
    ↓
User selects: [✓] All of the above
    ↓
Clicks: "Save to My Project"
    ↓
Modal: 
  - Create new project: "123 Main St Office Building"
  - OR add to existing project: [Dropdown of user's projects]
    ↓
Saved:
  - All selected applications with full data
  - Standard references
  - Links to Vitrium
  - User can add notes/modifications
```

### Project Export Enhancement

**Current:** "SAVE SEARCH" and "PRINT TO PDF" buttons

**Enhanced:**
- **Export to Excel:** All applications in project with full 68-column data
- **Export to PDF:** Formatted lighting schedule with:
  - Project header (name, location, designer)
  - Table of applications with illuminance values
  - Standard references
  - General notes
  - Designer signatures/approvals
- **Share Project:** Generate shareable link for team collaboration

---

## Technical Implementation Updates

### Database Migration

**Step 1: Import Current IDT Database**
```sql
-- Cloudflare D1 Schema
CREATE TABLE applications (
  id INTEGER PRIMARY KEY,
  app TEXT NOT NULL,
  app_s1 TEXT,
  app_s2 TEXT,
  app_s3 TEXT,
  app_s4 TEXT,
  app_s5 TEXT,
  app_s6 TEXT,
  category TEXT NOT NULL,
  sub_category TEXT,
  standard_full TEXT NOT NULL,
  standard_code TEXT NOT NULL,
  standard_tab TEXT,
  row_number INTEGER,
  application_code TEXT UNIQUE NOT NULL,
  indoor_outdoor TEXT,
  is_tm24 BOOLEAN,
  status TEXT DEFAULT 'Active',
  
  -- Links
  link_type TEXT,
  link_text TEXT,
  link_mapping TEXT,
  link_url TEXT,
  link_file TEXT,
  
  -- Application notes
  app_note_1 TEXT,
  app_note_2 TEXT,
  app_note_3 TEXT,
  app_note_4 TEXT,
  
  -- Task/Area classification
  task_or_area TEXT,
  veil_risk TEXT,
  class_play TEXT,
  
  -- Horizontal illuminance
  hor_cat TEXT,
  hor_lux REAL,
  hor_meters REAL,
  hor_fc REAL,
  hor_ft REAL,
  hor_mx_av_mn TEXT,
  hor_cv REAL,
  hor_u_ratio TEXT,
  hor_u_rat_bas TEXT,
  
  -- Vertical illuminance
  ver_cat TEXT,
  ver_lux REAL,
  ver_meters REAL,
  ver_fc REAL,
  ver_ft REAL,
  ver_mx_av_mn TEXT,
  ver_cv REAL,
  ver_u_ratio TEXT,
  ver_u_rat_bas TEXT,
  
  -- Task illuminance
  tsk_cat TEXT,
  tsk_lux REAL,
  tsk_meters REAL,
  tsk_fc REAL,
  tsk_ft REAL,
  tsk_mx_av_mn TEXT,
  
  -- Outdoor lighting
  max_glare TEXT,
  max_uplight TEXT,
  light_red_curfn TEXT,
  sht_wav TEXT,
  lz TEXT,
  glare_max TEXT,
  uplight_max TEXT,
  controls TEXT,
  spectrum TEXT,
  
  -- Timestamps
  created_at TIMESTAMP,
  modified_at TIMESTAMP
);

-- Index for common queries
CREATE INDEX idx_app_hierarchy ON applications(app, app_s1, app_s2);
CREATE INDEX idx_standard ON applications(standard_code);
CREATE INDEX idx_category ON applications(category, sub_category);
CREATE INDEX idx_application_code ON applications(application_code);
```

**Step 2: Generate Vector Embeddings**
```javascript
// For each application row
const embeddingText = buildEmbeddingText(application);

async function buildEmbeddingText(app) {
  // Combine hierarchical app name
  const hierarchy = [
    app.app,
    app.app_s1,
    app.app_s2,
    app.app_s3,
    app.app_s4,
    app.app_s5,
    app.app_s6
  ].filter(Boolean).join(' ');
  
  // Add category context
  const category = `${app.category} ${app.sub_category || ''}`;
  
  // Add application notes
  const notes = [
    app.app_note_1,
    app.app_note_2,
    app.app_note_3,
    app.app_note_4
  ].filter(Boolean).join(' ');
  
  // Build searchable text
  return `
    ${hierarchy}
    Category: ${category}
    ${app.indoor_outdoor === 'I' ? 'Indoor' : 'Outdoor'} application
    ${notes}
    Source: ${app.standard_full} ${app.standard_tab || ''}
    ${app.task_or_area === 'T' ? 'Task lighting' : 'Area lighting'}
  `.trim();
}

// Generate embedding
const embedding = await env.AI.run('@cf/baai/bge-base-en-v1.5', {
  text: [embeddingText]
});

// Store in Vectorize
await env.VECTORIZE.upsert([{
  id: app.application_code,
  values: embedding.data[0],
  metadata: {
    application_code: app.application_code,
    standard_code: app.standard_code,
    category: app.category,
    indoor_outdoor: app.indoor_outdoor
  }
}]);
```

### Enhanced Search API

```javascript
export default {
  async fetch(request, env) {
    const { query, filters = {} } = await request.json();
    
    // 1. Generate query embedding
    const queryEmbedding = await env.AI.run('@cf/baai/bge-base-en-v1.5', {
      text: [query]
    });
    
    // 2. Vector search
    let vectorResults = await env.VECTORIZE.query(queryEmbedding.data[0], {
      topK: 10,
      returnMetadata: true,
      filter: filters.indoor_outdoor ? {
        indoor_outdoor: filters.indoor_outdoor
      } : undefined
    });
    
    // 3. Fetch full application data from D1
    const applicationCodes = vectorResults.matches.map(m => m.id);
    const applications = await env.DB.prepare(`
      SELECT * FROM applications 
      WHERE application_code IN (${applicationCodes.map(() => '?').join(',')})
      AND status = 'Active'
    `).bind(...applicationCodes).all();
    
    // 4. For each application, fetch PDF context if Link Mapping exists
    const enrichedResults = await Promise.all(
      applications.results.map(async (app) => {
        let context = null;
        
        if (app.link_mapping) {
          // Fetch relevant section from PDF
          context = await fetchPDFContext(env, app.link_mapping);
        }
        
        return {
          application: formatApplicationHierarchy(app),
          standard: {
            full: app.standard_full,
            code: app.standard_code,
            tab: app.standard_tab
          },
          illuminance: {
            horizontal: app.hor_lux ? {
              category: app.hor_cat,
              lux: app.hor_lux,
              fc: app.hor_fc,
              height: `${app.hor_meters} m (${app.hor_ft} ft)`,
              uniformity: app.hor_u_ratio,
              uniformityBasis: app.hor_u_rat_bas,
              maxAvgMin: app.hor_mx_av_mn
            } : null,
            vertical: app.ver_lux ? {
              category: app.ver_cat,
              lux: app.ver_lux,
              fc: app.ver_fc,
              height: `${app.ver_meters} m (${app.ver_ft} ft)`,
              uniformity: app.ver_u_ratio,
              uniformityBasis: app.ver_u_rat_bas,
              maxAvgMin: app.ver_mx_av_mn
            } : null,
            task: app.tsk_lux ? {
              category: app.tsk_cat,
              lux: app.tsk_lux,
              fc: app.tsk_fc,
              height: app.tsk_meters === 'TS' ? 'Task Surface' : `${app.tsk_meters} m`,
              maxAvgMin: app.tsk_mx_av_mn
            } : null
          },
          outdoor: app.max_glare ? {
            maxGlare: app.max_glare,
            maxUplight: app.max_uplight,
            curfewDimming: app.light_red_curfn,
            spectrum: app.sht_wav,
            lightingZone: app.lz
          } : null,
          context: context,
          notes: [
            app.app_note_1,
            app.app_note_2,
            app.app_note_3,
            app.app_note_4
          ].filter(Boolean),
          vitriumLink: buildVitriumLink(app),
          relevanceScore: vectorResults.matches.find(m => m.id === app.application_code)?.score
        };
      })
    );
    
    // 5. Optional: Generate AI summary
    let aiSummary = null;
    if (filters.includeAISummary) {
      aiSummary = await generateAISummary(env, query, enrichedResults);
    }
    
    return Response.json({
      query,
      results: enrichedResults,
      aiSummary,
      count: enrichedResults.length
    });
  }
};

function formatApplicationHierarchy(app) {
  return [
    app.app,
    app.app_s1,
    app.app_s2,
    app.app_s3,
    app.app_s4,
    app.app_s5,
    app.app_s6
  ].filter(Boolean).join(' → ');
}

function buildVitriumLink(app) {
  // Use Link Mapping to construct deep link
  if (app.link_mapping) {
    const [standard, section] = app.link_mapping.split('_');
    return `https://vitrium.ies.org/document/${standard}#section=${section}`;
  }
  return `https://vitrium.ies.org/document/${app.standard_code}`;
}

async function fetchPDFContext(env, linkMapping) {
  // Query Vectorize for PDF chunks matching this section
  const [standard, section] = linkMapping.split('_');
  
  const chunks = await env.VECTORIZE.query(
    // Dummy embedding - we're filtering by metadata, not similarity
    new Array(768).fill(0),
    {
      topK: 3,
      filter: {
        standard_code: standard,
        section: section
      }
    }
  );
  
  return chunks.matches.map(m => m.metadata.text).join('\n\n');
}
```

---

## UI Wireframes: Real System Integration

### Landing Page (Hybrid Approach)

```
┌────────────────────────────────────────────────────────────────┐
│  🔦 Lucius - IES Standards Search                              │
│  Powered by the IES Illuminance Selector                       │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │ Ask a question or search for an application...          │ │
│  │                                                           │ │
│  │ Examples:                                                 │ │
│  │ • "spa lighting requirements"                            │ │
│  │ • "office kitchen hallway meeting room restroom"         │ │
│  │ • "what changed in RP-9?"                                │ │
│  └──────────────────────────────────────────────────────────┘ │
│                     [Search Standards]                         │
│                                                                 │
│  ─────────────────── OR ──────────────────────                │
│                                                                 │
│  Browse by Category:                                           │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │ ▼ COMMERCIAL, RESIDENTIAL, INDUSTRIAL                    │ │
│  │   • Common Applications                                   │ │
│  │   • Educational Facilities                                │ │
│  │   • Healthcare                                            │ │
│  │   • Hospitality                                           │ │
│  │   • [12 more...]                                          │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │ ▼ LIGHTING FOR PEDESTRIANS IN OUTDOOR SPACES            │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │ ▼ SPORTS AND RECREATIONAL AREAS                          │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                                 │
│  [View All Categories]                                         │
│                                                                 │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                                 │
│  📁 My Projects (3)                                            │
│  • 123 Main St Office Building (12 applications)               │
│  • Warehouse Renovation (8 applications)                       │
│  • Healthcare Facility Upgrade (15 applications)               │
│  [View All Projects]                                           │
└────────────────────────────────────────────────────────────────┘
```

### Search Results Page (Enhanced from Current)

**Query:** "spa lighting"

```
┌────────────────────────────────────────────────────────────────────┐
│ ← Back to Search                      [Export PDF] [Add to Project]│
│                                                                     │
│ Search: "spa lighting"                                             │
│ Found 3 applications in 2 standards                                │
│                                                                     │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│                                                                     │
│ 📊 PRIMARY RESULT                                                  │
│                                                                     │
│ Healthcare → Hospitals and Ambulatory Care → Spas                  │
│ Source: ANSI/IES RP-9-20, Table A-1, Row 45                       │
│                                                                     │
│ ┌─────────────────────────────────────────────────────────────┐   │
│ │                    ILLUMINANCE VALUES                        │   │
│ │                                                              │   │
│ │ Task/Area: A (Area lighting)                                 │   │
│ │ Indoor application                                           │   │
│ │                                                              │   │
│ │ HORIZONTAL ILLUMINANCE:                                      │   │
│ │ ┌─────────────────────────────────────────────────────┐     │   │
│ │ │ Category:    L                                      │     │   │
│ │ │ Maintained:  75 lux (7.5 fc)                        │     │   │
│ │ │ Height:      0 meters (floor level)                 │     │   │
│ │ │ Type:        Average                                │     │   │
│ │ │ Uniformity:  4:1 (Avg:Min)                          │     │   │
│ │ └─────────────────────────────────────────────────────┘     │   │
│ │                                                              │   │
│ │ VERTICAL ILLUMINANCE:                                        │   │
│ │ ┌─────────────────────────────────────────────────────┐     │   │
│ │ │ Category:    K                                      │     │   │
│ │ │ Maintained:  50 lux (5 fc)                          │     │   │
│ │ │ Height:      1.52 m (5 ft)                          │     │   │
│ │ │ Type:        Average                                │     │   │
│ │ │ Uniformity:  6:1 (Avg:Min)                          │     │   │
│ │ └─────────────────────────────────────────────────────┘     │   │
│ └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│ ┌─────────────────────────────────────────────────────────────┐   │
│ │ 📖 STANDARD CONTEXT                                          │   │
│ │                                                              │   │
│ │ From ANSI/IES RP-9-20, Section 3.5:                         │   │
│ │                                                              │   │
│ │ "Spa and wellness facilities emphasize relaxation and        │   │
│ │ comfort. Lower illuminance levels are appropriate to create  │   │
│ │ a calming atmosphere while maintaining safe navigation.      │   │
│ │ Consider:                                                    │   │
│ │ • Dimming controls for adjustable ambiance                   │   │
│ │ • Warm color temperatures (2700-3000K)                       │   │
│ │ • Glare control for reclining positions                      │   │
│ │ • Wet location ratings for all fixtures"                     │   │
│ │                                                              │   │
│ │ [View Full Section 3.5 in Vitrium →]                        │   │
│ └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│ ┌─────────────────────────────────────────────────────────────┐   │
│ │ 💡 AI EXPLANATION (Optional - Click to view)                │   │
│ │                                                              │   │
│ │ [Collapsed by default - user must click to expand]          │   │
│ │                                                              │   │
│ │ Why these light levels?                                      │   │
│ │ Spa lighting serves therapeutic and wellness goals rather    │   │
│ │ than task performance. According to ANSI/IES RP-9-20...      │   │
│ │ [2-3 paragraphs of AI-generated context]                     │   │
│ │                                                              │   │
│ │ Disclaimer: AI-generated summary for informational purposes  │   │
│ │ only. Always refer to full IES Standards.                    │   │
│ └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│ [✓ Add to My Project] [Save as PDF] [View in Vitrium]             │
│                                                                     │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│                                                                     │
│ 📋 RELATED APPLICATIONS                                            │
│                                                                     │
│ ┌───────────────────────────────────────────────────────────┐     │
│ │ Hospitality → Hotel Facilities → Spas                     │     │
│ │ ANSI/IES RP-9-23                                           │     │
│ │ Similar to healthcare spas, with additional emphasis on... │     │
│ │ [Expand ▼]                                                 │     │
│ └───────────────────────────────────────────────────────────┘     │
│                                                                     │
│ ┌───────────────────────────────────────────────────────────┐     │
│ │ Residential → Bathrooms → Home Spas                        │     │
│ │ ANSI/IES RP-3-20                                           │     │
│ │ [Expand ▼]                                                 │     │
│ └───────────────────────────────────────────────────────────┘     │
│                                                                     │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│                                                                     │
│ 📘 SOURCE STANDARD                                                 │
│                                                                     │
│ ANSI/IES RP-9-20: Lighting Healthcare Facilities                   │
│ Published: 2020 | Pages: 156                                       │
│ Authored by: IES Healthcare Facilities Committee                   │
│                                                                     │
│ [Subscribe to Library] [7-day Loan] [Purchase 5-yr PDF]           │
│ [Preview Document (free)]                                          │
└────────────────────────────────────────────────────────────────────┘
```

### Key Differences from Current System:

**Current System Shows:**
- Illuminance table only
- General Notes (footnotes)
- Link to standard

**Lucius Shows:**
- ✅ Illuminance table (same as current)
- ✅ General Notes (same as current)
- ✅ Link to standard (enhanced with deep linking)
- 🆕 **Standard context** (excerpt from PDF explaining *why*)
- 🆕 **AI explanation** (optional, plain-language summary)
- 🆕 **Related applications** (discover similar applications)
- 🆕 **Multiple access options** (Subscribe/Loan/Purchase)
- 🆕 **Save to My Project** (one-click add to project)

---

## Migration Path

### Phase 1: Data Migration (Week 1-2)
1. Export current IDT database (134 applications × 68 columns)
2. Import into Cloudflare D1
3. Generate vector embeddings for all applications
4. Store in Vectorize
5. Validate: All applications searchable

### Phase 2: Enhanced Search (Week 3-4)
1. Build natural language search API
2. Implement hybrid search (vector + keyword + filters)
3. Create results formatting logic
4. Test with sample queries
5. Validate: Search returns correct applications

### Phase 3: PDF Context Integration (Week 5-6)
1. Index IES standard PDFs (start with RP-9, RP-10, RP-1)
2. Link PDF chunks to applications via `Link Mapping`
3. Fetch context sections for each result
4. Test deep linking to Vitrium
5. Validate: Context shows relevant standard text

### Phase 4: UI Development (Week 7-8)
1. Build search interface (hybrid: search + browse)
2. Create enhanced results page
3. Implement "Add to My Project" functionality
4. Build export (PDF, Excel) features
5. Validate: Full user flow works end-to-end

### Phase 5: AI Summaries (Week 9-10)
1. Integrate Claude API
2. Build summary generation logic
3. Implement copyright validation
4. Add opt-in UI for AI summaries
5. Validate: Summaries accurate and compliant

### Phase 6: Testing & Launch (Week 11-12)
1. Beta test with IES members
2. Collect feedback and iterate
3. Performance optimization
4. Documentation and training
5. Public launch

---

## Success Metrics (Updated for Hybrid System)

### Adoption Metrics
- **Search vs. Browse ratio:** How many users choose search vs. category navigation?
- **Search success rate:** % of searches that result in "Add to Project" or "View in Vitrium"
- **Multi-application queries:** How often do users search for multiple applications at once?

### Engagement Metrics
- **Time to find application:** Compare search time vs. category browse time
- **Context view rate:** % of users who expand "Standard Context" or "AI Explanation"
- **Vitrium click-through:** % of results that lead to Vitrium document views

### Business Metrics
- **Subscription conversions:** Search → Subscribe rate
- **My Projects usage:** Increase in projects created and applications saved
- **Standard purchases:** Search → Purchase rate for non-subscribers

### Quality Metrics
- **Search relevance:** Manual audit of top 10 results for common queries
- **Citation accuracy:** % of AI summaries with proper citations
- **Copyright compliance:** Zero violations of 15-word quote limit

---

## Conclusion

Lucius is **not a replacement** for the current Illuminance Selector—it's an **enhancement layer** that makes the existing database more accessible through:

1. **Natural language search** for users who don't know the taxonomy
2. **Contextual information** from full PDF standards
3. **AI-generated explanations** for users who want plain-language summaries
4. **Multi-application queries** for project-based workflows
5. **Seamless integration** with "My Projects" for building lighting schedules

The existing 68-column database is **excellent** and should be preserved exactly as-is. Lucius simply adds new ways to discover and understand that data while maintaining the structured, authoritative nature that IES members expect.
