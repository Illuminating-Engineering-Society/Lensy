# Lucius Project: Executive Summary

## What We're Building

**Lucius** transforms the IES Illuminance Selector from a static lookup tool into an intelligent conversational assistant that helps lighting professionals explore, understand, and apply IES standards through natural language queries.

### The Shift

**FROM:** "Find me the illuminance value for X application"  
**TO:** "Help me understand lighting requirements for X, with context, citations, and related guidance"

---

## Key Documents Created

### 1. LUCIUS_SCOPE.md
**Comprehensive requirements document** covering:
- Core vision and architecture (3-tier: AI layer, Vitrium, External API)
- Priority 1/2/3 features with detailed specifications
- Technical constraints and integration points
- User experience flows with examples
- Success metrics and risk analysis

**Key Decisions:**
- IES owns AI/search layer (trained on source PDFs, not Vitrium API)
- Vitrium = delivery infrastructure only (SSO, DRM, deep linking)
- External API layer sits within IES infrastructure (never exposes Vitrium/Wicket)
- Deprecated standards indexed only for version comparison (excluded from external API)

### 2. Claude.md
**Technical implementation guide** for building with Claude Code + Cloudflare:
- Complete architecture (Cloudflare Workers, Pages, R2, D1, Vectorize, Workers AI)
- Step-by-step implementation (PDF ingestion → vector search → results rendering)
- Code examples for all major components
- AI agent instructions (copyright rules, citation requirements, scope boundaries)
- Testing and deployment procedures

**Technology Stack:**
- **Frontend:** Cloudflare Pages + React/Tailwind
- **Backend:** Cloudflare Workers (serverless API)
- **Database:** Cloudflare D1 (SQLite) + R2 (PDF storage)
- **Search:** Cloudflare Vectorize (vector database)
- **AI/ML:** Workers AI (embeddings) + Anthropic Claude API (responses)

---

## Critical Features (Priority 1 - Required for Release)

### 1. AI Agent with Strict Guidelines
- Professional, neutral, academic tone
- Always cite IES Standards (full designation + section + page)
- Never provide legal/safety/financial/design advice
- Copyright compliance: max 15 words per quote, 1 quote per source, default to paraphrasing
- Quantitative data only via screenshots or direct quotes (never generated)

### 2. Search Results Presentation
Visual hierarchy:
```
Optional AI Summary (watermarked, disclaimer required)
         ↓
Annotated Excerpts (clearly marked, highlighted, linked to Vitrium pages)
         ↓
Illuminance Tables (full screenshots: header + rows + footnotes + link)
         ↓
Recommended Standards (covers, metadata, purchase options)
```

### 3. Illuminance Table Handling
**Critical requirement:** Accurately extract complex IES table structures
- Multi-row headers (3-4 rows typical)
- All relevant application rows with all columns
- All cited footnotes + General Notes (Annex A)
- Deep links to exact table pages in Vitrium

### 4. Multi-User Licensing
- Bulk purchases (8+ licenses)
- Email-based user assignment
- Auto-create accounts if non-existent
- Organizational membership tier integration

### 5. Vitrium Integration
- Prominent AI search placement in Vitrium interface
- Deep linking: `#page=N` and `#bookmark=name`
- Metadata API for document info
- SSO via External Service API

---

## Architecture at a Glance

```
User Query: "How bright should a skating rink be?"
         ↓
[Cloudflare Workers API]
    ↓                    ↓
Generate Embedding   Fetch User Context
    ↓                    
[Vectorize Search] → Top 20 Matches
    ↓
Group by Standard
    ↓
[D1 Database] → Fetch Metadata
    ↓
Format Results (Excerpts + Tables + Citations)
    ↓
[Optional: Claude API] → Generate Summary
    ↓
Return to Frontend
    ↓
Display:
- AI Summary (opt-in, watermarked)
- ANSI/IES RP-6-24 excerpts + table screenshot → "Open Page 67 in Vitrium"
- ANSI/IES RP-43-25 related content → "Subscribe / Loan / Purchase"
- Connect with your IES Section (committee members, events)
```

