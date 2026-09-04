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
1. **Authoritative content** over AI generation (excerpts + tables are the answer; the AI Guide is a summary above them, on by default since 2026-08-14 but always dismissable)
2. **Copyright compliance** (strict guardrails on quotation length, frequency, and UI copy-guards on AI sections)
3. **Accurate citations** (always link back to specific pages in standards)
4. **Scalability** (serverless infrastructure, vector search for semantic matching)
5. **Future-proof** (designed to support external API licensing layer)
6. **Privacy of deprecated standards** (indexed internally for version comparison UI; never exposed via external API)

### Deprecated Standards Indexing Policy
- **Index:** Yes — deprecated PDFs are ingested into a SEPARATE Vectorize index (`ies-standards-deprecated-vectors`, binding `VECTORIZE_DEPRECATED`), never the main one. Rationale: (a) the deprecated corpus is ~3× the current one and would crowd the shared topK pool, degrading current-standard recall; (b) Vectorize metadata filters only apply to vectors inserted after a metadata index exists, so a `status`-tag filter would have required re-ingesting the entire existing corpus; (c) external-API exclusion becomes structural — only the version-comparison path in `src/workers/search.js` ever queries the deprecated index.
- **Ingestion:** PDFs under `pdfs/Deprecated Standards/` are auto-detected (or force with `--status deprecated`). No application records are ever extracted from deprecated PDFs; raw PDFs go to the `deprecated/` R2 prefix; the D1 row gets `status = 'Deprecated'` plus a best-effort `superseded_by` pointing at the newest Active edition of the same family. A deprecated file whose ID matches a CURRENT standard (reaffirmed printing, e.g. `LM-63-19` vs `LM-63-19R25`) is refused — it is the same edition, not a prior one.
- **Internal UI:** Deprecated content surfaces ONLY on version-comparison queries ("what's new in RP-6?") that name a standard; results are flagged `isDeprecated` with a `deprecationNotice` and render with an amber "Deprecated" banner.
- **External API (Phase 5):** Never bind/query `VECTORIZE_DEPRECATED` — deprecated content is structurally unreachable from the main index.
- **Agent behavior:** Never cite deprecated standards for current guidance; only reference them when user explicitly asks "what changed" or "what is new"
- **Comparison scope (client DO27):** result cards print the CURRENT edition first, then the deprecated editions newest → oldest. The AI comparison is against exactly ONE prior edition — the most recent deprecated one, unless the query names another explicitly ("what changed between RP-8-25 and RP-8-18?"). Older editions stay in the cards (and in `comparison.alsoDeprecated`) but never reach the prompt; feeding four prior editions at once is what produced an answer claiming RP-8-25+E2 replaced RP-8-14.
- **Comparison grounding (client DO28):** the prompt forbids naming any section, annex, chapter, table, figure or page that does not appear verbatim in the retrieved excerpts, and forbids describing the standard's subject matter from prior knowledge. Both rules exist because the prompt's own illustrative locators ("Annex H", "Section 11.3.1") were being echoed back as findings, and an RP-9 (hospitality) comparison was answered with RP-29 (healthcare) content.
- **Comparison depth (client DO28):** the deprecated index is probed from several topical anchors — the top current excerpts, one per page — and the result window is spread across sections (`spreadAcrossSections`) so a long standard like RP-8 is sampled across chapters rather than within one.
- **Every edition gets a card (client DO42):** a comparison lists the current edition first, then EVERY indexed deprecated edition of the family newest → oldest, whether or not retrieval reached its pages (`loadFamilyEditions` + `addMissingEditionCards`). A card with no passage is still the fastest route to opening that edition for a manual comparison — the client's RP-8 search returned three deprecated cards and no current one at all.
- **"Current" comes from D1, not from the ranking (client DO43):** the current edition is the newest **Active** edition of the family (`comparisonFamily` → `loadFamilyEditions`), and it is what `buildComparisonContext` names and what the prompt is told to compare against. The result list is ranked by relevance, so its first entry is not reliably the current edition.
- **The current edition is probed directly (client DO43):** "what's new in …" is meta-phrasing that retrieves tables of contents, so when the ordinary search yields no current-edition prose, `ensureCurrentEditionExcerpts` fetches it with a `standard_code` filter anchored on the standard's own designation + title, spread across sections. Without it the analysis has one side of the comparison only.
- **Rosters are front matter (client DO43):** `looksLikeFrontMatter` also rejects contributor/acknowledgement/committee-roster pages, by heading and by name density. The reported failure was an RP-8 comparison answered from p. 6 of the prior edition — a contributors list.

### Content Types (search filter)

`filters.content_types` selects which KINDS of result a search returns. All are independent; `compare` is a modifier rather than a kind.

| Value | Result card | Source |
|---|---|---|
| `tables` | **Illuminance Table** | `applications` rows (D1) + application vectors |
| `body` | **Document** | prose chunks (`chunk_type` `text`/`general_notes`) |
| `references` | **Reference** | References/Bibliography entries (`chunk_type=reference`) |
| `definitions` | **Definition** | ANSI/IES LS-1 glossary (`chunk_type=definition` + `definitions` table) |
| `compare` | — | modifier: forces version-comparison handling |

The API default (no `content_types` sent) is `tables` + `body`, and a reference-seeking or definition-seeking query replaces that default automatically (`isReferenceQuery` / `isDefinitionQuery` in `query-expander.ts`); a caller who customized the filters keeps their choices and gets the detected kind added. **The UI is now a caller who always customizes:** since DO57 the search page begins with all four kinds selected and sends all four, so the auto-scoping no longer fires for it — an explicit selection is honoured as made. The demo searches under the search box each name every kind for that reason.

The UI label for each kind matches the filter label exactly — "Documents" filters for "Document" cards (client DO32; the label used to read "Document Body") — and each kind owns one border line style and one chip palette (`RESULT_TYPE_STYLES` in `index.html`).

A fifth `resultType`, **`standard`**, is not a filter value: it is the whole-document card a designation or title search returns (see below). It is a Document, so it borrows the `excerpt` label, line style and palette rather than owning a fifth one.

### Query language: interpret in English, answer in the user's language (client, 2026-09-01)

"Provide the AI Guide response in the same language the query was typed, but
'interpret it in English' for its response (and for the result card curation)
… (1) translate to English (2) provide response and card curation (3) translate
the AI Guide response back to their native language. Our standards will always
remain in English for accuracy." Implemented in `src/lib/language.ts`, wired in
`handleSearch`; `SEARCH_CACHE_SCHEMA` bumped to **v14**.

- **The whole pipeline runs on the English interpretation** (`searchQuery`),
  not just the Guide prompt: the embedding model is English-only, and every
  intent pattern — comparison phrasing, definition/reference auto-scoping,
  filter inference, the AHJ topics, the refusal list, the rerank, the refine
  prompt, the out-of-scope check, the no-results guidance — is English. That is
  what "interpret it in English" buys beyond citation quality: a Spanish
  "¿qué hay de nuevo en RP-8?" now IS a version comparison.
- **English queries pay nothing.** `looksNonEnglish` (non-Latin scripts, Latin
  diacritics, a compact non-English word list with English homographs like
  "pour"/"bureau"/"dove" deliberately absent) decides whether to spend the one
  small-model call that detects the language and translates the query in the
  same breath. Cache hits pay nothing either — the response cache is keyed on
  the RAW query and checked before detection runs.
