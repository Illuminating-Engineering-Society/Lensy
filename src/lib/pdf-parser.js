/**
 * PDF Parser
 * Wraps pdfjs-dist for Workers-compatible PDF text extraction.
 * Note: pdfjs-dist must run in a Node.js script context (e.g. scripts/ingest-pdfs.js),
 * not inside the Cloudflare Worker itself (no native FS/canvas support).
 * The Worker receives pre-parsed JSON from the ingestion script or calls this
 * module only when running under --node-compat or via a Durable Object with Node.
 */

/**
 * Parse a PDF ArrayBuffer into text, metadata, and page data.
 * @param {ArrayBuffer} pdfBytes
 * @returns {Promise<{text: string, metadata: Object, pages: Array}>}
 */
export async function parsePDF(pdfBytes) {
  // Dynamic import so this module is only loaded when pdfjs-dist is available
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.js');

  // Disable worker thread (not available in CF Workers / Node scripts)
  pdfjsLib.GlobalWorkerOptions.workerSrc = '';

  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(pdfBytes),
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
  });

  const pdf = await loadingTask.promise;
  const metadata = await extractMetadata(pdf);
  const pages = [];
  let fullText = '';

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();

    // Reconstruct readable text from text items, preserving rough layout
    const pageText = reconstructPageText(textContent.items);

    pages.push({
      number: i,
      text: pageText,
      height: page.view[3],
      width: page.view[2],
    });

    fullText += `\n[Page ${i}]\n${pageText}`;
  }

  return { text: fullText, metadata, pages };
}

function reconstructPageText(items) {
  if (!items || items.length === 0) return '';

  // Sort by vertical position (top to bottom), then horizontal (left to right)
  const sorted = [...items].sort((a, b) => {
    const yDiff = b.transform[5] - a.transform[5]; // y is inverted in PDF coords
    if (Math.abs(yDiff) > 5) return yDiff;
    return a.transform[4] - b.transform[4];
  });

  let text = '';
  let lastY = null;

  for (const item of sorted) {
    const y = item.transform[5];
    if (lastY !== null && Math.abs(y - lastY) > 5) {
      text += '\n'; // New line when vertical position changes
    }
    text += item.str;
    if (item.hasEOL) text += '\n';
    lastY = y;
  }

  return text.trim();
}

async function extractMetadata(pdf) {
  try {
    const meta = await pdf.getMetadata();
    return {
      title: meta.info?.Title || '',
      author: meta.info?.Author || '',
      subject: meta.info?.Subject || '',
      year: extractYear(meta.info?.CreationDate),
      keywords: meta.info?.Keywords || '',
    };
  } catch {
    return { title: '', author: '', subject: '', year: null, keywords: '' };
  }
}

function extractYear(creationDate) {
  if (!creationDate) return null;
  // PDF date format: D:YYYYMMDDHHmmSSOHH'mm'
  const match = creationDate.match(/D:(\d{4})/);
  return match ? match[1] : null;
}
