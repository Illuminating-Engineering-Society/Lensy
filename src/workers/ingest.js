/**
 * Lucius Ingest Worker
 * Handles PDF ingestion: SharePoint/R2 → parse → embed → Vectorize + D1.
 *
 * Triggered by:
 *   POST /api/ingest  { pdfUrl, standardId, sourceType }
 *   sourceType: 'sharepoint' | 'r2' | 'upload'
 *
 * For the applications database (68-column CSV):
 *   POST /api/ingest/applications  { csv: "<base64>" }
 *   This embeds all 134 application records into Vectorize.
 */

import { parsePDF } from '../lib/pdf-parser.js';
import { extractTables } from '../lib/table-extractor.js';
import { generateEmbeddings } from '../lib/embeddings.js';

const CHUNK_SIZE_TOKENS = 500;
const TOKENS_PER_WORD = 1.3; // rough estimate

export async function handleIngest(request, env) {
  const url = new URL(request.url);
  const subPath = url.pathname.replace('/api/ingest', '');

  if (subPath === '/applications') {
    return ingestApplications(request, env);
  }

  return ingestPDF(request, env);
}

// ─── PDF Ingestion ─────────────────────────────────────────────────────────────

async function ingestPDF(request, env) {
  const { pdfUrl, standardId, sourceType = 'sharepoint' } = await request.json();

  if (!standardId) {
    return jsonResponse({ error: 'standardId is required' }, 400);
  }

  // 1. Fetch PDF bytes
  let pdfBytes;
  if (sourceType === 'r2') {
    const obj = await env.PDFS.get(`standards/${standardId}.pdf`);
    if (!obj) return jsonResponse({ error: 'PDF not found in R2' }, 404);
    pdfBytes = await obj.arrayBuffer();
  } else if (sourceType === 'sharepoint' && pdfUrl) {
    const response = await fetch(pdfUrl, {
      headers: { Authorization: `Bearer ${env.SHAREPOINT_TOKEN}` },
    });
    if (!response.ok) {
      return jsonResponse({ error: `Failed to fetch PDF: ${response.status}` }, 502);
    }
    pdfBytes = await response.arrayBuffer();
    // Cache in R2
    await env.PDFS.put(`standards/${standardId}.pdf`, pdfBytes);
  } else {
    return jsonResponse({ error: 'Provide pdfUrl with sourceType=sharepoint or sourceType=r2' }, 400);
  }

  // 2. Parse PDF
  const { text, metadata, pages } = await parsePDF(pdfBytes);

  // 3. Extract illuminance tables
  const tables = await extractTables(pdfBytes, pages);

  // 4. Chunk text for embeddings
  const chunks = chunkText(text, pages, CHUNK_SIZE_TOKENS);

  // 5. Generate embeddings (batched)
  const embeddings = await generateEmbeddings(env.AI, chunks);

  // 6. Upsert into Vectorize
  const vectors = chunks.map((chunk, i) => ({
    id: `${standardId}-chunk-${i}`,
    values: embeddings[i],
    metadata: {
      standard_id: standardId,
      application_code: null,       // null for PDF chunks (not application rows)
      page_number: chunk.pageNumber,
      excerpt_text: chunk.text.substring(0, 300), // truncate for metadata size limit
      chunk_type: chunk.type,       // 'text' | 'table' | 'figure'
      indoor_outdoor: null,
      standard_code: standardId,
    },
  }));

  // Vectorize has a 1000-vector upsert limit per call
  for (let i = 0; i < vectors.length; i += 1000) {
    await env.VECTORIZE.upsert(vectors.slice(i, i + 1000));
  }

  // 7. Store document metadata in D1
  await env.DB.prepare(`
    INSERT INTO standards (id, title, description, author, year, pages_json, tables_json, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      description = excluded.description,
      author = excluded.author,
      year = excluded.year,
      pages_json = excluded.pages_json,
      tables_json = excluded.tables_json,
      indexed_at = CURRENT_TIMESTAMP
  `).bind(
    standardId,
    metadata.title || standardId,
    metadata.subject || null,
    metadata.author || null,
    metadata.year ? parseInt(metadata.year) : null,
    JSON.stringify(pages),
    JSON.stringify(tables),
  ).run();

  return jsonResponse({
    success: true,
    standardId,
    chunksIndexed: chunks.length,
    tablesFound: tables.length,
    pages: pages.length,
  });
}