- **The pre-check also recognizes ENGLISH, not just known non-English
  (2026-09-04, the client's Swahili test; `SEARCH_CACHE_SCHEMA` → v15).**
  "njia bora ya kuwasha mwangaza kwenye ofisi ni ipi?" is Latin script, has no
  diacritic and no word on the list, so it sailed through as "confidently
  English", was embedded raw by the English-only model, and retrieved LM-83 for
  an office-lighting question — under an answer that READ fine, because the
  Guide model understands Swahili even though the retriever does not (the tell:
  no "interpreted in English as …" meta line). Rather than adding languages to
  the list forever, `ENGLISH_WORDS` (function words + the domain's own
  vocabulary) now backstops it: a query of 2+ words where a third or fewer read
  as English spends the detection call. A false hit still costs only one
  small-model call answering "en"; a single unknown word with no other signal
  stays English (a lone word gives the detector nothing to judge a language by).
- **Fail-open everywhere, to exactly the pipeline that shipped before.** An
  unreadable detection, a bad language code, an empty translation, a
  translation that dropped a standard designation, or a "translation" that
  merely echoes the query all mean English. A translated ANSWER is likewise
  discarded (English ships) if it is implausibly short/long or lost a
  designation.
- **Only the AI Guide's text is translated back** (`localizeSummary`, after all
  the English sanitizers ran). Cards, excerpts, disclaimers, watermarks, the
  AHJ notice, the refine question and every fixed UI string stay English — the
  client's own rule is that the standards remain in English. Degraded fallbacks
  are never translated (they are never cached, and they are a bare list).
- **What must survive translation, because the UI links it:** designations
  verbatim, direct quotes and printed section titles in English, every section
  reference as "§N" and every page as "p. N" (the exact forms
  `LOCATOR_SCAN_RE` matches — "Section" is never translated into the target
  language), markdown structure line for line, the four comparison headings as
  `### ` lines, "Further reading:" as a one-line `**label:** …`. The English
  original travels on the summary as `textEnglish`, and **card curation
  extracts the Guide's citations from THAT** — the locator phrasing
  `extractGuideCitations` matches is English.
- **Caching:** the AI-summary key gained the detected language
  (`mode:style:lang`) because detection is a model's judgement and the same raw
  query can resolve differently across runs. A summary whose requested
  translation failed carries no `language` field, and that absence keeps both
  the summary and the whole response payload out of their caches — a transient
  translation failure is retried, never pinned for the TTL.
- **Transparency:** the payload carries `queryLanguage` + `queryEnglish` and the
  results meta line prints `· interpreted in English as "…"`, so a bad
  translation is visible to the reader instead of silently shaping the results.
  The Guide card sets `lang` on its text element for screen readers.
- **The refusal list now reads translations too:** `isRefusedQuery` runs a
  second time on the English interpretation, so a harmful question typed in
  another language is refused like an English one (the early English-pattern
  check still runs first, before any model call is spent).
- Known limits, deliberate: the refine question and no-results guidance are
  generated/written in English even for a non-English query (they act on the
  English search that actually ran), and the comparison advisory banner is a
  fixed English UI string.

### The DO089–DO097 round: a column that was never filled, and an edition that was live twice

The client's fourth round. Four UI items are small on their own; the three that
are not are all cases where the DATA was wrong in a way no amount of prompt or
CSS could reach — a schema column that had never held a value, a table's notes
attached to nothing, and two editions of one standard both flagged current.

- **The AI Guide folds after ~50 words, not after the first paragraph (DO089), on a pill (DO095).**
  `LEAD_WORD_BUDGET = 50`. The cut still lands on a BLOCK boundary, so an opening
  paragraph longer than the budget is split **while it is still plain text**:
  splitting the rendered HTML would risk cutting inside a link or a `<strong>`,
  which is why the fold was block-granular to begin with. `leadSentences` never
  halves a sentence — a first sentence longer than the whole budget is kept
  entire, which is what "approximately" buys. `foldAfter` is honoured only on a
  paragraph and otherwise falls back to the first one, i.e. exactly the previous
  rule. "Continue Reading" is now a bordered pill: as a bare blue label it "blends
  in to the appearance of all other hyperlinked standards", of which the Guide's
  prose is full.
- **`Class_of_Play` had been NULL in all 2,498 rows since the column existed (DO090).**
  The record was built from `parsed.classOfPlay`, which nothing ever produced —
  the schema's own comment ("I | II | III | IV (RP-6)") made it look as though
  RP-6 printed a per-row column. It does not: it prints a grouping LINE ("Tennis
  / Class I / Area of play …") that the hierarchy already captures, so the class
  is now read off the snapshot exactly the way the Lighting Zone is
  (`extractClassOfPlay`, deepest level first). The same numeral was also landing
  at the END of the leaf label, because `parsePrefixMarkers` only peels `[AT]` and
  `[LMH]` — production cards read "Target @ 18.3 m (60 ft) III" and "Shooting line
  IV". `stripTrailingClassNumeral` removes it **only when it matches the class the
  hierarchy already established**, so a label that legitimately ends in a numeral
  keeps it.
- **RP-43's "See Notes" is a column heading, not a cell (DO092).** "The 'See
  Notes' comment in RP-43 tables should be treated the same as a table footnote."
  The words appear nowhere in the data — 0 of RP-43-25's 226 rows store them.
  They head two of the Environmental and Visual columns, and the note numbers sit
  on their own line above: `5 6 7, 8, 9 10` → Glare 5, Uplight 6, Controls 7·8·9,
  Spectrum 10. **A comma binds within a column; a space opens the next** — that is
  the whole grouping rule, and why "7, 8, 9" is one column's three notes rather
  than three columns. `detectColumnNoteRefs` is anchored on the `APPLICATION
  TASK/AREA` line directly below it and refuses to read anything that does not
  yield exactly one group per column, because a partial reading would shift every
  note onto the wrong column silently. The numbers then join every row's refs,
  which is what pulls their TEXT into the notes disclosure — where the client
  asked for them to be defined. `FootnoteMarks.columns` records the mapping as
  provenance; nothing renders that key yet.
- **The highest `+E#` is the current edition (DO096).** RP-8-25+E1 and RP-8-25+E2
  are one edition printed twice, but both PDFs ship in the current folder, so both
  were ingested Active — and the AI Guide was citing two live standards where
  there is one. An edition carrying no marker is errata 0, so RP-8-25 is
  superseded by RP-8-25+E1; different YEARS are different base editions and are
  untouched (RP-8-22 is a prior edition by the ordinary folder rule, not by this
  one). Enforced at both ends: `findSupersededErrata` reclassifies the file before
  the ingest loop, and `findActiveSupersedingErrata` in the Worker relaxes the
  reaffirmed-printing guard **only because the superseding edition demonstrably
  exists** in D1. Measured on production: RP-8-25 is the only family in the corpus
  with two Active erratas, so this changes exactly one document today and prevents
  the next one silently.
- **"Further Reading" stops shouting (DO096).** The model writes the whole
  recommendation on ONE line — "Further reading: ANSI/IES RP-43-25 …, which
  provides guidance on …" — and the heading branch set the entire thing in bold
  display type, making the least important block on the card the loudest thing in
  it. Only the label stays bold now, on a smaller grey paragraph. Restricted to
  Further Reading on purpose: DO083's comparison headings stand alone on their
  line and genuinely ARE headings.
- **The table card invites the reader past the numbers (DO093).** An Illuminance
  Table card's disclosure reads "FROM THE STANDARD (browse relevant design
  considerations)". Table cards only — on a Document or Reference card the
  disclosure already holds prose, so the hint would say nothing.
- **One search bar at a time (DO097).** "Users found it confusing to see 2, with
  the same text." The floating bar now needs BOTH conditions — a search has run,
  AND the hero's own box has left the viewport — so scrolling back to the top
  hides it again. Watched with an `IntersectionObserver` rather than a scroll
  threshold, because the hero SHRINKS after the first search and any fixed pixel
  value would be wrong in one of the two states. No observer → the previous
  behaviour (appears after the first search). It is also drawn in the hero bar's
  own style, so it reads as that bar following the reader down rather than as a
  second one.

**Three Vectorize limits, measured 2026-08-29, that had made the orphan tool
unusable since it shipped.** `returnMetadata: 'all'` caps `topK` at **20** and the
scan cannot drop the metadata — `standard_id` is the only thing it reads — so at
100 every query threw and `/api/admin/scan-orphans` answered 500 **for its own
default**. `getByIds` caps at **20** IDs per call (25 throws) and `deleteByIds` at
**100** (200 throws): three different limits, so they cannot share a constant.
`enumerate-ids` now refuses a range needing more than 400 Vectorize calls up
front, naming the arithmetic, rather than half-answering into the subrequest
budget.

