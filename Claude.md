# Lensy: IES AI-Powered Standards Assistant

## Project Overview

Lensy is an intelligent, conversational assistant that transforms the IES Illuminance Selector from a static lookup tool into a natural language interface for exploring, understanding, and applying IES lighting standards. Named after the Latin word for "light," Lensy helps lighting professionals navigate the IES Lighting Library through context-aware search and citation-backed responses.

**Key Principle:** Lensy prioritizes authoritative source material over generative responses. Users see annotated excerpts, screenshots of illuminance tables, and deep links to standards—with optional AI-generated summaries as supplementary context.

---

## Architecture

### Core Components

```
┌─────────────────────────────────────────────────────────┐
│                    User Interface                        │
│         Hybrid: Natural Language + Category Browse       │
│              (Cloudflare Pages + Workers)               │
└─────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────┐
│                 Lensy Search Layer                      │
│  - Vector DB (Vectorize) - Semantic search              │
│  - Existing DB (D1) - Structured illuminance data       │
│  - Query Processing (Workers AI)                        │
│  - Response Generation (Workers AI)                     │
└─────────────────────────────────────────────────────────┘
                           ↓
┌──────────────┬──────────────┬──────────────┬───────────┐
│ Current IDT  │ SharePoint   │  Vitrium API │ Wicket API│
│ Database     │  PDFs        │ (Metadata+   │ (Members) │
│ (68 cols)    │ (Context)    │  DRM)        │           │
└──────────────┴──────────────┴──────────────┴───────────┘
```

### Key Architectural Insight

**The existing Illuminance Selector database is GOLD.** It contains:
- 134 applications with 68-column structured data
- Hierarchical taxonomy (App → App_s1 → App_s2 → ... App_s6)
- Complete illuminance values (Horizontal, Vertical, Task)
- Standard references and mappings
- Application notes and links

**Lensy enhances this with:**
- Natural language search interface
- Semantic matching via vector embeddings
- Full-text context from PDF standards
- AI-generated explanations (optional)
- Multi-application queries
- Integration with "My Projects" feature

### Technology Stack

**Frontend:**
- **Cloudflare Pages** - Static site hosting
- **React** - UI framework (or vanilla JS for lighter approach)
- **Tailwind CSS** - Styling (avoid generic AI aesthetics)

**Backend:**
- **Cloudflare Workers** - Serverless API endpoints
- **Cloudflare Vectorize** - Vector database for semantic search
- **Cloudflare R2** - PDF storage/caching
- **Cloudflare D1** - Metadata/user data (SQLite)
- **Cloudflare KV** - Session/cache management

**AI/ML:**
- **Workers AI** - Embeddings generation (@cf/baai/bge-base-en-v1.5)
- **Workers AI** - AI summary generation (@cf/meta/llama-3.3-70b-instruct-fp8-fast)
- **PDF.js** - Client-side PDF parsing/rendering

**Integrations:**
- **SharePoint API** - PDF source retrieval
- **Vitrium API** - Document metadata, SSO, deep linking
- **Wicket API** - Member data, committee rosters (internal only)

---

## Development Phases

### Phase 1: Core Search Infrastructure (MVP)

**Deliverables:**
1. PDF ingestion pipeline (SharePoint → R2 → Vectorize)
2. Search API endpoint with semantic matching
3. Basic UI with search input and results display
4. Citation formatting with Vitrium deep links
5. Illuminance table extraction and display

**Technical Requirements:**
- Parse IES standard PDFs from SharePoint
- Extract text, tables, and metadata
- Generate embeddings for semantic search
- Store vectors in Cloudflare Vectorize
- Return top-k relevant passages with page numbers
- Format results with proper citations

### Phase 2: Enhanced Results, AI Summaries & Licensing

**Deliverables:**
1. Optional AI-generated natural language summaries
2. Auto-highlighting of relevant text in excerpts
3. Screenshot/image extraction for tables and diagrams
4. Multi-document query support
5. "What's new" version comparison tool (ADDED / REVISED / REMOVED sections)
6. Multi-user license purchasing flow (Priority 1 — required for release)
7. Organizational membership tier checkout
8. Auto-populated product listings from Vitrium metadata

**Technical Requirements:**
- Workers AI integration for summaries (@cf/meta/llama-3.3-70b-instruct-fp8-fast)
- Text highlighting algorithm (TF-IDF or attention-based)
- Table detection and extraction from PDFs
- Image rendering for formulas/diagrams
- Deprecated standard handling for comparison queries only (indexed internally, excluded from external API)
- Version comparison UI: display ADDED and REVISED automatically; REMOVED only shown if user explicitly opts in
- SureCart API integration for multi-user licensing
- License assignment workflow and metadata sync from Vitrium → webstore
- UI guardrail: discourage copy/paste/print on AI-generated response sections (CSS pointer-events + JS copy event intercept + visible watermark overlay)

### Phase 3: User Experience & Integrations

**Deliverables:**
1. User authentication (IES member login)
2. Wicket integration — section affiliation, committee lookups, TC member matching
3. IES.org content indexing (events calendar, eLearning, LC Study Groups, Leukos, Standards Toolbox, section websites, upcoming webinars and virtual symposia)
4. Bulk query interface (multi-application illuminance lookup + Excel/CSV upload for Room Schedules and OPRs)
5. XFDF annotation export tool (convert Vitrium .xfdf annotations to Excel)

**Technical Requirements:**
- SSO integration with IES auth system
- Wicket API calls for member data:
  - Retrieve authenticated user's IES Section affiliation
  - Query members of Technical Committees (TCs) responsible for referenced standards
  - Cross-reference: display TC members who share the user's IES Section, with links to their public profile or website
  - Surface upcoming events for the user's local section
