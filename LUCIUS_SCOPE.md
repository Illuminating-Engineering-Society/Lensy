# Lensy: IES AI-Powered Standards Assistant
## Project Scope Document

### Executive Summary
Lensy transforms the IES Illuminance Selector from a static lookup tool into an intelligent, conversational assistant that helps members explore, understand, and apply IES standards through natural language interaction.

---

## Core Vision

**FROM:** Static illuminance table lookup tool  
**TO:** Intelligent conversational assistant for IES standards exploration

**Name Origin:** Derived from Latin word for "light," representing both illumination science foundation and modern, intuitive access to IES knowledge

---

## Architecture Overview

### Three-Tier System

1. **AI Search Layer ("Lensy" / IES StandardSearch)**
   - Vector database indexing IES master PDFs from SharePoint
   - Natural language query processing
   - Context-aware response generation
   - Independent of Vitrium (direct PDF indexing)

2. **Vitrium Integration Layer**
   - DRM-protected document delivery
   - SSO via External Service API
   - Deep-linked web viewer (`#page=N`, `#bookmark=name`)
   - User annotation export (.xfdf)
   - **Scope:** Delivery infrastructure only, NOT product feature builder

3. **External API Licensing Layer** (Future)
   - Scoped to IES AI layer only
   - Third-party partner access (e.g., LightStanza)
   - Never exposes Vitrium internals or Wicket member data
   - Excludes deprecated standards from external access

---

## Priority 1 Features (Required for Release)

### 1. AI Agent Core Instructions
**Key Requirements:**
- Professional, neutral, academic tone
- Strict scope boundaries (no legal/safety/financial/contractual advice)
- Always cite IES Standards with full designation, section, and page
- Direct users to specific sections, page numbers, figures, tables, appendices
- Never reproduce copyrighted material verbatim
- Never provide quantitative data except via direct quote or screenshot
- Refer to deprecated standards as "deprecated" only
- Handle "what's new/changed" queries by comparing versions

**Critical Prohibitions (from guidelines):**
- No design calculations, compliance determinations, or engineering judgments
- No health/safety guidance
- No inferring/fabricating content from unreferenced standards
- No reproducing song lyrics, poems, or substantial passages
- When uncertain → direct to Standards@ies.org

### 2. Content Indexing (Priority 1)

**Must Index:**
- Current IES Standards (master PDFs from SharePoint)
- Document metadata from Vitrium (title, description, authoring committee)

**Must NOT Index for External API:**
- Deprecated standards
- Internal IES resources (Wicket data, section websites, events)

### 3. Search Results Presentation

**Visual Hierarchy:**
```
┌─────────────────────────────────────────┐
│ AI Natural Language Response (opt-in)  │
│ - Watermarked                           │
│ - Disclaimer required                   │
│ - Below excerpts, not in agent window   │
└─────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────┐
│ Annotated Excerpts from Standards       │
│ - Clearly marked as direct transcription│
│ - Highlighted relevant portions         │
│ - Links to exact pages in Vitrium       │
└─────────────────────────────────────────┘
```

**Each Result Section Must Include:**
- Screenshot or full recreation of illuminance tables
  - Complete table header (3-4 rows)
  - All relevant application rows with all columns
  - All cited footnotes
  - Hyperlink to table page in Vitrium
  - Citation: Full IES Standard designation
- Standard front cover thumbnail
- Document metadata (title, description, authoring committee)
- "Subscribe / 7-day Loan / 5-yr PDF" access options
- Deep links to Vitrium: `https://[vitrium-domain]/document#page=X`

### 4. Illuminance Table Handling (Critical)

**Requirements:**
- Accurate machine reading of complex table structures
- Extract: Full header + relevant rows + all footnotes + all general notes (Annex A)
- Must handle multi-row headers
- Preserve all footnote references
- Present complete context (never partial tables)
- Link to source page in Vitrium

**Format Considerations:**
- Discuss optimal table format for machine reading
- May need custom PDF parsing logic for IES table structures

### 5. Multi-User Purchasing & Licensing
- Bulk license purchases (webstore integration)
- Email-based user assignment
- Auto-associate with existing IES accounts
- Auto-create accounts if non-existent
- Track licensed users per product

### 6. Vitrium AI Search Integration
- Prominent placement in Vitrium interface (customizable HTML bar)
- Visual prominence to draw users to AI tool over native Vitrium search
- Pop-up window consideration for search interface
- Deep linking from search results to specific document pages

---

## Priority 2 Features (Strongly Preferred for Release)

### 1. Auto-Highlight Relevant Text
- AI-powered highlighting of most relevant portions in excerpted content
- Visual emphasis on key passages

### 2. Copy/Paste/Print Discouragement
- Technical measures to discourage unauthorized reproduction
- Watermarking on generated content
- Right-click prevention considerations