And the exclusion that matters more than any of them: **`LS-1-DEF-*` vectors have
no `standards` row by design** (DO33 — the definitions come from the ies.org
glossary REST collection, not from a PDF), so they matched the orphan test
exactly. The tool's happy path ends in a delete, and the one thing it pointed at
was the entire Definitions content type — 1,311 vectors. Recognised by BOTH the id
shape and `chunk_type === 'definition'`, because either alone is one rename away
from offering the glossary up for deletion again.

**What this round needs to take effect.** The UI items are live on deploy. The
three data items are not: `Class_of_Play`, the RP-43 column notes and the RP-8-25+E1
demotion are all written by the INGEST, so they appear only after `npm run ingest`
re-runs. The demotion is a deliberate production data change — one Active standard
becomes Deprecated — and should be run watching, not unattended.

### The 260820 feedback round, part two: restraint (DO080–DO088)

The second half of the same annotated document. Where part one was about not
printing what we cannot vouch for, this half is about not printing what nobody
asked for — an answer shaped to a template, a chip that repeats the banner beside
it, fifty cards for a question about zebras.

- **The AI Guide toggle belongs to the ACCOUNT (DO080).** `user_preferences`
  (migration 0014) keyed on the email from the `ies_auth` cookie, read through
  `GET /api/preferences` and written by `PUT`. localStorage is a MIRROR applied
  before the first paint so the toggle does not flash the default and flip a
  round-trip later; the server's copy wins. Only an explicit press saves — a demo
  search or a reset changes the state without the reader having chosen it — and
  `applyGuidePreference` refuses to switch it on for LensyLite, which has it
  locked off. Everything fails soft: no session (the staff bearer) answers `{}`
  and accepts a write as a no-op, and a missing table does the same.
- **Cards lost their duplicated furniture (DO081).** A Document or Reference card
  now reads document → chapter → passages: the designation and title come first,
  in bold, with the committee under them, then the chapter band. The page beside
  the title is gone — it is printed at the end of every passage — and inside a
  joined card (DO59) only the FIRST panel names the document; the rest open on
  their band with a designation chip. The Definition card lost its "DEFINITION"
  banner ("self-evident") and its "FROM THE STANDARD" heading with the repeated
  term ("it is clear that the text … is the definition"). An Illuminance Table
  card is untouched: its hierarchy is the application, and its page is the printed
  row's own, which nothing else on the card says.
- **A Table of Contents for every standard, free (DO082).** `outline_json`
  (migration 0015) is every heading in document order with its page, produced by
  the SAME page walk that finds the section titles — `extractOutline` is now the
  primary product and `extractSectionTitles` is derived from it, so the two cannot
  disagree. Served by `GET /api/standards/:id/outline`, gated on a session but NOT
  on a corpus tier ("even if the user is on LensyLite"), and rendered on the List
  Standards page as a per-standard disclosure that fetches on first open, indents
  by depth and links each entry to its page. Before a re-ingest it falls back to
  the section map — same headings, no pages — and says so on screen.
- **A comparison says how big the change is before saying what it is (DO083).**
  A new leading section, "Extent of the changes", classifies the substantive
  differences as Extensive / Moderate / Minimal, says why it matters, and GOVERNS
  the length from there (800–1200 / 500–1000 / 100–300 words, with the client's
  caps). "Substantive" is defined in the prompt in the client's own words, so
  renumbering and new figures do not count. Plus the reaffirmation rule, which is
  code rather than prompt: `baseEdition` strips `+E2` AND `(R2026)`, so
  TM-31-20(R26) is compared against TM-31-17 and never against TM-31-20 — the same
  edition reprinted. A family whose only prior edition is itself reaffirmed reports
  no comparison rather than inventing changes.
- **A regulated topic carries the AHJ disclaimer (DO084).** `needsAuthorityNotice`
  matches the client's seven topic families against the query AND against what
  retrieval returned — a "corridor lighting" question answered out of an egress
  section needs it too — and the UI renders the client's exact wording above the
  answer. Decided OUTSIDE the model on purpose: a disclaimer the model sometimes
  forgets is worse than none. The model is told it is there and told not to repeat
  it, it survives a degraded answer, and it is shown in its own banner when the
  reader has the Guide switched off. It deliberately ignores excerpt BODIES — half
  the corpus says "compliance" somewhere, and a notice on every search is a notice
  on none.
- **An out-of-scope question gets no citations, and a malevolent one gets nothing
  (DO085).** Two mechanisms. A weaponization or deliberate-harm question is
  refused by PATTERN before any retrieval, so it costs nothing and reaches neither
  Vectorize nor the model — "How can I use lighting fixtures to build a bomb?" was
  being answered with four paragraphs of IES citations and fifty cards. And a
  search that came back below the strong-match threshold — the same ~1-in-4
  population the refine prompt uses — gets one small-model question: could this be
  answered from lighting standards at all? A "no" clears the cards and the Guide
  and hands the reader the DO077 empty state with "restate the question". It runs
  BEFORE the 70B Guide, so an out-of-scope question never pays for one, and it
  fails OPEN in every direction: an error or an unreadable answer means in scope.