- IES.org content scraping/API targets: events calendar, eLearning catalog, LC Study Group registration, Leukos journal, Standards Toolbox, section website listings
- Display non-standards content (events, eLearning) in a "Related Resources" sidebar panel alongside search results
- Batch processing for multiple queries; Excel/CSV upload parses Room Schedule or OPR columns to run bulk illuminance lookups
- XML parsing for Vitrium .xfdf annotation files → Excel export with quoted text, page references, and annotation metadata

### Phase 4: Webstore & Staff Tools

**Deliverables:**
1. Webstore integration (SureCart) — remaining items beyond Phase 2 multi-user flow
2. Bulk account creation tool for staff (for time-limited event access: students or audiences acquiring viewing permissions for a one-time event)
3. Consolidated licensing and provisioning dashboard

**Technical Requirements:**
- SureCart API integration (event-scoped licenses distinct from ongoing subscriptions)
- User provisioning automation with expiry dates for event-based access
- Staff dashboard for bulk account creation and license management

### Phase 5: External API (Future)

**Deliverables:**
1. Partner API endpoints (LightStanza, etc.)
2. API key management and metering
3. Rate limiting and usage analytics
4. Documentation and developer portal

**Technical Requirements:**
- RESTful API design
- API key generation/validation
- Cloudflare rate limiting
- Current standards only (no deprecated, no Wicket data)

---

## File Structure

```
lucius/
├── README.md
├── Claude.md (this file)
├── docs/
│   ├── SCOPE.md (comprehensive requirements)
│   ├── API.md (endpoint specifications)
│   ├── GUIDELINES.md (AI agent instructions)
│   └── ARCHITECTURE.md (system design)
├── src/
│   ├── frontend/
│   │   ├── pages/
│   │   │   ├── index.html (search interface)
│   │   │   ├── results.html (search results)
│   │   │   └── compare.html (version comparison)
│   │   ├── components/
│   │   │   ├── SearchBar.jsx
│   │   │   ├── ResultCard.jsx
│   │   │   ├── IlluminanceTable.jsx
│   │   │   ├── AIResponse.jsx         (includes copy/paste guard)
│   │   │   ├── IESSectionWidget.jsx   (Wicket section + TC member display)
│   │   │   ├── VersionComparison.jsx  (ADDED/REVISED/REMOVED opt-in UI)
│   │   │   └── BulkQueryUpload.jsx    (Excel/CSV upload for batch lookup)
│   │   ├── styles/
│   │   │   └── main.css (Tailwind)
│   │   └── utils/
│   │       ├── api.js (API client)
│   │       └── formatting.js (citation formatting)
│   ├── workers/
│   │   ├── api.js (main API router)
│   │   ├── search.js (vector search logic)
│   │   ├── ingest.js (PDF ingestion pipeline)
│   │   ├── metadata.js (Vitrium/Wicket integration)
│   │   └── auth.js (authentication middleware)
│   ├── lib/
│   │   ├── pdf-parser.js (PDF.js wrapper)
│   │   ├── table-extractor.js (illuminance table parsing)
│   │   ├── embeddings.js (Workers AI integration)
│   │   ├── ai-summary.js (Workers AI summary client)
│   │   └── citations.js (citation formatting logic)
│   └── config/
│       ├── agent-instructions.txt (AI agent prompt)
│       ├── prohibited-phrases.json (copyright guardrails)
│       └── standards-schema.json (metadata structure)
├── scripts/
│   ├── ingest-pdfs.js (one-time PDF import — current + deprecated, tagged by status)
│   ├── sync-metadata.js (Vitrium metadata sync)
│   ├── test-search.js (search quality testing)
│   └── bulk-query.js (batch illuminance lookup from CSV/Excel upload)
├── tests/
│   ├── search.test.js
│   ├── citations.test.js
│   └── tables.test.js
├── wrangler.toml (Cloudflare Workers config)
└── package.json
```

---

## Implementation Guide

### Step 1: Set Up Cloudflare Infrastructure

**Prerequisites:**
- Cloudflare account with Workers, Pages, R2, D1, Vectorize, KV enabled
- Wrangler CLI installed: `npm install -g wrangler`

**Initialize Project:**
```bash
# Create new Workers project
wrangler init lucius

# Create R2 bucket for PDFs
wrangler r2 bucket create ies-standards-pdfs

# Create D1 database for metadata
wrangler d1 create ies-metadata

# Create Vectorize index
wrangler vectorize create ies-standards-vectors \
  --dimensions=768 \
  --metric=cosine

# Create KV namespace for sessions
wrangler kv:namespace create ies-sessions
```

**Configure wrangler.toml:**
```toml
name = "lucius-api"
main = "src/workers/api.js"
compatibility_date = "2024-01-01"

[[r2_buckets]]
binding = "PDFS"
bucket_name = "ies-standards-pdfs"

[[d1_databases]]
binding = "DB"
database_name = "ies-metadata"
database_id = "<your-d1-id>"

[[vectorize]]
binding = "VECTORIZE"
index_name = "ies-standards-vectors"

[[kv_namespaces]]
binding = "SESSIONS"
id = "<your-kv-id>"

[ai]
binding = "AI"

[vars]
VITRIUM_API_URL = "https://api.vitrium.com"
VITRIUM_API_KEY = "<vitrium-key>"
```

### Step 2: PDF Ingestion Pipeline

**Create Ingestion Worker** (`src/workers/ingest.js`):

