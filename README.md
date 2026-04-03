# Lucius: IES AI-Powered Standards Assistant

**Status:** Design Phase  
**Target Launch:** Q3 2026  
**Tech Stack:** Cloudflare Workers, Vectorize, D1, Pages + Anthropic Claude API

---

## What is Lucius?

Lucius transforms the IES Illuminance Selector from a static lookup tool into an intelligent, conversational assistant. Named after the Latin word for "light," Lucius helps lighting professionals explore, understand, and apply IES standards through natural language search, contextual explanations, and project-based workflows.

**Key Innovation:** Search "spa lighting requirements" instead of navigating: Healthcare → Hospitals → Ambulatory Care → Spas

---

## Documentation Map

Read these documents in order, or jump to what you need:

### 📊 For Stakeholders & Leadership

**[01_SUMMARY.md](docs/01_SUMMARY.md)** - Executive Overview (5 min read)
- What we're building and why
- Key architectural decisions
- Business impact and success metrics
- Next steps

**Start here if:** You need to present Lucius to IES leadership or secure buy-in.

---

### 📋 For Product & Project Managers

**[02_SCOPE.md](docs/02_SCOPE.md)** - Comprehensive Requirements (30 min read)
- Complete feature list (Priority 1/2/3)
- Technical architecture (AI layer, Vitrium, External API)
- Integration points (SharePoint, Wicket, Webstore)
- Constraints, risks, and open questions

**Start here if:** You're planning the project, managing timelines, or coordinating with vendors.

---

### 🎨 For Developers & Designers

**[03_MVP_FEATURES.md](docs/03_MVP_FEATURES.md)** - MVP Feature Specification (45 min read)
- Detailed UI wireframes for every feature
- User workflows with examples
- Database schemas
- API endpoint definitions
- Success criteria and what's out of scope

**Start here if:** You're building features, designing UI, or writing acceptance tests.

---

### 🔧 For Implementation (Claude Code)

**[05_Claude.md](docs/05_Claude.md)** - Technical Implementation Guide (60 min read)
- Cloudflare infrastructure setup (Workers, Vectorize, R2, D1)
- PDF ingestion pipeline
- Vector search implementation
- Code examples for all major components
- Deployment instructions

**Start here if:** You're ready to build. This is your step-by-step development guide.

---

### 📚 For Context (Optional)

**[04_ADDENDUM_RealSystem.md](docs/04_ADDENDUM_RealSystem.md)** - Current System Analysis
- What idt.ies.org actually does today
- 68-column database structure
- How Lucius enhances (not replaces) existing features
- Migration considerations

**Start here if:** You need to understand the current Illuminance Selector or legacy constraints.

---

## Quick Start

### For Non-Technical Readers
1. Read **SUMMARY.md** (5 min) to understand the vision
2. Skim **MVP_FEATURES.md** Section 1 (Search & Discovery) to see what users will experience

### For Technical Readers
1. Read **SUMMARY.md** (5 min) for context
2. Jump to **Claude.md** Section "Step 1: Set Up Cloudflare Infrastructure"
3. Reference **MVP_FEATURES.md** for specific feature requirements as you build

### For Project Managers
1. Read **SUMMARY.md** (5 min) for vision
2. Read **SCOPE.md** (30 min) for complete requirements
3. Use **MVP_FEATURES.md** to create user stories and acceptance criteria

---

## Key Decisions Made

### Architecture
- **IES owns the AI search layer** - Direct PDF indexing, independent of Vitrium
- **Vitrium = delivery infrastructure only** - SSO, DRM, deep linking
- **External API within IES infrastructure** - Never exposes Vitrium/Wicket internals
- **Deprecated standards internal-only** - Available for version comparison, excluded from external API

### Technology
- **Cloudflare-native** - Workers, Vectorize, R2, D1, Pages (serverless, edge-deployed)
- **Workers AI for embeddings** - @cf/baai/bge-base-en-v1.5 model
- **Anthropic Claude for summaries** - Sonnet 4 with strict copyright guardrails
- **PDF.js for parsing** - Client-side and server-side PDF processing

### Scope
- **MVP: 12 weeks** - Search, projects, exports, AI summaries
- **Phase 2: Collaboration** - Team projects, sharing, version comparison
- **Phase 3: External API** - Third-party partner access (LightStanza, etc.)

---

## MVP Feature Highlights