### 3. Version Comparison Tool
- "What changed" functionality between standard versions
- Always show: additions and revisions (with citations)
- REMOVED content: only shown if user explicitly opts in — present prompt before listing deletions
- Never expose deprecated standard content except in comparison context
- Deprecated data excluded from external API

### 4. Auto-Populate Webstore from Vitrium Metadata
- Document titles, descriptions, page counts
- Publisher info, SKU, ISBN
- Previous edition references
- Committee authorship

### 5. Bulk Account Creation for Staff
- Staff tool to create multiple IES accounts simultaneously
- Bulk Vitrium permission assignment
- Use case: Educational events, student access grants

### 6. Organizational Membership Checkout Flow
- Tiered benefits (Bronze/Silver/Gold/Platinum/Diamond)
- Additional user purchase with tier-based discounts
- User assignment interface

---

## Priority 3 Features (Deferred Rollout Acceptable)

### 1. Expanded Indexing Sources
- IES.org resources (events calendar, eLearning, Leukos, LC Study Group, webinars)
- IES Section websites & events
- Wicket data (user sections, committee rosters, active members)
- LS-1 Nomenclature webpage
- Standards Toolbox

### 2. Multi-Application Bulk Queries
- Submit list of applications, receive illuminance recommendations for all
- Example: "Office kitchen, hallways, façade, entrance, meeting room, restrooms, copy room, desks"
- Batch processing of lighting criteria lookups

### 3. XFDF Annotation Export Tool
- Convert Vitrium-exported .xfdf to Excel
- Parse: Page, User, Annotation type, ID, Created, Modified, Comment, Referenced Text
- Sort by: Page # → Modified (newest first)
- Truncate Referenced Text to first 150 characters
- Normalize date/time formatting

### 4. Committee Member Directory Integration
- Link author names to contributor pages or LinkedIn
- Cross-reference Vitrium metadata "Author" field with Wicket committee rosters
- Display current committee membership for each standard
- Requires user to be logged in as IES member

### 5. IES.org Search Integration
- Unified search across library + website
- **Subscribers:** Full AI search (all results → Vitrium)
- **Non-subscribers:** Limited AI search (recommended standards only → webstore)

### 6. Image/Graphic Search Results
- Return screenshots of formulas, diagrams, tables where relevant
- Example: "What is the formula for ___?" → image of formula from standard

### 7. Preview Document Thumbnails
- Auto-populate webstore with "Preview" PDF thumbnails
- Public viewing permissions for covers, TOC, intro, scope sections

---

## Technical Architecture

### Data Sources

**Primary (IES Control):**
```
SharePoint (Master PDFs)
    ↓
Vector Database ← Lensy AI Layer
    ↓
Search Results → Vitrium Deep Links
```

**Metadata Sources:**
- Vitrium document metadata API
- Wicket (member data, committees) - internal only
- IES.org content (events, education) - future

### Access Control Matrix

| User Type | AI Search Capability | Results Link To | Deprecated Std Access |
|-----------|---------------------|-----------------|----------------------|
| Subscriber | Full (all standards) | Vitrium viewer | Comparison only |
| Non-subscriber | Limited (recommended only) | Webstore | None |
| External API | Partner-scoped | Partner system | Never |

### Security & Copyright Constraints

**Strict Rules:**
1. Never reproduce >15 words from single source
2. ONE quote per source maximum
3. Default to paraphrasing
4. Never reproduce: song lyrics, poems, haikus, article paragraphs
5. Tables must be screenshots or full recreations (not paraphrased)
6. Watermark all AI-generated natural language responses
7. Require disclaimer acknowledgment before viewing AI responses

---

## User Experience Flows

### Example Search #1: "How bright should a skating rink be?"

**Response Structure:**
1. **AI Natural Language Summary** (opt-in, watermarked)
   - Brief context on IES skating rink recommendations
   - Reference to RP-6 Classes I-IV
   - Note on ice reflectivity factors

2. **Annotated Excerpts** (priority display)
   - Section 5.24: Skating (Ice - Figure)
   - Section 5.25: Skating (Ice - Speed)  
   - Section 6.15: Ice Hockey and Roller Hockey
   - Each with "Open" link to specific Vitrium page

3. **Illuminance Table Results**
   - Full Annex A table screenshot
   - All footnotes and general notes
   - Link to table page

4. **Recommended IES Standards** (with covers, metadata, purchase options)
   - ANSI/IES RP-6-24 (primary)
   - ANSI/IES RP-43-25 (related: outdoor pedestrian)
   - ANSI/IES LP-1-20 (related: design principles)

5. **Connect with Your IES Section** (if logged in)
   - User's section info from Wicket
   - Upcoming section events
   - Committee members in user's section

