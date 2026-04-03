/**
 * Embeddings Generator
 * Wraps Cloudflare Workers AI for @cf/baai/bge-base-en-v1.5 (768 dimensions).
 */

const EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';
const BATCH_SIZE = 100; // Workers AI limit per call

/**
 * Generate embeddings for an array of text chunks.
 * @param {*} ai - Workers AI binding (env.AI)
 * @param {Array<{text: string}>} chunks
 * @returns {Promise<number[][]>} Array of embedding vectors (768-dim each)
 */
export async function generateEmbeddings(ai, chunks) {
  const embeddings = [];

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const inputs = batch.map(c => (typeof c === 'string' ? c : c.text));

    const response = await ai.run(EMBEDDING_MODEL, { text: inputs });
    embeddings.push(...response.data);
  }

  return embeddings;
}

/**
 * Generate a single embedding for a query string.
 * @param {*} ai - Workers AI binding
 * @param {string} text
 * @returns {Promise<number[]>} 768-dimensional vector
 */
export async function embedQuery(ai, text) {
  const response = await ai.run(EMBEDDING_MODEL, { text: [text] });
  return response.data[0];
}