```javascript
import { parsePDF } from '../lib/pdf-parser.js';
import { extractTables } from '../lib/table-extractor.js';
import { generateEmbeddings } from '../lib/embeddings.js';

export default {
  async fetch(request, env) {
    // Triggered by SharePoint webhook or manual upload
    const { pdfUrl, standardId } = await request.json();
    
    // 1. Fetch PDF from SharePoint
    const pdfResponse = await fetch(pdfUrl, {
      headers: { Authorization: `Bearer ${env.SHAREPOINT_TOKEN}` }
    });
    const pdfBytes = await pdfResponse.arrayBuffer();
    
    // 2. Store in R2
    await env.PDFS.put(`standards/${standardId}.pdf`, pdfBytes);
    
    // 3. Parse PDF content
    const { text, metadata, pages } = await parsePDF(pdfBytes);
    
    // 4. Extract illuminance tables
    const tables = await extractTables(pdfBytes, pages);
    
    // 5. Chunk text for embeddings (500 tokens per chunk)
    const chunks = chunkText(text, 500);
    
    // 6. Generate embeddings using Workers AI
    const embeddings = await generateEmbeddings(env.AI, chunks);
    
    // 7. Store in Vectorize with metadata
    const vectors = chunks.map((chunk, i) => ({
      id: `${standardId}-chunk-${i}`,
      values: embeddings[i],
      metadata: {
        standardId,
        pageNumber: chunk.pageNumber,
        text: chunk.text,
        type: chunk.type, // 'text' | 'table' | 'figure'
      }
    }));
    await env.VECTORIZE.upsert(vectors);
    
    // 8. Store document metadata in D1
    await env.DB.prepare(`
      INSERT INTO standards (id, title, description, author, year, pages, tables)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      standardId,
      metadata.title,
      metadata.description,
      metadata.author,
      metadata.year,
      JSON.stringify(pages),
      JSON.stringify(tables)
    ).run();
    
    return new Response('Ingested successfully', { status: 200 });
  }
};

function chunkText(text, maxTokens) {
  // Split text into chunks of ~maxTokens
  // Preserve paragraph boundaries and page numbers
  // Return: [{ text, pageNumber, type }]
}
```

**PDF Parser** (`src/lib/pdf-parser.js`):

```javascript
import * as pdfjsLib from 'pdfjs-dist';

export async function parsePDF(pdfBytes) {
  const pdf = await pdfjsLib.getDocument({ data: pdfBytes }).promise;
  
  let fullText = '';
  const pages = [];
  const metadata = await extractMetadata(pdf);
  
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items.map(item => item.str).join(' ');
    
    pages.push({
      number: i,
      text: pageText,
      height: page.view[3],
      width: page.view[2]
    });
    
    fullText += `\n[Page ${i}]\n${pageText}`;
  }
  
  return { text: fullText, metadata, pages };
}

async function extractMetadata(pdf) {
  const meta = await pdf.getMetadata();
  return {
    title: meta.info.Title || '',
    author: meta.info.Author || '',
    subject: meta.info.Subject || '',
    year: extractYear(meta.info.CreationDate),
  };
}

function extractYear(creationDate) {
  // Parse PDF date string: D:20240101120000
  const match = creationDate?.match(/D:(\d{4})/);
  return match ? match[1] : null;
}
```

**Table Extractor** (`src/lib/table-extractor.js`):

```javascript
export async function extractTables(pdfBytes, pages) {
  const tables = [];
  
  for (const page of pages) {
    // Heuristic: Look for grid-like text patterns
    const potentialTables = detectTableStructures(page.text);
    
    for (const tableText of potentialTables) {
      const parsed = parseIlluminanceTable(tableText);
      if (parsed) {
        tables.push({
          pageNumber: page.number,
          header: parsed.header,
          rows: parsed.rows,
          footnotes: parsed.footnotes,
          generalNotes: parsed.generalNotes,
          rawText: tableText
        });
      }
    }
  }
  
  return tables;
}

function detectTableStructures(text) {
  // Look for table markers in IES standards:
  // - "Table A-1", "Annex A", "Illuminance Criteria"
  // - Consistent column separators (spaces, tabs)
  // - Multiple rows with aligned data
  
  const tablePattern = /Table\s+[A-Z]-\d+[\s\S]+?(?=\n\n|$)/gi;
  return text.match(tablePattern) || [];
}

function parseIlluminanceTable(tableText) {
  // Parse IES-specific table format:
  // - Multi-row headers (typically 3-4 rows)
  // - Application rows with multiple columns
  // - Footnote markers (superscript numbers)
  // - "General Notes:" or "Annex A" sections
  
  const lines = tableText.split('\n');
  
  // Extract header rows (before first data row)
  const headerEndIdx = findHeaderEnd(lines);
  const header = lines.slice(0, headerEndIdx);
  
  // Extract data rows
  const dataRows = [];
  for (let i = headerEndIdx; i < lines.length; i++) {
    if (lines[i].match(/^\d/) || lines[i].includes('lux')) {
      dataRows.push(parseRow(lines[i]));
    } else if (lines[i].includes('General Notes:')) {
      break; // Start of footnotes
    }
  }
  
  // Extract footnotes and general notes
  const footnoteStartIdx = lines.findIndex(l => l.includes('General Notes:') || l.match(/^\[\d+\]/));
  const footnotes = footnoteStartIdx >= 0 ? lines.slice(footnoteStartIdx) : [];
  
  return {
    header: header.join('\n'),
    rows: dataRows,
    footnotes: footnotes.join('\n'),
    generalNotes: extractGeneralNotes(footnotes)
  };
}

function findHeaderEnd(lines) {
  // Find first line that looks like data (starts with number or application name)
  return lines.findIndex((line, idx) => {
    if (idx < 2) return false; // Skip first 2 rows (always header)
    return line.match(/^\d/) || line.match(/^[A-Z][a-z]+.*\d/);
  });
}

function parseRow(rowText) {
  // Split by multiple spaces (column separator)
  const columns = rowText.split(/\s{2,}/).filter(c => c.trim());
  return columns;
}