---

## Data Sources & Access Control

| Data Source | Indexed For | Accessible To | Notes |
|------------|-------------|---------------|-------|
| Current IES Standards (SharePoint PDFs) | AI search | All users | Direct PDF indexing (not via Vitrium) |
| Deprecated Standards | Version comparison only | Internal only | Never in external API |
| Vitrium Metadata | Document info | All users | Title, description, author, year |
| Wicket (Members, Committees) | Section connections | IES members only | Never in external API |
| IES.org Content | Future expansion | All users | Events, eLearning, Leukos |

---

## Copyright Compliance (CRITICAL)

**Hard Limits (Never Violate):**
1. **15 words maximum** per quote from any source
2. **ONE quote per source** (after one quote, source is CLOSED)
3. **Never reproduce:** song lyrics, poems, haikus, article paragraphs
4. **Default to paraphrasing** in AI-generated responses

**Illuminance Tables Exception:**
- Tables shown as full screenshots or complete recreations
- Include all context (header, rows, footnotes, general notes)
- Link to source page in Vitrium
- This is NOT considered "reproduction" because it's attributed reference material

---

## User Experience Examples

### Example 1: "How bright should a skating rink be?"

**AI Summary (optional, watermarked):**
> IES RP-6-24 provides illuminance recommendations for skating rinks based on activity type and competition level. Ice rinks require higher levels than many sports due to ice reflectivity and fast-moving objects. Classes I-IV differentiate recreational from professional broadcast needs.

**Excerpts from Standards:**
- **ANSI/IES RP-6-24, Section 5.24, Page 67:** "Figure skating exhibitions and competitions are frequently dramatic presentations with music and dancing..." [Open in Vitrium →]
- **ANSI/IES RP-6-24, Section 6.15, Page 89:** "Hockey rinks are also used for recreational and figure skating..." [Open in Vitrium →]

**Illuminance Table (screenshot):**
[Full Table A-3 from RP-6-24 with header, all skating rows, footnotes]
[Open Table Page in Vitrium →]

**Recommended Standards:**
- ANSI/IES RP-6-24: Sports and Recreational Area Lighting (primary)
- ANSI/IES RP-43-25: Outdoor Pedestrian Applications (related)

**Access Options:** Subscribe | 7-day Loan | 5-yr PDF

### Example 2: Multiple Applications

**Query:** "Office kitchen, hallways, entrance, meeting room, restrooms"

**Response:**
- Collapsible sections for each application
- Each shows relevant table excerpts + citations
- Links to specific pages in RP-1-24 (Office Spaces) and RP-10-20 (Common Applications)

### Example 3: Version Comparison

**Query:** "What's new in ANSI/IES RP-6-24?"

**Response:**
- List of additions (Pickleball, Futsal, with citations)
- List of revisions (LED guidance, CCT recommendations, with citations)
- Summary of editorial changes
- Citations for both RP-6-24 (current) and RP-6-22 (deprecated)
- **Does NOT list:** deleted content from RP-6-22

---

## Development Phases

### Phase 1: MVP (3-4 months)
- PDF ingestion pipeline (SharePoint → Vectorize)
- Search API with semantic matching
- Citation formatting + Vitrium deep linking
- Illuminance table extraction
- Basic frontend (search + results)
- Multi-user licensing (webstore)

### Phase 2: Enhanced UX (2-3 months)
- Optional AI summaries with copyright guardrails
- Auto-highlighting of relevant text
- Version comparison tool
- Webstore metadata auto-population
- Bulk account creation for staff

### Phase 3: Ecosystem Integration (3-4 months)
- IES.org unified search (subscribers vs. non-subscribers)
- Wicket integration (section connections, committee lookups)
- Expanded content indexing (events, eLearning, Leukos)
- XFDF annotation export tool
- Bulk query interface (multi-application lookup)

### Phase 4: External API (Future)
- Partner API endpoints
- API key management and metering
- Rate limiting and usage analytics
- Developer documentation

---

## Success Metrics