### 1. Natural Language Search
```
"spa lighting requirements"
  → Healthcare: Spas (75 lux / 50 lux)
  → Hospitality: Hotel Spas (100 lux / 75 lux)
  → Residential: Home Spas (50 lux / 30 lux)
```

### 2. Multi-Application Queries
```
"office lobby, hallway, conference room, break room, restroom"
  → Returns all 5 applications
  → [Select All] → [Add to Project]
```

### 3. Project Management
- Create projects (name, location, client, type)
- Add applications from search (single or bulk)
- Customize per project (quantity, room names, notes)
- Override IES values if needed (with documented reasoning)

### 4. Professional Exports
- **PDF:** Lighting schedule with logo, signatures, formatted for clients
- **Excel:** Full 68-column data for calculations and modeling
- **Print-optimized:** Clean B&W views

### 5. Standard Context
- Excerpts from actual IES PDFs explaining "why these values?"
- Deep links to Vitrium for full standard access

### 6. Optional AI Summaries
- Plain-language explanations
- Copyright-compliant (<15 words per quote, 1 quote per source)
- Watermarked, requires disclaimer acknowledgment

---

## Database Overview

### Current System (Imported)
**134 applications × 68 columns**
- Hierarchical taxonomy (App → App_s1 → App_s2 ... App_s6)
- Complete illuminance data (Horizontal, Vertical, Task)
- Outdoor lighting guidance (BUG ratings, CCT, LZ)
- Standard references and mappings

### New for Lucius
**Projects Table**
- User projects with metadata (name, location, client, type)
- Status tracking (Active, Archived, Completed)

**Project Applications Table**
- Links applications to projects
- Snapshot of 68-column data (in case standard updates)
- User customizations (quantity, room names, notes, overrides)

**Vector Search Index (Cloudflare Vectorize)**
- 768-dimensional embeddings for each application
- Semantic search ("wellness center" → "spa")
- Sub-500ms query response time

---

## Success Criteria (First 90 Days)

### User Adoption
- 500+ searches
- 100+ projects created
- 50+ exports (PDF/Excel)

### Search Quality
- 90%+ relevant results (manual audit)
- Average 3+ applications per project

### Technical Performance
- <500ms search response time
- <2s PDF generation
- 99.9% uptime

### Business Impact
- 20% increase in Vitrium document views
- 10% increase in IES memberships
- >4.0/5.0 user satisfaction rating

---

## Development Timeline

**Weeks 1-2:** Data & Infrastructure  
**Weeks 3-4:** Search & Results  
**Weeks 5-6:** Projects Core  
**Weeks 7-8:** Export & Deliverables  
**Weeks 9-10:** AI & Polish  
**Weeks 11-12:** Testing & Launch  

---

## Out of Scope for MVP

- Mobile app (web-responsive only)
- Offline mode
- Integration with lighting design software (AGi32, Dialux)
- BIM/Revit plugins
- Multi-language support (English only)
- Conversational AI chatbot (search only)
- Energy modeling calculations

These may come in future phases based on user feedback.

---

## Getting Started

### To Review the Design
1. Read **SUMMARY.md** for overview
2. Read **MVP_FEATURES.md** Section 1-4 for core features
3. Provide feedback on feature priorities or UI wireframes

### To Start Building
1. Review **Claude.md** infrastructure setup
2. Set up Cloudflare account with Workers, Vectorize, R2, D1
3. Import 68-column database from Excel export
4. Follow step-by-step implementation guide

### To Test Current System
1. Visit idt.ies.org
2. Navigate: Healthcare → Hospitals → Spas
3. Note the current workflow (category browsing, filters, results)
4. Compare to proposed Lucius workflow in MVP_FEATURES.md

---

## Questions or Feedback?

**Project Lead:** Shane Skwarek, S-FX (shane@s-fx.com)  
**IES Contacts:** Dan (Lighting Library), Colleen Harper, Olga Loukina  
**Technical Stack:** Cloudflare + Anthropic Claude API  

For feedback on features, priorities, or technical approach, update the relevant document and notify the project lead.

---

## Document Changelog

**v1.0 (April 3, 2026)** - Initial documentation suite
- SUMMARY: Executive overview
- SCOPE: Comprehensive requirements (Priority 1/2/3)
- MVP_FEATURES: Detailed feature specifications for first release
- ADDENDUM: Analysis of current idt.ies.org system
- Claude.md: Technical implementation guide for Cloudflare

**Next Update:** After stakeholder review and priority confirmation