function extractGeneralNotes(footnotes) {
  // Extract Annex A general notes if present
  const annexMatch = footnotes.join('\n').match(/Annex A[\s\S]+/);
  return annexMatch ? annexMatch[0] : '';
}
```

**Embeddings Generator** (`src/lib/embeddings.js`):

```javascript
export async function generateEmbeddings(ai, chunks) {
  const embeddings = [];
  
  // Batch process chunks (Workers AI supports batching)
  const batchSize = 100;
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const inputs = batch.map(chunk => chunk.text);
    
    const response = await ai.run('@cf/baai/bge-base-en-v1.5', {
      text: inputs
    });
    
    embeddings.push(...response.data);
  }
  
  return embeddings;
}
```

### Step 3: Search API

**Search Worker** (`src/workers/search.js`):

```javascript
import { formatCitation } from '../lib/citations.js';
import { generateResponse } from '../lib/ai-summary.js';

export default {
  async fetch(request, env) {
    const { query, includeAISummary = false, userType = 'subscriber' } = await request.json();
    
    // 1. Generate query embedding
    const queryEmbedding = await env.AI.run('@cf/baai/bge-base-en-v1.5', {
      text: [query]
    });
    
    // 2. Search Vectorize for top-k matches
    const searchResults = await env.VECTORIZE.query(queryEmbedding.data[0], {
      topK: 20,
      returnMetadata: true
    });
    
    // 3. Group results by standard
    const groupedResults = groupByStandard(searchResults.matches);
    
    // 4. Fetch full metadata from D1
    const standardIds = Object.keys(groupedResults);
    const standards = await env.DB.prepare(`
      SELECT * FROM standards WHERE id IN (${standardIds.map(() => '?').join(',')})
    `).bind(...standardIds).all();
    
    // 5. Format results with citations
    const formattedResults = await Promise.all(
      standards.results.map(async (standard) => {
        const chunks = groupedResults[standard.id];
        const tables = findRelevantTables(standard, chunks);
        
        return {
          standard: {
            id: standard.id,
            title: standard.title,
            description: standard.description,
            author: standard.author,
            year: standard.year,
          },
          excerpts: chunks.map(chunk => ({
            text: chunk.metadata.text,
            pageNumber: chunk.metadata.pageNumber,
            citation: formatCitation(standard, chunk.metadata.pageNumber),
            vitriumLink: `https://vitrium.ies.org/document/${standard.id}#page=${chunk.metadata.pageNumber}`,
            relevanceScore: chunk.score
          })),
          tables: tables.map(table => ({
            pageNumber: table.pageNumber,
            header: table.header,
            rows: table.rows,
            footnotes: table.footnotes,
            generalNotes: table.generalNotes,
            vitriumLink: `https://vitrium.ies.org/document/${standard.id}#page=${table.pageNumber}`
          })),
          accessOptions: getAccessOptions(userType, standard)
        };
      })
    );
    
    // 6. Generate AI summary if requested
    let aiSummary = null;
    if (includeAISummary) {
      aiSummary = await generateResponse(env.AI, query, formattedResults);
    }
    
    return Response.json({
      query,
      results: formattedResults,
      aiSummary,
      timestamp: new Date().toISOString()
    });
  }
};

function groupByStandard(matches) {
  const grouped = {};
  for (const match of matches) {
    const standardId = match.metadata.standardId;
    if (!grouped[standardId]) grouped[standardId] = [];
    grouped[standardId].push(match);
  }
  return grouped;
}

function findRelevantTables(standard, chunks) {
  const tables = JSON.parse(standard.tables || '[]');
  const pageNumbers = [...new Set(chunks.map(c => c.metadata.pageNumber))];
  
  // Return tables from pages that matched the query
  return tables.filter(t => pageNumbers.includes(t.pageNumber));
}

function getAccessOptions(userType, standard) {
  if (userType === 'subscriber') {
    return { subscribe: true, loan: true, purchase: true };
  } else {
    return { subscribe: false, loan: false, purchase: true };
  }
}
```

**Citation Formatter** (`src/lib/citations.js`):

```javascript
export function formatCitation(standard, pageNumber, section = null) {
  // Format: ANSI/IES RP-43-25 Recommended Practice: Lighting Design for Outdoor Pedestrian Applications, Section 8.6.1.4, p. 42
  
  let citation = `${standard.id} ${standard.title}`;
  
  if (section) {
    citation += `, Section ${section}`;
  }
  
  if (pageNumber) {
    citation += `, p. ${pageNumber}`;
  }
  
  return citation;
}

export function validateCitation(text) {
  // Ensure citation includes:
  // 1. Full standard designation (ANSI/IES XX-YY)
  // 2. Title
  // 3. Section or page number
  
  const hasDesignation = /ANSI\/IES\s+[A-Z]+-\d+-\d+/.test(text);
  const hasPage = /p\.\s*\d+|Section\s+\d+/.test(text);
  
  return hasDesignation && hasPage;
}
```

**AI Summary Generator** (`src/lib/ai-summary.js`):

```javascript
export async function generateResponse(ai, query, searchResults) {
  const systemPrompt = await loadAgentInstructions();
  
  const userPrompt = `
User Query: "${query}"

Search Results (Excerpted from IES Standards):
${formatResultsForPrompt(searchResults)}

Instructions:
- Provide a brief, professional summary answering the user's query
- Use the search results as your ONLY source of information
- Always cite specific standards, sections, and page numbers
- Never reproduce more than 15 words from any single source
- Default to paraphrasing; quotes should be rare exceptions
- If illuminance values are requested, direct user to view the full table screenshots in the results
- Never provide quantitative data except via direct quote or table reference
- If the query cannot be answered from the provided results, say so clearly

Generate a concise, cited response:
`;

  const response = await ai.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
    max_tokens: 1000,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]
  });
  
  const data = await response.json();
  const text = data.content[0].text;
  
  // Validate response before returning
  const violations = checkCopyrightViolations(text);
  if (violations.length > 0) {
    console.warn('Copyright violations detected:', violations);
    return generateSafeResponse(query, searchResults);
  }
  
  return {
    text,
    watermark: 'IES Lensy AI-Generated Summary - Not for reproduction',
    disclaimer: 'This AI-generated response is for informational purposes only and may contain errors. Always refer to the full IES Standards for authoritative guidance.'
  };
}