**User Engagement:**
- Queries per session
- Click-through to Vitrium documents
- Time spent vs. native Vitrium search

**Business Impact:**
- Subscription conversions from search
- Organizational membership upgrades
- Reduced support inquiries to Standards@ies.org

**Content Quality:**
- Citation accuracy rate (manual audit)
- User satisfaction (thumbs up/down)
- Reported errors/corrections needed

---

## Risks & Mitigations

### Technical Risks
- **Table extraction accuracy:** IES tables have complex multi-row headers
  - **Mitigation:** Prototype with real PDFs, may need custom parsing logic or staff-created structured data
  
- **Vector search quality:** Generic embeddings may miss domain-specific nuance
  - **Mitigation:** Test with IES-specific queries, fine-tune retrieval thresholds

- **Vitrium deep link reliability:** Links may break if Vitrium updates viewer
  - **Mitigation:** Regular testing, fallback to document cover if page link fails

### Copyright Risks
- **Accidental reproduction:** AI may generate long quotes despite instructions
  - **Mitigation:** Post-processing validation, flag violations before returning response
  
- **User screenshots:** Can't prevent users from screenshotting AI summaries
  - **Mitigation:** Watermark all AI-generated text, disclaimer before viewing

### Business Constraints
- **Vitrium is infrastructure partner, not feature developer**
  - **Mitigation:** Design around Vitrium's existing capabilities (SSO, deep links, metadata API)
  
- **External API must never expose member data**
  - **Mitigation:** Separate data layers, API scoped to current standards only

---

## Open Questions

1. **Table Format:** Do we need staff to create structured data exports, or can we parse existing PDF tables accurately?

2. **Vitrium Customization:** What level of HTML/CSS control do we have in the interface bar?

3. **Metadata Sync:** Does Vitrium expose all needed fields via API (author, committee, description)?

4. **Bulk User Management:** What's the workflow for staff to bulk-assign Vitrium permissions after creating IES accounts?

5. **Search Prominence:** Pop-up window or embedded interface? How do we visually draw users to Lucius vs. native Vitrium search?

6. **Version Tracking:** How do we programmatically identify current vs. deprecated standards? (SharePoint folder structure? Metadata field?)

---

## Next Steps

### Immediate (Week 1-2):
1. Review scope document with Dan and IES leadership
2. Validate Vitrium API capabilities (metadata, deep linking, SSO)
3. Test Cloudflare Vectorize with sample IES PDFs
4. Prototype illuminance table extraction on 3-5 real standards

### Short-term (Month 1):
1. Set up Cloudflare infrastructure (R2, D1, Vectorize, Workers)
2. Build PDF ingestion pipeline (SharePoint → R2 → Vectorize)
3. Implement search API with citation formatting
4. Create minimal frontend for internal testing
5. Conduct search quality testing with queries from prototype documents

### Medium-term (Months 2-3):
1. Refine table extraction based on test results
2. Integrate Claude API for optional summaries
3. Implement copyright validation post-processing
4. Build webstore multi-user licensing flow
5. Deploy MVP to staging environment

### Long-term (Months 4+):
1. Gather user feedback from beta testers
2. Iterate on search relevance and citation accuracy
3. Expand to Priority 2 features based on usage patterns
4. Plan for external API rollout (partner discussions)

---

## Files Included

1. **LUCIUS_SCOPE.md** - Comprehensive requirements (14,000 words)
2. **Claude.md** - Technical implementation guide (12,000 words)
3. **SUMMARY.md** - This executive overview (2,000 words)

**Total Documentation:** ~28,000 words covering architecture, features, implementation, and next steps.

---

## Key Takeaway

Lucius is not just a search tool—it's a new way for lighting professionals to engage with IES standards. By combining semantic search, authoritative citations, and optional AI context, we transform static documents into an interactive knowledge base while maintaining the integrity and accuracy that IES members expect.

The Cloudflare-based architecture ensures scalability, low latency, and cost-effectiveness, while the strict copyright guardrails and citation requirements protect IES intellectual property and ensure users always return to authoritative source material.

**Success = Users spend less time searching, more time understanding.**