// ─── Applications Database Ingestion ──────────────────────────────────────────
// Embeds all 134 application rows into Vectorize for semantic search.
// Called once after seeding D1 from the 68-column CSV.

async function ingestApplications(request, env) {
  // Fetch all active applications from D1
  const result = await env.DB.prepare(
    'SELECT * FROM applications WHERE Active = 1'
  ).all();

  const applications = result.results;
  if (applications.length === 0) {
    return jsonResponse({ error: 'No applications found in D1. Run seed-applications.js first.' }, 400);
  }

  // Build text for embedding from each application's semantic fields
  const chunks = applications.map(app => ({
    code: app.code,
    text: buildApplicationEmbedText(app),
    indoorOutdoor: app.Indoor_Outdoor,
    standardCode: app.Standard,
    tm24Eligible: !!app.TM24_Eligible,
  }));

  // Generate embeddings in batches
  const batchSize = 100;
  const vectors = [];

  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const inputs = batch.map(c => c.text);
    const response = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: inputs });
    const embeddings = response.data;

    for (let j = 0; j < batch.length; j++) {
      vectors.push({
        id: batch[j].code,
        values: embeddings[j],
        metadata: {
          application_code: batch[j].code,
          indoor_outdoor: batch[j].indoorOutdoor || 'Indoor',
          standard_code: batch[j].standardCode || '',
          tm24_eligible: batch[j].tm24Eligible,
          chunk_type: 'application',
          excerpt_text: batch[j].text.substring(0, 300),
          page_number: null,
          standard_id: null,
        },
      });
    }
  }

  // Upsert in batches of 1000
  for (let i = 0; i < vectors.length; i += 1000) {
    await env.VECTORIZE.upsert(vectors.slice(i, i + 1000));
  }

  return jsonResponse({
    success: true,
    applicationsIndexed: vectors.length,
  });
}

/**
 * Builds the text string used for embedding an application row.
 * Includes all semantic fields so the vector captures meaning, not just keywords.
 */
function buildApplicationEmbedText(app) {
  const parts = [
    // Full hierarchy name
    [app.App, app.App_s1, app.App_s2, app.App_s3, app.App_s4, app.App_s5, app.App_s6]
      .filter(Boolean).join(' '),
    // Standard reference
    app.Standard_Full ? `Standard: ${app.Standard_Full}` : null,
    // Type context
    app.Area_or_Task ? `Type: ${app.Area_or_Task} lighting` : null,
    app.Indoor_Outdoor ? `Location: ${app.Indoor_Outdoor}` : null,
    // Notes for semantic richness
    app.App_Notes || null,
    app.General_Notes || null,
  ];
  return parts.filter(Boolean).join('. ');
}

// ─── Text Chunking ─────────────────────────────────────────────────────────────

function chunkText(fullText, pages, maxTokens) {
  const chunks = [];
  const maxWords = Math.floor(maxTokens / TOKENS_PER_WORD);

  // Split into page-level chunks first, then subdivide large pages
  for (const page of pages) {
    const words = page.text.split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;

    // Detect if this page looks like a table
    const chunkType = isTablePage(page.text) ? 'table' : 'text';

    if (words.length <= maxWords) {
      chunks.push({
        text: page.text,
        pageNumber: page.number,
        type: chunkType,
      });
    } else {
      // Split into sub-chunks with overlap
      const overlap = Math.floor(maxWords * 0.1);
      for (let i = 0; i < words.length; i += maxWords - overlap) {
        const chunkWords = words.slice(i, i + maxWords);
        chunks.push({
          text: chunkWords.join(' '),
          pageNumber: page.number,
          type: chunkType,
        });
      }
    }
  }

  return chunks;
}

function isTablePage(text) {
  // Heuristic: tables have lots of numbers and short lines
  const lines = text.split('\n');
  const numericLines = lines.filter(l => /^\s*\d+/.test(l)).length;
  return numericLines / lines.length > 0.3;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