### Example Search #2: Multiple Applications

**Query:** "IES lighting recommendations for: office kitchen, hallways, façade, entrance, parking lot, meeting room, restrooms, copy room, desks"

**Response:**
- Accordion-style collapsible results for each application
- Each shows relevant table excerpts + links
- Batch PDF export option (future)

### Example Search #3: "What's new in ANSI/IES RP-6-24?"

**Response:**
1. List of additions (with citations)
2. List of revisions (with citations)  
3. Summary of formatting/editorial changes
4. Citations for both current and deprecated versions
5. **Does NOT list:** deleted content from deprecated version

---

## Integration Points

### Vitrium
- **SSO:** External Service API
- **Deep linking:** `#page=N` and `#bookmark=name`
- **Metadata API:** Pull document info for search results
- **Scope:** Infrastructure only - no custom feature requests

### Wicket (IES Member Database)
- User section affiliation
- Committee membership rosters
- LinkedIn/website URLs
- **Scope:** Internal use only, never external API

### IES Webstore (SureCart)
- Product listings auto-populated from Vitrium metadata
- Multi-user license purchasing
- Organizational membership tier checkout
- Bulk user assignment interface

### SharePoint
- Master PDF storage
- Direct indexing for vector database (bypasses Vitrium for AI training)

---

## Development Phases

### Phase 1: MVP (Priority 1 Features)
- AI agent with core instructions
- Current standards indexing
- Search results with annotated excerpts
- Illuminance table extraction
- Vitrium deep linking
- Multi-user licensing (webstore)

### Phase 2: Enhanced Experience (Priority 2)
- Auto-highlighting
- Version comparison
- Copy/paste prevention
- Webstore metadata auto-population
- Staff bulk account creation

### Phase 3: Ecosystem Integration (Priority 3)
- IES.org unified search
- Expanded content indexing
- XFDF export tool
- Committee directory integration
- Bulk query processing

### Phase 4: External API (Future Milestone)
- Partner API access layer
- LightStanza and third-party integrations
- Scoped to current standards only
- No Wicket or deprecated data exposure

---

## Success Metrics

### User Engagement
- Search queries per session
- Click-through to Vitrium documents
- Subscription conversions from search
- Time spent in search vs. native Vitrium search

### Content Quality
- Citation accuracy rate
- User satisfaction with search results
- Reported errors/corrections needed

### Business Impact
- Individual subscription purchases influenced by search
- Organizational membership upgrades
- Reduced support inquiries to Standards@ies.org
- External API partnership revenue (future)

---

## Risks & Constraints

### Technical Risks
- Illuminance table parsing accuracy (complex multi-row headers)
- Vector database performance at scale
- Deep link reliability in Vitrium viewer
- PDF structure variations across standard editions

### Copyright Risks
- Accidental reproduction of substantial passages
- Table/figure attribution requirements
- Watermarking effectiveness
- User screenshot/copy workarounds

### Business Constraints
- Vitrium is infrastructure partner, not feature developer
- Deprecated standards must remain internal-only
- External API must never expose member data
- All architecture must support future API licensing model

---

## Open Questions for Discussion

1. **Table Format:** What PDF table structure optimizes machine readability? Do we need staff to create structured data exports?

2. **Bulk Account Creation:** What's the workflow for staff to bulk-assign Vitrium permissions after creating accounts?

3. **Vitrium Customization:** What level of HTML/CSS control do we have in the Vitrium interface bar?

4. **Metadata API:** Does Vitrium expose all needed metadata fields, or do we need custom integration?

5. **Version Tracking:** How do we programmatically identify which standards are current vs. deprecated?

6. **Search Prominence:** Pop-up window for search, or embedded interface? What draws users effectively?

7. **External API Pricing:** How will third-party access be metered and billed?

---

## Exclusions (Out of Scope)

- Custom Vitrium feature development
- Broadcasting lighting criteria (per RP-6 scope)
- Compliance determinations or code interpretations
- Real-time collaboration features
- Mobile app development (web-responsive only)
- Integration with non-IES standards databases
- Automated design calculations or photometric modeling
- Direct PDF editing or annotation within Lensy

---

## Next Steps

1. **Technical Validation**
   - Test Vitrium API capabilities (metadata, deep linking)
   - Evaluate vector database options for PDF indexing
   - Prototype illuminance table extraction

2. **Stakeholder Alignment**
   - Review scope with Dan (Lighting Library lead)
   - Validate priority rankings with IES leadership
   - Confirm Vitrium integration boundaries

3. **Architecture Design**
   - Define vector database schema
   - Map SharePoint → indexing pipeline
   - Design webstore integration points

4. **Prototype Development**
   - Build Claude.md-guided proof of concept
   - Test search quality with sample queries
   - Validate citation accuracy