- **Tables and figures are findable by their captions (DO086).** The honest answer
  to "are they vectorized? is it multimodal?" is in `src/lib/document-assets.js`
  and repeated here: the embedding model is TEXT-ONLY, a table extracted as text
  IS indexed (as a `table` chunk the UI hides, because a raw grid dump repeats the
  data the card already shows), and a table or figure that is a RASTER IMAGE
  yields no text at all — no retrieval tuning will ever find its cells. What is
  always text is the CAPTION, which names the thing and carries a page. So
  `assets_json` (migration 0015) holds every "Table C-1 Sound Absorption
  Coefficients for Various Materials" with its page; a query's words are matched
  against captions on stemmed WORDS with a relevance floor; matches become chips
  on the card and lines in the AI prompt ("cite it by label and page; you cannot
  see its contents"). Measured on RP-1-24: Table C-1 is now the top match for both
  of the client's sound-coefficient phrasings, and "table of light loss factors" —
  a table that document does not have — correctly matches nothing. Until a
  re-ingest, captions are read out of the passages a search already retrieved.
- **The markers came off the top right (DO087).** No TM-24 chip ("a holdover from
  an old table format"), no Indoor/Outdoor chip ("already communicated by INTERIOR
  and EXTERIOR on the top left"). The eligibility still travels in the payload and
  the AI Guide still reads it; only the chip is gone.
- **The first sentence carries information (DO088).** The prompt forbids restating
  the question and names the two openings the client flagged as examples, and
  `stripOpeningFluff` removes one that slips through — a first sentence that
  matches a filler pattern AND cites nothing. The example the client marked GOOD
  ("Egress lighting refers to the illumination provided…") is a definition and
  stays; a sentence naming a standard is never removed.

**Two limits worth naming, because they will be noticed.**

1. **Page numbers are PDF indices, not printed folios.** RP-1-24's Table C-1 is on
   PDF page 71 and prints the folio "62" — the number the client cited. Every page
   in Lensy (excerpts, citations, asset chips, outline entries) is the PDF index,
   because that is what the Library viewer's `#page=N` needs to land on the right
   page. So the links are right and the numbers read low by the length of the front
   matter (9 pages for RP-1-24). Fixing it properly means extracting the printed
   folio per page at ingest and showing folio-plus-link — a new column and a change
   to every citation surface, deliberately not smuggled into this round.
2. **A caption that is a raster yields nothing.** Measured on RP-1-24: five table
   captions extract cleanly, but Table 2-1 (the ceiling-gradient table the client
   pointed at, "the table on page 18") and Table 4-1 (cited eight times in the
   document's own prose as its central glare table) produce no caption text at
   all. Neither can be found by caption, because there is no text to find. That is
   the multimodal boundary above, and the only fix is OCR or a vision model over
   the page images at ingest.
3. **A caption cut by a two-column page cannot always be rejoined.** The
   continuation join fixed the clean cases (Table 4-2 now reads "UGR Values and
   Corresponding Descriptive Glare Criteria" rather than stopping at
   "Descriptive"), but about two figure captions in three on RP-1-24 are cut
   mid-phrase — sometimes mid-word — because the next line on the page belongs to
   the OTHER column, not to the caption. The join refuses those on purpose rather
   than splicing two columns together. A truncated caption is still a usable
   locator; it is just a shorter match target.

### The 260820 feedback round: accuracy over completeness (DO062–DO079)

The client's third annotated round. Its organizing principle, stated by them for
formulae and applied here to locators as well: **when the extraction cannot be
trusted, say where to look instead of showing a wrong reconstruction.**

- **A locator we cannot vouch for is not printed (DO071).** `src/lib/section-titles.js`
  is the single set of rules for reading a heading, used at BOTH ends: the ingest
  writes clean numbers and titles, and `attachSectionTitles` re-checks whatever is
  already in `sections_json` so the corpus indexed before the rules existed stops
  printing the bad ones. Three reproduced causes, each with a measured fix:
  - LP-1-24 p. 77 prints "13.4 Light Distribution on Task Plane (Uniformity)"; its
    subsetted font drops the period, so the parser reads "13 4 …" — which
    `SECTION_RE` could not match at all, leaving every chunk on the page under the
    PREVIOUS section's number. `normalizeSectionNumber` restores the separator, and
    a `chapter` context disambiguates the one case the line cannot: inside chapter
    1, "11 4" is 1.1.4; inside chapter 13, "13 4" is 13.4.
  - LP-9-25 p. 68 is a two-column annex whose two headings share a baseline, so the
    line arrives as two headings plus body text under one number.
    `sanitizeSectionTitle` cuts at the second number, at a run-in sentence, and
    where Title Case gives way to the next column's prose; a heading printed over
    two lines is rejoined (display font at the same margin, or the run-in word
    before the body's first full stop).
  - A number the document cannot have printed ("131", "1810", "2025") is refused
    outright — `trustedSectionLabel` in the Worker clears it from the excerpt, so
    the card prints designation + citation with no locator rather than "§131".
  The space-separated reading is gated twice, because a table row looks exactly
  like a heading whose periods were eaten: it is not read on a page dense with
  numeric rows, and never when the "title" itself carries numbers ("10 20 Task
  Area 300 0.76" would otherwise stamp §10.20 onto the rest of the page — DO071
  recreated from the other side). A two-line heading likewise joins only when the
  first line reads UNFINISHED (it ends on a joining word or an adjective) and the
  next line does not open with a sentence word — without both, "4.2 Task Plane
  Lighting" followed by "Fig. 4 shows…" became "Task Plane Lighting Fig".
  Measured on the shipped PDFs: LP-1-24 `13.4` → "Light Distribution on Task Plane
  (Uniformity)", `1.1.4` → "Visual Comfort"; LP-9-25 `A.1.1.3` → "Regular Area With
  Single Row of Individual Luminaires", `Annex A` → "Field Measurements" — all four
  exactly as the client wrote them. Suspicious titles: LP-9-25 6 → 2, RP-43-25's
  bibliography artefact (`8` → "PMID: 16494083") gone. **The residue is LP-1-24's
  specification-outline appendix and the public-review comment form**, whose
  numbered cells are indistinguishable from headings without page-level layout.
- **A formula is named, never reproduced (DO072 / DO072a).** A PDF equation is a
  LAYOUT: pdfjs returns the fraction bar as a run of underscores and the numerator
  beside its denominator, so any text reconstruction is wrong.
  `src/lib/formula.js` detects one and `guardFormula` removes it from every excerpt
  as it leaves the Worker — one definition, so the same text reaches the card, the
  prompt and a saved collection.
  **The detector is deliberately narrow, and that is the whole design.** The only
  evidence it accepts is a fraction bar, or an assignment (`X =`, or `≡` beside a
  Greek symbol) together with a symbol. An earlier version also counted operators
  and Greek letters, which flagged ordinary IES sentences — "values are within
  ±10% of target, and ratios of ≥0.7 apply", "the luminous flux Φ, the wavelength
  λ … are defined in LS-1" — and the stripper then deleted the OPERATOR and kept
  the NUMBER, turning a criterion into a different criterion inside quotation
  marks attributed to the standard. An over-eager formula detector is worse than
  none. For the same reason the stripper is run-ANCHORED: a token is removed only
  as part of a run containing an anchor, and an ordinary word (three or more
  letters, nothing else) ends the run — which is what keeps "is used to
  approximate…" intact. The card prints "Formula not shown — open the
  standard in the Library to see it." beside whatever prose survived, and the
  passage stays in the list precisely because the reader needs the link to that
  page. The Guide is told a formula is there (`formulaOmitted`) but never shown
  one; `stripFormulasFromAnswer` removes any it writes anyway, keeping the
  sentence: "This formula, Φ… = …, is used to approximate" → "This formula is used
  to approximate", which is the client's own suggested wording.
- **One Document card per CHAPTER (DO073).** `groupSiblingResults` groups body
  excerpts by `chapter|<standard>|<chapter>` instead of by section, the blue band
  prints "Ch. 8 – Outdoor Lighting Design Process" (`chapterBannerLabel`), and each
  passage inside keeps its own section heading, page and Library link. The chapter
  and its printed title come from the server (`excerpt.chapter`), so a standard
  with no `sections_json` still groups and reads "Ch. 8". Order inside the card is
  RELEVANCE, not page — "shift highest-quality results to top while retaining
  visual relationship within a document/chapter" — which supersedes DO40's page
  sort. The card takes the position of its best member, so the best chapter leads.
- **"FROM THE STANDARD" is open, and looks pressable (DO070).** Readers did not
  recognize it as a drop-down: it now starts expanded, the caret is two static
  glyphs (down closed, up open) rather than one rotating one — "lose the animation"
  — and the summary is a bordered strip with a filled caret tile and a Show/Hide
  label. Nothing about what it contains changed.
- **A comparison is a chapter-grouped, bolded list (DO062).** The prompt's three
  fixed sections stay; inside each, findings are bullets grouped under their
  chapter, ordered by number, each opening with its section number AND printed
  title in bold plus the page in brackets. `max_tokens` 4000 → **6000**. The UI
  renders the nesting as one `<ul>` with indented hollow markers (one block, so the
  "Continue Reading" fold can never cut inside a list), and `boldLeadingLocator`
  bolds a locator the model left plain. `LOCATOR_SCAN_RE` now also links a section
  named at the END of a sentence ("see Section 6.2.") — the lookahead was refusing
  exactly the common case.
- **A reference chip prints the reference NUMBER (DO064).** The badge fell back to
  the match COUNT when the number could not be read, so a work LS-2-20 numbers 5
  was chipped "LS-2-20 1" — which reads as a reference number and made the link
  look wrong. It is now "#5", a count is marked "×N" and only when > 1, and the
  chip's page resolution gained a middle step: in-body marker map →
  **a page this search already retrieved that names the cited work**
  (`findCitingPageInExcerpts`, free — it scans chunk metadata retrieval already
  produced) → the bibliography page. The family match carries a digit boundary:
  without one, "RP-4" matches inside "RP-43-25" and the chip would claim a page
  that cites a different standard. A Reference card's primary button now says
  "Open cited standard", because "Open in Library" read as the CITING document —
  that link is the per-entry "p. 79 · Open in Library ↗", which is what the client
  asked to keep.
- **A search that IS a standard gets no Guide (DO075).** `findStandardLookupResults`
  answering at all *is* the test for "searches for a specific standard without any
  additional question" — it only fires on a whole-query designation or title — so
  it is awaited before the Guide is launched and clears `includeAISummary`. The
  response says `aiGuideSuppressed: 'standard_lookup'` and the UI stays silent
  instead of printing "the AI Guide could not generate a response". Suppressing
  AFTER the cache key is built is safe: the decision is a pure function of the
  query and the corpus, and the corpus is in the key via `dataVersion`.
- **An empty result set offers ways out (DO077).** `src/lib/no-results.ts` builds
  the guidance from the query and the filters that were actually applied — the
  client's example ("only Illuminance Tables selected" → "search document bodies
  too") is its first rule — plus a location reset, a one-word spelling correction
  against the LS-1 vocabulary (read from D1 only on this path), a rephrase hint
  and a way to reach a human. Each is a BUTTON that does the thing. Note the one
  suggestion that could NOT be a filter reset: a standard/zone scope is inferred
  from the QUERY (`inferFiltersFromQuery`), never sent by the UI, so resetting the
  filters would re-run the identical search — the button instead re-runs the query
  with the narrowing words removed (`stripScopeFromQuery`).
- **Compare Versions is one-shot (DO079).** `disarmCompare` clears it after the
  comparison it was armed for and re-stamps `lastSearchFiltersKey`, so closing the
  sidebar does not silently re-run the search as a non-comparison. It fires on
  `wasComparing || filterState.compare` — the second half is the path that
  actually caused the reported stickiness: "what's new in RP-8?" arms nothing up
  front, the WORKER recognizes the phrasing, and `renderResults` then arms the
  pill from `isVersionComparison`.
- **The Guide sizes its answer to the question (the round's opening Note).** The
  prompt no longer prescribes 3–5 paragraphs and a Further Reading section: it asks
  the model to decide first, explicitly permits ONE paragraph citing ONE standard,
  and permits a two-sentence "the standards do not cover this" (with
  Standards@ies.org) as a complete answer. `answerStyle` (`auto` | `brief` | `full`)
  is in the request and the cache key for a caller that wants to pin it; `brief`
  caps `max_tokens` at 700 as well as asking, because a cap is the one instruction
  a model cannot talk itself out of. No UI control yet.
- **The portal embed (DO076).** `src/frontend/embed.html` previews and hands over a
  **JavaScript-free** GET form (`docs/VITRIUM_EMBED.md`): submitting it opens
  `lensy.ies.org/?q=…` in a new tab, which the existing `?q=` deep link already
  runs. No JS and inline styles so it survives a header field that strips scripts;
  not an iframe, because `frame-ancestors 'none'` forbids one by design. The
  sign-in bounce preserves the query (`auth-gate.js` returns to path + search).
- **Clicks are recorded, not yet learned from (DO078).** Nothing could be learned
  because nothing was measured. `POST /api/events` → `search_events`
  (migration 0013) records which card was opened, from what position, whether it
  was the FIRST of that search, and which filters were engaged afterwards; the same
  privacy contract as `search_log` (no user id, no IP, no session). Exported at
  `GET /api/admin/search-events.csv`. Only a link that actually opens the Library
  is instrumented — a DOI or publisher link on a Reference card is not, or the row
  would credit the citing standard's page to a reader who left for doi.org. **`search.ts` does not read this table** —
  turning it into a click-through prior that breaks ties inside the existing score
  epsilon is the next step, and it needs weeks of rows before it is evidence rather
  than a guess.

**What each fix needs to take effect.** The Worker changes are live on deploy, but
three of them only reach their full value with more:
`SEARCH_CACHE_SCHEMA` is bumped to **v11** (prompts and result shape both changed),
migration **0013** must be applied before `/api/events` can store anything, and the
section-number fixes are *two-sided*: the Worker suppresses a bad number
immediately, but correct numbers and titles for LP-1-24-style documents come from
`extractSectionTitles`, so they appear only after `npm run ingest` re-runs.

### Cover images and descriptions come from the PORTAL, not from Vitrium (2026-08-24)

The Lighting Library portal serves every cover publicly:

```
https://lighting.ies.org/api/portal/ies/Thumbnail?externalKey=<LatestVersionId>
```

200 `image/png`, **no credential** — so the URL goes straight into an `<img>`; no Worker proxy, no API key, no reader session. `lighting.ies.org` is in `img-src` (it was not before), and every cover carries a delegated `error` handler so a bad key degrades to the "No cover" placeholder instead of a broken-image icon.

**The trap that cost a round of debugging:** that `externalKey` is the portal's **`LatestVersionId`**, NOT the "External Key" column in Vitrium's export. They are different identifiers sharing a name. Measured across the whole 2026-08-24 export, in which 108 of 113 current standards carry a Vitrium External Key: **every one answers 404**, while a portal key answers 200. Vitrium's Doc ID, Folder ID, Doc Code and the viewer short code all 404 too, and the endpoint ignores every parameter name except `externalKey` (unknown names return `null`). `sync-metadata.js` therefore refuses to build cover URLs from the Vitrium column and prints a warning naming the confusion.

The portal's own document list (`PortalDocuments` JSON, saved at `scripts/data/portal-documents.json`) is the source, joined onto the CSV export by **Doc Code** — 274/274 rows matched. It supplies the three things Vitrium's export does not carry:

| Portal field | Column | Coverage (113 current) |
|---|---|---|
| `LatestVersionId` → cover URL | `thumbnail_url` | 113 |
| `Description` | `description` | 79 |
| `Authors` | `author` | 112 |

Run as `node scripts/sync-metadata.js --csv <export.csv> --portal scripts/data/portal-documents.json`. Synced 2026-08-24: covers 1 → **111**, descriptions 0 → **79**, committees 110 → **112**. (111 not 113: `LS-1` is the definitions source and has no Vitrium PDF, and `RP-8-25+E1` is a stale Active row superseded by `+E2` — it appears in no export.)

`author` is written with `COALESCE`, never overwritten: the committee is transcribed from each PDF's cover at ingest (DO29/DO46) for 110 standards, and the portal's field fills the gaps rather than replacing a reading of the document itself. `description` and `thumbnail_url` are plain overwrites — the portal is their only source.

### The 2026-08-24 wireframe round: Library Tools, a docked sidebar, and every result

The client's second annotated round. Mostly UI, with four backend changes.

- **`Library Tools`** collapses Browse Your Lighting Library + Compare Versions + List Standards into one banner drop-down left of the account menu (the icon is a placeholder the client flagged as undecided). **Advanced Search** is a link under the search box, before the first search only: it opens the Contents checkboxes inline, in the wireframe's two-column layout. After a search the sidebar owns those controls and the link steps aside. A content kind therefore has TWO controls, so `pillsFor()` paints every element carrying that `data-filter` — a single `querySelector` left the hero panel stale.
- **The Sort/Filter sidebar is dynamic and docks itself.** It appears only after a search ("don't display until after search"), and on a screen ≥1280px it **begins open, undimmed**: no backdrop, no scroll lock, `body.sidebar-docked` shifts the content clear of it while the gold header stays full-width and overlaid, as drawn. Narrow screens keep the modal overlay. "View Results" is now **Apply** (a docked panel applies without closing). Its Documents lists (Publication Type / Title / Technical Committee) are derived from the CURRENT RESULTS with per-entry counts, and a group with nothing in the results is hidden outright. The `Narrow to:` chip row is gone — the sidebar replaced it.
- **Every result is returned, with the weak ones folded away.** `MAX_LIMIT` 50 → 200 and the response carries `confidenceThreshold` (the same `STRONG_MATCH_THRESHOLD` the advisory banner uses). Under the Relevance sort the UI splits the pool there and prints a read-more bar — "View N low-confidence matches"; other sorts do not split, since "weaker below" would be a lie when the list is not ranked. A whole-document card counts as confident whatever it scored. This is everything RETRIEVAL produced, not the whole library: Vectorize still answers with topK=50, which the pipeline expands.
- **The AI Guide folds after its first paragraph** ("Continue Reading"). The fold cuts on a block boundary and always carries a heading into the lead, so it never opens on a bare label. Everything is in the DOM from the start — the copy guard and print withholding are unchanged.
- **The Guide's locators link to chapters.** New `sectionLinks` (per standard: section → URL, page → URL, built by `buildSectionLinkMap` from retrieval alone) lets the UI hyperlink "§4.2" / "p. 21" as well as the designation, attributing each locator to the most recently named standard. Fail-closed: a locator retrieval never reached stays plain text.
- **A comparison shows document cards only** (client: "no other search result cards"). Stripped AFTER the AI runs — the analysis is written from those passages — and never to an empty list: if the family resolved no edition cards, the passages stay rather than leaving a written analysis over "No results found". The link maps are built pre-strip, so the Guide's citations still resolve. The hero's compare hint is deleted.
- **The refine prompt is AI-written and rarer.** `generateRefinePrompt` (`src/lib/refine.ts`) returns `{question, terms}` — a ≤10-word follow-up plus its own suggested answers, with designations rejected by the parser (the old chips came from `application.category`, which for an excerpt card IS the designation). Gated on the server's `noStrongMatch` alone; the "broad pool" heuristic is gone, since it fired far more often than the client's "1 in 4". Runs parallel to the Guide, so it costs no wall-clock time.
- **List Standards** groups by authoring committee only (alphabetical, then alphanumeric by designation), drops "## pages indexed" and the per-row Search button, and renames Read → **Open in Library**. The webstore Category level is gone.
- **"Save Search" is "Bookmark" everywhere** — cards ("+ Bookmark" / "Bookmark Again"), the modal, the bulk action, and the collections page ("My Bookmark Collections", "New Bookmark Collection"). The `save-search-btn` class and the `/api/projects` payloads are untouched.
- Also removed: the results-header **print** button (Ctrl/Cmd-P and its excerpt withholding remain).

### The 2026-08-20 wireframe round moved every control (UI only)

The client's annotated wireframes reorganized the search page chrome. **`filterState` and what reaches the API did not change** — the same `guide`/`compare`/content-kind booleans travel exactly as before; only their CONTROLS moved. All existing tier locks (DO53) still apply to the relocated controls, because everything still carries `data-filter`.

- **Gold banner on every page**: Browse Your Lighting Library (opens `lighting.ies.org`), **Compare Versions** (formerly Compare Documents — now opens a floating window with its own input; the window arms `compare` and runs `buildCompareQuery(designation)`, the demo search's phrasing), **List Standards** (formerly Table of Contents, page heading renamed too), and a hamburger **account menu**: signed-in email, tier name, the **AI Guide toggle** (moved out of the search box; menu item reads "Disable/Enable AI Guide"), **My Bookmarks** (formerly Saved Searches, → projects.html), Subscribe (lite only), Sign out. auth-gate's appended chip is CSS-hidden on index only; the menu copies its logout href.
- **White hero** with the circular Lensy/LensyLite mark (`#wordmark` still lives there, so `applyTier` is unchanged in contract) and the search box with the gold Search button. Placeholder: "Type a topic or ask a question".
- **The content filters left the hero for a Sort/Filter sidebar**, opened from a floating trigger anchored top-left. Contents checkboxes = the same four kinds (labels per wireframe: "Document Body", "Definitions (ANSI/IES LS-1)", "References", "Illuminance Tables"); Interior/Exterior are permanent nested checkboxes and the Illuminance Tables row is their PARENT (toggling the kind switches both; the old click-to-open `location-menu` is gone). "View Results"/backdrop/Escape all APPLY: content-kind or Interior/Exterior changes re-run the search (compared against `lastSearchFiltersKey`), everything else re-renders locally.
- **Sort** (client-side reorder of the same pool): Relevance (default = API order), Date (`editionYearOf` off the designation), Title, Designation (numeric-aware), Technical Committee; asc/desc; un-sortable results always land last.
- **Documents narrowing** (client-side, all-selected = inactive): Publication Type (prefix of the designation), Title (matches by FAMILY via `familyOf`, so deprecated comparison editions stay with their standard), Technical Committee. Lists fill from `/api/standards` (fetched on `lensy:auth`), falling back to the current result set. Counts follow the wireframe: Contents shows its selected count, Documents groups show 0 unless actually narrowing, FILTER/trigger badge is the sum.
- **Standard-name auto-suggest** in the search box: ≥3 typed chars matching a designation or title offer up to 5 standards; clicking runs the designation search (→ DO47 whole-document card).
- **Refine your search overlay**: after results render, if `noStrongMatch` or the pool is broad (≥20 results across ≥5 standards), one brief follow-up with clickable terms drawn from the result categories; "No thanks" is remembered per query. Never on comparisons.
- **Cream footer** ("Lensy — IES Assistant").
- Wireframe items needing backend support, left as UI-only best effort: the Compare Versions suggestion list cannot yet be limited to standards WITH a previous edition (the index doesn't say), and the refine prompt's question is generic rather than query-aware.

### The search UI is one row of content filters (client DO57) — superseded by the 2026-08-20 wireframes above; the filterState contract described here still holds

"Refine search UI / Simplify UI." The filter section holds content KINDS and nothing else; the two tools that are not kinds moved to where they are used.

- **AI Guide** is a toggle inside the search box, modelled on the Google search UI the client named. **Compare Documents** is a button in the top banner, beside Saved Searches and the Table of Contents; while it is armed the hero prints a hint, because the header is not where a reader looks for state. Both still travel in `filterState` and reach the API exactly as before — only their controls moved. (DO58 is expected to redefine what Compare Documents *does*; this change moved it, it did not redesign it.)
- **All four content kinds start selected and any combination is allowed** — nothing in the row locks anything else any more. Document Comparison used to disable the whole row; it no longer does.
- **Illuminance Tables is a multi-select.** Its pill opens a panel holding Interior Applications and Exterior Applications, and the `tables` kind is DERIVED from them: clearing both excludes Illuminance Table results altogether. `alignTablesSelection` holds that invariant in both directions whenever the state is set from outside the panel (a demo search, a reset, or the content types the backend reports).
- The Search button stayed, though the client's wireframe omits it: Enter alone is not a discoverable way to submit a search.

### The AI Guide is on by default (client, 2026-08-14)

"AI guide will now be on by default." `DEFAULT_FILTER_STATE.guide` is `true`, the toggle is painted pressed in the markup so the first paint matches the state a search will run with, and all four demo searches leave it on — a demo that silently un-pressed the toggle would read as the control breaking.

What it changes and what it does not:

- **Nothing about retrieval, scoring or ordering.** `includeAISummary` reaches only the response-cache key and the LensyLite check; `runSingleSearch` never sees it. The Guide is handed the top 8 results AFTER they are selected and ordered, so the flow is cards → Guide and never the reverse.
- **Every uncached search now waits for a 70B generation**, because the AI runs inside the same `Promise.all` the response awaits. The KV summary cache absorbs repeats (keyed by mode + query + top-5 result codes), but a cold query is slower for everyone now, not only for the users who asked for an answer.
- **The API default stays `false`** (`body.includeAISummary === true`), so ingest, the verification harness and the Phase 5 external API are unaffected. This is a UI default, not a protocol change.
- **LensyLite still has it locked off** — `normalizeForTier` clears `guide` on every state replacement and `handleSearch` forces `includeAISummary = false` for tier `lite`, so the new default cannot spend the AI budget on a tier that does not include it.
- `aiGuideRequiredNotice` (version comparison run without the Guide) now fires only when a user deliberately turns the toggle off.

**The mismatch this made visible — now closed by AI curation (below).** The Guide reads better than the first few cards for structural reasons — it receives up to 3 passages per result (the ones collapsed behind "From the Standard"), it sees 8 results at once and may answer from the 6th, table rows reach the top partly on sheer volume of application vectors rather than on fit, and the 0.01 tie epsilon clusters sibling rows so the top cards are often four variants of one row. Since 2026-08-20 the Guide's citations feed BACK into card ranking, and a parallel AI pass curates the rest of the pool.

### AI curation of the card order (client, 2026-08-20)

"The cards' selection and priority heavily influenced by the logic used by the AI Guide (promote the cards the Guide actually cites) … have the rest of the cards also curated by the same logic … If they disable 'AI Guide' then they lose that curation." Implemented in `src/lib/curation.ts`, wired in `handleSearch`.

- **Two signals.** (1) `rerankResults` — a second AI pass over compact one-line descriptors of the WHOLE pool (up to 40 results, not the Guide's 8) returns a best-first order; it runs **inside the same `Promise.all` as the Guide**, and its output is a short JSON array while the Guide writes paragraphs, so it adds no wall-clock time. (2) `extractGuideCitations` — a result is "cited" when the Guide's text names its standard's designation AND one of its own locators (§section or p. N); a designation named with no matchable locator promotes that standard's best-ranked card. Cited results carry `citedByGuide: true` and the UI badges them "Cited by AI Guide" (gold chip).
- **Final order:** `[definition term-matches] [Guide-cited, capped at 12] [rest]`, the rerank order deciding sequence within each band. The definition pin preserves DO33 ("a search for 'Color' must return the color definition"); whole-document cards (DO47) are prepended AFTER curation so a named standard still lands on top. Overflow past the promotion cap keeps the badge but stays in ranked position.
- **Gating is the point:** curation exists only when `includeAISummary` is true (Guide off → the plain vector ranking, by design), never on version comparisons (their order is its own client spec, DO27/DO42), and a **degraded** Guide contributes no citations — its fallback text is a bare list of every standard in the result set, which would "cite" everything. Everything is fail-open: a rerank that errors or returns garbage yields the un-curated order.
- **Response:** `curation: { applied, reranked, promoted } | null`. The UI appends "· ordered by the AI Guide" to the results meta and relabels the sidebar sort option "Relevance — AI curated (Default)". The response cache key already contains `includeAISummary`, so curated and un-curated answers never share an entry; the rerank has no KV cache of its own (the response cache absorbs repeats — a cached payload whose rerank had failed simply stays un-reranked until TTL).

### Result cards from one document are joined (client DO59)

Adjacent Document cards of the same standard render inside ONE shell, each section keeping its own banner, designation, citation, committee credit and "From the Standard" list — the join is the container, not a merge, so nothing a single card said is lost. Only *adjacent* groups join, so the relevance order of the list is untouched, and deprecated editions never join: on a version comparison each edition is its own card with its own amber notice.

`renderResultCard(group, index, { nested: true })` renders the panel form (no outer article shadow, no left stripe — the container carries it); the panel is still an `<article>` because the footnote-marker and copy-guard handlers walk up to the nearest one to find "this card's" notes and citation.

### "FROM THE STANDARD" is bold black (client DO60)

The disclosure that reveals the standard's own words is the most important control on a card, so its heading and passage count are set in bold black rather than the small grey the rest of the card metadata uses. Same treatment on the Definition card.

### "+ Save Again" for a result already filed (client DO61)

A Save Search button whose result is already in one of the user's collections reads **Save Again** in a desaturated fill. Saving again is still allowed — the same passage legitimately belongs to more than one collection, and the server's duplicate guard is per collection.

`POST /api/projects/saved-status` answers it: the page sends the same save payloads `saveSearches` takes, and the Worker derives each item's identity with the very function that de-duplicates a save (`normalizeSavedItem` → `syntheticItemCode`), so the button can never disagree with what the save endpoint would do. It returns one boolean per item and nothing else — no titles, no collection names, no ids — across every collection the user owns. The call is fired after the results render and its failure is silent: a missed answer just leaves the button reading "Save Search". The client-side identity (`savedResultKey`) is derived from the RESULT, not the payload, so the key built while rendering a card and the key built while asking the server always match.

### Whole-document cards (client DO47)

A search whose WHOLE query is a standard's designation or title returns that standard itself, at the top of the results — before this, "RP-3-20" returned nothing at all, because a bare designation matches no prose and is not an application name.

- `parseDesignationQuery` accepts every variation the client listed: `RP-3`, `RP-03`, `RP-3-20`, `RP-03-20`, `RP-3-20+E1`, `RP-03-20 E1`, with or without an `ANSI/IES` prefix or an `(R2023)` reaffirmation marker. A family without an edition resolves to the current edition; an edition IES no longer publishes resolves to the current one as a *close* match (score < 1).
- A title lookup requires the query to be a close match to the title with its series preamble removed ("Lighting Educational Facilities" → *Recommended Practice: Lighting Educational Facilities*), and is skipped for anything shaped like a question.
- The card carries the same metadata as the Table of Contents — thumbnail, Vitrium content description, hyperlinked authoring committee, Read/Buy — and prints the full designation + title (client DO45).
- Deprecated editions never answer a lookup. The same builder (`buildDocumentResult`) produces the per-edition cards a version comparison adds, and those ARE flagged deprecated.
- Gated on the Documents pill: a whole standard is a Document, so a search narrowed to Definitions or References does not get one.

### Document titles come off the cover (client DO48)

A search for "office" returned RP-1-24 titled *Lighting Design for Commercial Interiors*; its cover reads **Recommended Practice: Lighting Office Spaces**. The chain behind that: the PDF `/Title` metadata is empty for the entire corpus → the ingest wrote `standards.title = <id>` → `fetchStandardsIndex` fell through to the curated list in `src/config/standards-schema.json`, whose entry was a guess.

- `src/lib/cover-title.js` reads page 1: the designation line, then the all-caps title block above the "AN AMERICAN NATIONAL STANDARD" boilerplate, title-cased (minor words, acronyms, and bracketed acronyms preserved). It also reads "Prepared by the … Committee" for the authoring credit (DO29), which the Vitrium export has not supplied yet.
- The covers are set in a subsetted font whose punctuation lands on C0 control code points — `LP<1F>2<1F>20` is `LP-2-20` — and **which character a code stands for is decided by the subset, so it differs per document and the codes collide**: on RP-44-21 U+001F is `(` and U+001E is `)`, while on every LM cover U+001F is `-` and the bracket pair is U+001E…U+001D. A fixed mapping cannot serve both; read with RP-44-21's rule, `LM-47-20(R2023)` came out `LM-47(20)R2023-` and `DISCHARGE (HID) LAMPS` came out `DISCHARGE -HID- LAMPS`. So the cover teaches us its own font: `inferHyphenGlyph` reads the separators inside the designation line — which are hyphens by definition, since a designation is `LM-9-20` — and once the hyphen code is known every OTHER control code on that cover is free to be a bracket. A cover printing real punctuation (most of the corpus) learns nothing and keeps the original U+001F…U+001E rule.
- `TITLE_STOP_RE` stops the title block at the approval stamp, but **the entire LM series titles itself "APPROVED METHOD: …"**, so the stop fired on the title's own first line and 40-odd Lighting Measurements standards fell back to showing their bare id. The stop now carries a `(?!\s+method)` lookahead.
- Measured on the current corpus: **110 of 113** standards yield a title, a designation and a committee. The three that do not are scanned-image covers that yield no page-1 text at all (LM-75-19, RP-39-19, TM-34-19).
- The ingest upsert refreshes `title` only when it has a real one (`excluded.title <> standards.id`), so a standard whose cover cannot be read keeps whatever was synced rather than being reset to its id.
- The curated fallback list is now transcribed from those covers and is documented as a last resort — never a guess. It matters only for a standard that has not been re-ingested.

### A vector's excerpt is cut on a character boundary

`excerpt_text` is truncated to its budget with `substring`, which counts UTF-16 code units: a cut landing inside a surrogate pair keeps the high half and orphans the low one. A lone surrogate has no UTF-8 encoding — it survives `JSON.stringify` as a `"\ud835"` escape and Vectorize rejects **the whole upsert batch** decoding it (`VECTOR_UPSERT_ERROR (code = 40023): failed to parse upsert vectors request in json format`), which reaches the ingest script as a bare 500 naming neither the document nor the chunk.

Found on TM-31-20, the one standard of the Lighting Measurements batch that would not index: it writes its math in astral code points (𝐫 = U+1D42B, 𝛌 = U+1D6CC — 981 of them) and on p. 64 one sat astride the 500-character budget. `excerptText()` in `src/workers/ingest.ts` drops the orphaned half, at a cost of one character of one excerpt; all three metadata sites (chunks, definitions, applications) go through it.

### Library links open on lighting.ies.org, never on Vitrium's host

Vitrium's document export gives each standard an opaque short code on Vitrium's OWN viewer host (`https://view.protectedpdf.com/2H4QTw#page=43`), and that is what `standards.vitrium_web_url` stores. Handing it to a reader fails twice: the IES Lighting Library session lives on `lighting.ies.org`, so the reader meets a Vitrium auth error, and after signing in the standard opens at page 1 — a `#page=N` fragment is never sent to a server, so it does not survive the sign-in bounce. The branded host serves the same short codes, so the fix is a host swap with path, query and fragment carried across verbatim (`toLibraryUrl` in `src/lib/library-url.js`).

- Applied on the way OUT, at the few places a URL is read from D1 — `fetchStandardsIndex` and `selectStandardRows` (every search card, reference chip, AI-Guide citation link and application deep link is built from those two), `/api/standards` for the Table of Contents, and the saved-collection reads. Rows already stored with Vitrium's host are therefore corrected without a data migration, and the export stays the source of truth.
- Also applied on the way IN for saved items (`normalizeSavedItem`), so a newly filed collection row holds the link in the form the reader should open. It is not part of the dedupe identity (`syntheticItemCode` ignores the URL), so nothing already saved changes code.
- Any other link — a DOI, an ies.org glossary page, a Buy URL, an already-branded link — passes through untouched, which is why the rewrite is safe to apply to any link-shaped column.

### Access tiers: Lensy and LensyLite (client DO53)

| Who | Tier | Gets |
|---|---|---|
| Lighting Library subscriber | `full` | everything |
| IES member, no subscription | `lite` | the Lighting Science collection; Illuminance Tables, AI Guide and Document Comparison are shown locked |
| invited guest | whatever `invited_users.tier` says | see below |
| any other IES account | `none` | a collection someone shared with them, nothing else |

- **ON since 2026-08-12.** The subscription signal now exists: Wicket files Lighting Library purchases as person memberships with `membership_category='subscription'`, the AuthIES import slugifies the tier name into `users.roles_json`, and that rides the `ies_auth` cookie. `LENSY_SUBSCRIBER_ROLES="lighting-library-full-access"` names it — the slug of the Wicket tier, kept in a var because that name is editable in the client's admin. Measured that day: 546 hold it, 7,552 members do not.
- **Turning it on took access from nobody**, which is why it could be done without a rollout: the five `invited_users` rows are all `admin`/`staff`, and the only four accounts that had ever set an IdP password were those same admins, all four also holding the subscription. Everyone else was still `pending` at the IdP and could not sign in at all. Leaving it off was the actual risk — with `is_member` freshly populated and `ALLOW_MEMBERS_WITHOUT_INVITE` true, every member who activated would have landed on full Lensy.
- **The door no longer turns anyone away** (2026-08-12). `decideAccess` has no `not_invited` denial: any account the IdP authenticated reaches Lensy. It was the only thing keeping the 119 people who hold a Lighting Library subscription WITHOUT an IES membership out of the product they pay for — `resolveTier` called them `full` while the door bounced them, two halves of the same codebase disagreeing about the same person. `ALLOW_MEMBERS_WITHOUT_INVITE="false"` restores the invite-only door and is now the kill switch for exactly that.
- **Which is why `requireCorpusAccess` exists** (`workers/session.ts`). `handleSearch` looks only for `lite`, so before the door opened, tier `none` was enforced by nothing but `decideAccess` refusing entry — a `none` request that reached search would have been served as `full`. Opening the door without this check would have handed the whole Lighting Library to all 65,945 accounts. `/api/search` now requires `lite` or better; `/api/applications` requires `full`, since the raw illuminance dataset IS the Illuminance Tables content that LensyLite excludes and nothing in `src/frontend` calls that route. Both answer `403 {error:'subscription_required', tier}`. A `none` visitor still reaches the app and any collection shared with them (DO52) — they just get no corpus.
- **An invitation is a grant in its own right** (migration 0012). `invited_users.tier` (`full` | `lite`) is what the row grants, independent of IES membership, Wicket roles or any subscription — that is the point of an allowlist, reaching people the directory does not know. It can only ever ADD access: `resolveTier` takes the higher of the invitation and what the person earns, so a `lite` invite cannot demote a Library subscriber. `role` now decides admin rights and nothing else. Before this, tier came from `role` via `FULL_ACCESS_INVITE_ROLES = {admin, staff, subscriber}`, which meant a plain `guest` — the schema's own default — matched no rule and resolved to `none`: invited in, shown nothing.
- **Two subscriber cohorts are still unmapped, and it is a product question for IES.** The narrower Wicket products do not grant `full`, so their holders land on `lite`: "The Illuminance Selector" (205 people) are paying for exactly the tool Lensy replaces, yet `lite` is the one tier that LOCKS Illuminance Tables; and a "Lighting Science Collection" subscriber (3) gets on `lite` precisely the collection they bought, free to every member. Nobody is harmed yet — none has activated a password. `src/lib/tiers.test.js` fails first if the mapping changes.
- The rule is a pure function (`resolveTier` in `src/lib/tiers.ts`); `resolveRequestTier` in `workers/session.ts` applies it to a request, and the bearer secret is always `full` so ingest and the verification harness see the whole corpus.
- Enforced server-side in `handleSearch`: content types are stripped (`liteContentTypes`), `includeAISummary` is forced off, version comparison is disabled, and results are restricted to the Lighting Science collection (`standards.collection`, falling back to the `LS-` series until that metadata is synced). The locked pills are signposting; this is the boundary. The tier is part of the response-cache key.

### A shared collection opens without an account (client DO52)

`GET /api/projects/shared/:token` is the one route outside the session gate, and `projects.html` carries `data-public-when-share` so the page renders for a signed-out visitor arriving on a share link. Everything else under `/api/projects` — including claiming the collection into an account — still requires a session. What a link discloses is citations, pages, Library URLs and the sender's notes; a saved item holds no excerpt text or illuminance values by construction (`src/lib/collections.js`). The shared view is read-only: the owner's share/email/export/delete actions and the editable notes are hidden (DO49).

### Section titles on body excerpts (client DO40)

Every body excerpt is headed by its section number and title, with the parent chain above it — "3.3.4 Design Guide › Transition Spaces Between Exterior and Interior Spaces › Circulation Areas" — and excerpts from the same section of the same document render as ONE card.

- A chunk's Vectorize metadata carries only its own section NUMBER, so the titles are a per-document map: `extractSectionTitles` (in `chunker.js`) builds `{ "3.3.4": "Circulation Areas" }` at ingest, the ingest stores it in `standards.sections_json` (migration 0011), and `attachSectionTitles` resolves it at query time for the standards actually in a result set — never for the whole corpus, which would be far too much to load per search.
- It runs BEFORE the AI Guide, so the model can name a chapter by its printed title without breaching the DO28 grounding rule.
- Table-of-contents pages are skipped during extraction (their entries have the same shape as headings but carry a page number), and a heading's title must open with a capital — that is what separates "3.3.4 Circulation Areas" from "300 lux at 0.76 m".
- Degrades cleanly: a standard ingested before migration 0011 prints the section number alone, exactly as before.

### LS-1 Definitions (client DO33)

The definitions are published at <https://ies.org/standards/definitions/>, a WordPress `glossary` custom post type, so `scripts/ingest-definitions.js` reads the REST collection rather than scraping the A–Z index. Each definition becomes a `definitions` row (sanitized rich text, printed IN FULL on the card, may include emphasis, inline math and figures) plus one main-index vector.

- Every Definition card is titled with the current LS-1 designation regardless of whether LS-1 itself is indexed as a PDF.
- Retrieval unions an exact/prefix term match in D1 with the semantic match, and the term match always outranks it — a search for "Color" must return the `color` definition, not whichever definition mentions colour most.
- The client expects this source to move into Vitrium as a normal PDF around late 2027. At that point the normal ingest path replaces the script; the `chunk_type=definition` and `definitions`-table contracts stay as they are.
- `img-src` in `src/frontend/_headers` allows `ies.org` so definition figures render; the HTML itself is sanitized to an allowlist server-side in `src/lib/definitions.js`.

The Cloudflare stack provides:
- **Global edge deployment** for low latency
- **Cost-effective scaling** (pay-per-use, no idle costs)
- **Integrated AI/ML** (Workers AI for embeddings, no external service needed)
- **Simplified operations** (no server management, automatic scaling)