async function loadAgentInstructions() {
  // Load from config/agent-instructions.txt
  return `You are Lensy, the IES Standards Assistant. Your role is to help lighting professionals explore and understand IES standards through accurate, well-cited responses.

Core Principles:
1. Always cite specific IES standards with full designation, section, and page number
2. Never provide legal, safety, financial, or contractual advice
3. Never perform design calculations or compliance determinations
4. Direct users to authoritative sources (specific standard sections) rather than making judgments
5. Maintain professional, neutral, academic tone

Copyright Rules (CRITICAL):
- Never quote more than 15 words from a single source
- Use at most ONE quote per source
- Default to paraphrasing in your own words
- Never reproduce song lyrics, poems, or substantial passages
- For illuminance tables: direct users to view screenshots/tables in results, never transcribe values

Citation Format:
"According to ANSI/IES RP-43-25, Section 8.6.1.4, p. 42, outdoor dining areas require..."

When Uncertain:
If you cannot confidently answer from the provided search results, say so clearly and suggest the user contact Standards@ies.org for authoritative assistance.`;
}

function formatResultsForPrompt(searchResults) {
  return searchResults.map((result, idx) => {
    const standard = result.standard;
    const excerpts = result.excerpts.slice(0, 3); // Top 3 excerpts per standard
    
    return `
[Result ${idx + 1}] ${standard.id} - ${standard.title}
${excerpts.map(e => `  - Page ${e.pageNumber}: "${e.text.substring(0, 200)}..."`).join('\n')}
${result.tables.length > 0 ? `  - Contains ${result.tables.length} relevant illuminance table(s)` : ''}
`;
  }).join('\n');
}

function checkCopyrightViolations(text) {
  const violations = [];
  
  // Check for long quotes (>15 words in quotes)
  const quotes = text.match(/"[^"]+"/g) || [];
  for (const quote of quotes) {
    const wordCount = quote.split(/\s+/).length;
    if (wordCount > 15) {
      violations.push(`Long quote detected: ${wordCount} words`);
    }
  }
  
  // Check for prohibited phrases
  const prohibited = loadProhibitedPhrases();
  for (const phrase of prohibited) {
    if (text.toLowerCase().includes(phrase.toLowerCase())) {
      violations.push(`Prohibited phrase: "${phrase}"`);
    }
  }
  
  return violations;
}

function loadProhibitedPhrases() {
  // Load from config/prohibited-phrases.json
  return [
    'song lyrics',
    'poem text',
    // Add specific phrases that should never appear
  ];
}

function generateSafeResponse(query, searchResults) {
  // Fallback response that lists relevant standards without AI generation
  const standardsList = searchResults.map(r => 
    `- ${r.standard.id}: ${r.standard.title}`
  ).join('\n');
  
  return {
    text: `I found several relevant IES standards that address "${query}":\n\n${standardsList}\n\nPlease review the excerpts and tables below for detailed guidance.`,
    watermark: null,
    disclaimer: 'This response lists relevant standards without AI interpretation.'
  };
}
```

### Step 4: Frontend Interface

**Search Page** (`src/frontend/pages/index.html`):

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lensy - IES Standards Search</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50">
  <div class="container mx-auto px-4 py-8 max-w-4xl">
    <header class="mb-8">
      <h1 class="text-3xl font-bold text-blue-900">Lensy</h1>
      <p class="text-gray-600">IES Standards Search</p>
    </header>
    
    <div class="bg-white rounded-lg shadow p-6 mb-6">
      <label for="search" class="block text-sm font-medium text-gray-700 mb-2">
        What would you like to look up?
      </label>
      <input 
        type="text" 
        id="search" 
        placeholder="e.g., How bright should a skating rink be?" 
        class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
      />
      <button 
        onclick="performSearch()" 
        class="mt-4 w-full bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700 transition"
      >
        Search IES Standards
      </button>
      
      <div class="mt-4">
        <label class="flex items-center text-sm text-gray-600">
          <input type="checkbox" id="includeAI" class="mr-2">
          Include AI-generated summary (optional)
        </label>
      </div>
    </div>
    
    <div id="results" class="hidden">
      <!-- Results will be rendered here -->
    </div>
    
    <div class="text-center text-sm text-gray-500 mt-8">
      <p>Example searches:</p>
      <ul class="mt-2 space-y-1">
        <li><a href="#" onclick="setQuery('How bright should a skating rink be?')" class="text-blue-600 hover:underline">How bright should a skating rink be?</a></li>
        <li><a href="#" onclick="setQuery('IES lighting recommendations for office meeting rooms')" class="text-blue-600 hover:underline">IES lighting recommendations for office meeting rooms</a></li>
        <li><a href="#" onclick="setQuery('What changed in the current version of ANSI/IES RP-6?')" class="text-blue-600 hover:underline">What changed in the current version of ANSI/IES RP-6?</a></li>
      </ul>
    </div>
  </div>
  
  <script src="../utils/api.js"></script>
  <script>
    function setQuery(text) {
      document.getElementById('search').value = text;
      performSearch();
    }
    
    async function performSearch() {
      const query = document.getElementById('search').value;
      const includeAI = document.getElementById('includeAI').checked;
      
      if (!query.trim()) return;
      
      // Show loading state
      const resultsDiv = document.getElementById('results');
      resultsDiv.classList.remove('hidden');
      resultsDiv.innerHTML = '<div class="text-center py-8"><p>Searching IES Standards...</p></div>';
      
      // Call API
      const response = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, includeAISummary: includeAI })
      });
      
      const data = await response.json();
      
      // Render results
      renderResults(data);
    }
    
    function renderResults(data) {
      const resultsDiv = document.getElementById('results');
      
      let html = `
        <div class="mb-6">
          <h2 class="text-2xl font-bold text-gray-900">Search Results</h2>
          <p class="text-gray-600">Query: "${data.query}"</p>
        </div>
      `;
      
      // AI Summary (if included)
      if (data.aiSummary) {
        html += renderAISummary(data.aiSummary);
      }
      
      // Standard Results
      for (const result of data.results) {
        html += renderStandardResult(result);
      }
      
      resultsDiv.innerHTML = html;
    }
    
    function renderAISummary(summary) {
      return `
        <div class="bg-blue-50 border-l-4 border-blue-600 p-6 mb-6 select-none" 
             oncontextmenu="return false"
             oncopy="return false"
             oncut="return false">
          <div class="flex items-start mb-3">
            <svg class="w-6 h-6 text-blue-600 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div>
              <h3 class="font-bold text-gray-900">AI-Generated Summary</h3>
              <p class="text-xs text-gray-600 mt-1">${summary.disclaimer}</p>
            </div>
          </div>
          <div class="prose text-gray-700">${summary.text}</div>
          <p class="text-xs text-gray-500 mt-4 italic">${summary.watermark} — This text may not be copied, reproduced, or distributed.</p>
        </div>
      `;
    }

    function renderIESSectionWidget(userSection) {
      if (!userSection) return '';
      return `
        <div class="bg-green-50 border border-green-200 rounded-lg p-4 mb-6">
          <h4 class="font-semibold text-green-800 mb-2">Connect with your IES Section</h4>
          <p class="text-sm text-green-700">You are a member of <a href="${userSection.url}" target="_blank" class="underline font-medium">${userSection.name}</a></p>
          ${userSection.upcomingEvents?.length ? `
            <div class="mt-2">
              <p class="text-xs text-green-600 font-medium">Upcoming section events:</p>
              <ul class="mt-1 space-y-1">
                ${userSection.upcomingEvents.map(e => `
                  <li class="text-xs text-green-700"><a href="${e.url}" target="_blank" class="hover:underline">${e.title} — ${e.date}</a></li>
                `).join('')}
              </ul>
            </div>
          ` : ''}
          ${userSection.tcMembers?.length ? `
            <div class="mt-3">
              <p class="text-xs text-green-600 font-medium">Technical Committee members in your section:</p>
              <ul class="mt-1 space-y-1">
                ${userSection.tcMembers.map(m => `
                  <li class="text-xs text-green-700">
                    ${m.profileUrl ? `<a href="${m.profileUrl}" target="_blank" class="underline">${m.name}</a>` : m.name}
                    — ${m.committee}
                  </li>
                `).join('')}
              </ul>
            </div>
          ` : ''}
        </div>
      `;
    }
    
    function renderStandardResult(result) {
      const standard = result.standard;
      
      let html = `
        <div class="bg-white rounded-lg shadow mb-6 p-6">
          <div class="flex items-start mb-4">
            <div class="flex-1">
              <h3 class="text-xl font-bold text-blue-900">${standard.id}</h3>
              <p class="text-gray-700">${standard.title}</p>
              <p class="text-sm text-gray-500">Authored by ${standard.author} (${standard.year})</p>
            </div>
            <div class="flex gap-2">
              <button class="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm">Subscribe</button>
              <button class="px-4 py-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300 text-sm">7-day Loan</button>
              <button class="px-4 py-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300 text-sm">5-yr PDF</button>
            </div>
          </div>
          
          <div class="border-t pt-4">
            <h4 class="font-semibold mb-2">Relevant Excerpts:</h4>
      `;
      
      // Excerpts
      for (const excerpt of result.excerpts) {
        html += `
          <div class="mb-3 pl-4 border-l-2 border-gray-300">
            <p class="text-gray-800">${excerpt.text}</p>
            <div class="mt-1 flex items-center gap-4 text-sm text-gray-600">
              <span>Page ${excerpt.pageNumber}</span>
              <a href="${excerpt.vitriumLink}" target="_blank" class="text-blue-600 hover:underline">Open in Vitrium →</a>
            </div>
          </div>
        `;
      }
      
      // Tables
      if (result.tables.length > 0) {
        html += `
          <h4 class="font-semibold mt-4 mb-2">Illuminance Tables:</h4>
        `;
        
        for (const table of result.tables) {
          html += `
            <div class="bg-gray-50 p-4 rounded mb-3">
              <p class="font-medium">Table on Page ${table.pageNumber}</p>
              <pre class="text-xs mt-2 overflow-x-auto">${table.header}</pre>
              <a href="${table.vitriumLink}" target="_blank" class="text-blue-600 hover:underline text-sm mt-2 inline-block">View full table in Vitrium →</a>
            </div>
          `;
        }
      }
      
      html += `
          </div>
        </div>
      `;
      
      return html;
    }
  </script>
</body>
</html>
```

### Step 5: AI Agent Instructions

**Agent Instructions File** (`src/config/agent-instructions.txt`):

```
# Lensy AI Agent Instructions

## Core Identity
You are Lensy, the Illuminating Engineering Society's (IES) AI assistant for navigating lighting standards. Your name derives from the Latin word for "light," representing both the foundation of illumination science and modern, intuitive access to IES knowledge.

## Primary Function
Direct users to the most relevant IES Standards with emphasis on:
- Specific section numbers
- Page numbers
- Figures, tables, or appendices when applicable

Provide brief, accurate summaries of referenced content and quote from relevant passages where appropriate.

## Scope and Boundaries

### You MAY:
- Explain concepts from IES Standards
- Cite specific sections, pages, and tables
- Compare different standards or editions
- Recommend additional reading from IES Standards
- Clarify technical terminology defined in IES LS-1

### You MAY NOT:
- Provide legal advice
- Provide safety advice
- Provide financial advice
- Provide contractual guidance
- Make project-specific design recommendations (except as described by IES Standards)
- Perform compliance determinations or code interpretations
- Make engineering judgments beyond standard references

## Follow-Up Questions
Ask clarifying questions when:
- User's intent is ambiguous
- Multiple standards may apply
- Additional context would improve accuracy or relevance

Keep follow-up questions concise, courteous, and academically neutral.

## Quantitative Data Protocol

When illuminance values or other quantitative data are requested:
1. Present a screenshot or complete recreation of the relevant Recommended Illuminance Criteria tables
2. Include: table header, all relevant rows, all cited footnotes, hyperlink to table page
3. Provide citation: full designation of source IES Standard adjacent to results

**CRITICAL:** Never provide metrics, formulas, illuminance values, or other quantitative values in a response except where they are quoted directly from the standard or presented as a screenshot. The user should be presented with a quote, screenshot, or reference back to the relevant standard.

## Citation Requirements

Each response must include:
1. Full standard designation (e.g., ANSI/IES RP-43-25 Recommended Practice: Lighting Design for Outdoor Pedestrian Applications)
2. Specific section or page range
3. Brief explanation of why the cited section is relevant
4. Hyperlink to the specific page referenced (or cover page if entire standard is referenced)

Example format:
"For foundational definitions of mesopic adaptation, see ANSI/IES LS-1-25 Lighting Science: Nomenclature and Definitions for Illuminating Engineering, Section 3.4."

## Deprecated Standards Policy

- Refer to outdated IES Standards as "deprecated"
- Only direct users to current (latest revision) IES Standards
- Never provide information contained in deprecated standards
- Exception: When user asks "what is new" or "what has changed," you may:
  - List additions in current standard (with citations)
  - List revisions in current standard (with citations)
  - Summarize formatting/editorial changes
  - Cite both current and deprecated standards
  - **Never list:** content deleted from deprecated standard

## Additional Reading Recommendations

When answering any question, identify at least one additional IES Standard that may deepen the user's understanding. Recommendations should be:
- Relevant
- Non-redundant
- Clearly explained in terms of value to the user's inquiry

## Handling Uncertainty

If you cannot confidently identify the correct standard or section:
1. Do not guess
2. Provide a courteous statement acknowledging uncertainty
3. Direct user to Standards@ies.org for authoritative assistance

Example: "I am unable to determine the appropriate standard for this topic. For definitive guidance, please contact Standards@ies.org."

## Tone and Style

Maintain a tone that is:
- Professional
- Neutral
- Academic
- Respectful

Avoid:
- Conversational filler
- Speculation
- Personal opinions

Keep responses concise while ensuring completeness and clarity.

## COPYRIGHT RULES (CRITICAL - NEVER VIOLATE)

### Hard Limits:
1. **15-word quote maximum** from any single source
   - If quote would be >15 words, extract only key 5-10 word phrase OR paraphrase entirely
2. **ONE quote per source maximum**
   - After quoting a source once, that source is CLOSED for quotation
   - All additional content from that source must be fully paraphrased
3. **Never reproduce:**
   - Song lyrics (not even one line)
   - Poems (not even one stanza)
   - Haikus (they are complete works)
   - Article paragraphs verbatim

### Self-Check Before Responding:
- Is this quote 15+ words? → VIOLATION, paraphrase or extract key phrase
- Have I already quoted this source? → Source is CLOSED, paraphrase only
- Is this a song lyric, poem, or haiku? → Do not reproduce
- Am I closely mirroring original phrasing? → Rewrite entirely
- Am I following article's structure? → Reorganize completely
- Could this displace need to read original? → Shorten significantly

### For Complex Research (5+ sources):
- Rely primarily on paraphrasing
- State findings in your own words with attribution
- Example: "According to Reuters, the policy faced criticism" (not quoting exact words)
- Reserve direct quotes for uniquely phrased insights that lose meaning when paraphrased
- Keep paraphrased content from any single source to 2-3 sentences maximum

## Version Comparison ("What's New") Protocol

When the user asks "what is new," "what changed," or "what is different" in a specific standard:

1. **Always show:** ADDED content (new sections, applications, guidance) — with citations
2. **Always show:** REVISED content (updated values, reorganized sections, editorial changes) — with citations
3. **Only show REMOVED if user explicitly opts in** — present a prompt: "Would you like to see what was removed from the deprecated version?" before listing deletions
4. **Cite both** the current and deprecated standard when making comparisons
5. **Never present deleted content as guidance** — frame removals as historical context only

Structured response format for version comparison:
```
ANSI/IES [STANDARD-CURRENT] vs. [STANDARD-DEPRECATED]

ADDED in [current]:
- [Item with citation to current standard section/page]

REVISED in [current]:
- [Item with citation to current standard section/page]

[REMOVED — only if user opted in]:
- [Item with note: "This content appeared in [deprecated] but is no longer in the current standard."]
```

## Predefined Responses

### When application not covered in current IES Standards:
"There may not be explicit lighting recommendations for that application within the current body of IES Standards. Please review the monthly IES Ignite Newsletter for upcoming public review periods and publications. Similar applications include [list]. Would you like IES recommendations for any of those applications?"

### When asked about future publications:
"Please review the monthly IES Ignite Newsletter for upcoming public review periods and publications."

## Sources Indexed (for context)

You have access to:
- Current IES Standards (master PDFs)
- Document metadata (title, description, authoring committee)
- Deprecated IES Standards (for version comparison queries ONLY — never cite for current guidance)
- [Phase 3+: IES.org resources including events, eLearning, LC Study Groups, Leukos, Standards Toolbox, section websites]
- [Phase 3+: Wicket member and section affiliation data]

You do NOT have access to:
- Deprecated standards for any purpose other than version comparison ("what changed", "what is new")
- Deprecated standards via external API — these are restricted to internal UI use only
- Content behind authentication walls
- Real-time updates or current events

## Remember:
Your goal is to help lighting professionals explore and understand IES standards through accurate, well-cited responses. When in doubt, direct users to the authoritative source material rather than making interpretations.
```

### Step 6: Testing & Validation

**Test Suite** (`tests/search.test.js`):

```javascript
import { describe, it, expect } from 'vitest';
import { formatCitation, validateCitation } from '../src/lib/citations.js';
import { checkCopyrightViolations } from '../src/lib/citations.js';

describe('Citation Formatting', () => {
  it('formats full citation correctly', () => {
    const standard = {
      id: 'ANSI/IES RP-43-25',
      title: 'Recommended Practice: Lighting Design for Outdoor Pedestrian Applications'
    };
    
    const citation = formatCitation(standard, 42, '8.6.1.4');
    expect(citation).toBe(
      'ANSI/IES RP-43-25 Recommended Practice: Lighting Design for Outdoor Pedestrian Applications, Section 8.6.1.4, p. 42'
    );
  });
  
  it('validates complete citations', () => {
    const valid = validateCitation(
      'ANSI/IES RP-6-24 Sports Lighting, Section 5.24, p. 67'
    );
    expect(valid).toBe(true);
  });
  
  it('rejects incomplete citations', () => {
    const invalid = validateCitation('See the sports lighting standard');
    expect(invalid).toBe(false);
  });
});

describe('Copyright Compliance', () => {
  it('detects long quotes (>15 words)', () => {
    const text = '"This is a very long quote that exceeds fifteen words and should be flagged as a copyright violation by the system"';
    const violations = checkCopyrightViolations(text);
    expect(violations.length).toBeGreaterThan(0);
  });
  
  it('allows short quotes (<15 words)', () => {
    const text = '"Outdoor dining requires careful lighting design"';
    const violations = checkCopyrightViolations(text);
    expect(violations.length).toBe(0);
  });
});

describe('Search Quality', () => {
  it('returns relevant results for skating rink query', async () => {
    const response = await fetch('/api/search', {
      method: 'POST',
      body: JSON.stringify({ query: 'How bright should a skating rink be?' })
    });
    
    const data = await response.json();
    
    expect(data.results.length).toBeGreaterThan(0);
    expect(data.results[0].standard.id).toContain('RP-6');
    expect(data.results[0].excerpts.length).toBeGreaterThan(0);
  });
});
```

---

## Deployment

### Deploy to Cloudflare

```bash
# Deploy Workers
wrangler deploy

# Deploy Pages (frontend)
wrangler pages deploy src/frontend --project-name=lucius

# Run initial PDF ingestion
node scripts/ingest-pdfs.js

# Sync metadata from Vitrium
node scripts/sync-metadata.js
```

### Environment Variables

Set these in Cloudflare dashboard or via `wrangler secret put`:

```
VITRIUM_API_URL=https://api.vitrium.com
VITRIUM_API_KEY=<vitrium-key>
SHAREPOINT_TOKEN=<sharepoint-token>
```

---

## Monitoring & Maintenance

### Key Metrics to Track:
- Search queries per day
- Average response time
- Citation accuracy rate (manual review)
- User satisfaction (thumbs up/down)
- Copyright violation alerts
- Conversion rate (search → purchase/subscribe)

### Regular Maintenance:
- Weekly: Review flagged copyright violations
- Monthly: Audit citation accuracy on random sample
- Quarterly: Update agent instructions based on user feedback
- As needed: Re-ingest updated/new standards from SharePoint

---

## Next Steps

1. **Set up Cloudflare infrastructure** (R2, D1, Vectorize, Workers)
2. **Implement PDF ingestion pipeline** (SharePoint → R2 → Vectorize)
3. **Build search API** with citation formatting
4. **Create minimal frontend** for testing
5. **Test with sample queries** from prototype documents
6. **Iterate on table extraction** to handle IES-specific formats
7. **Deploy MVP** and gather user feedback
8. **Expand to Priority 2 features** based on usage patterns

---

## Resources

- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [Cloudflare Vectorize](https://developers.cloudflare.com/vectorize/)
- [Workers AI](https://developers.cloudflare.com/workers-ai/)
- [Workers AI Models](https://developers.cloudflare.com/workers-ai/models/)
- [PDF.js Documentation](https://mozilla.github.io/pdf.js/)

---

## Notes

This architecture prioritizes:
1. **Authoritative content** over AI generation (excerpts + tables first, AI summary optional and collapsed by default)
2. **Copyright compliance** (strict guardrails on quotation length, frequency, and UI copy-guards on AI sections)
3. **Accurate citations** (always link back to specific pages in standards)
4. **Scalability** (serverless infrastructure, vector search for semantic matching)
5. **Future-proof** (designed to support external API licensing layer)
6. **Privacy of deprecated standards** (indexed internally for version comparison UI; never exposed via external API)

### Deprecated Standards Indexing Policy
- **Index:** Yes — current AND deprecated PDFs are ingested into Vectorize, tagged with `status: 'deprecated'`
- **Internal UI:** Deprecated content is accessible for version comparison queries only
- **External API (Phase 5):** Filter out all deprecated-tagged vectors — never returned to external partners
- **Agent behavior:** Never cite deprecated standards for current guidance; only reference them when user explicitly asks "what changed" or "what is new"

The Cloudflare stack provides:
- **Global edge deployment** for low latency
- **Cost-effective scaling** (pay-per-use, no idle costs)
- **Integrated AI/ML** (Workers AI for embeddings, no external service needed)
- **Simplified operations** (no server management, automatic scaling)
