#!/usr/bin/env node
/**
 * Search Quality Test Script
 * Runs a set of known queries and checks result quality.
 *
 * Usage:
 *   node scripts/test-search.js
 *   node scripts/test-search.js --url https://lucius-api.your-account.workers.dev
 */

const API_BASE = process.argv.includes('--url')
  ? process.argv[process.argv.indexOf('--url') + 1]
  : (process.env.LUCIUS_API_URL || 'http://localhost:8787');

// Test cases: [query, expectedKeyword, description]
const TEST_CASES = [
  // Exact application matches
  ['spa lighting',                   'spa',          'Spa / Healthcare'],
  ['parking garage',                 'parking',      'Parking Garage'],
  ['office conference room',         'conference',   'Conference Room'],
  ['outdoor walkway',                'walkway',      'Outdoor Pedestrian'],
  ['hospital patient room',          'patient',      'Hospital Patient Room'],
  ['retail store floor',             'retail',       'Retail Store'],
  ['warehouse lighting',             'warehouse',    'Industrial/Warehouse'],
  ['restaurant dining area',         'restaurant',   'Restaurant Dining'],

  // Natural language questions
  ['how bright should a skating rink be',  'rink',   'NL: Skating Rink'],
  ['what lux for a massage room',          'massage', 'NL: Massage Room'],
  ['lighting for outdoor dining patio',    'dining',  'NL: Outdoor Dining'],

  // Multi-word / synonym matching
  ['wellness center spa',            'spa',           'Synonym: Wellness → Spa'],
  ['emergency room lighting',        'emergency',     'ER / Healthcare'],
  ['covered parking structure',      'parking',       'Synonym: Structure → Garage'],
];

const PASS = '✓';
const FAIL = '✗';
const WARN = '⚠';

async function main() {
  console.log(`\nLucius — Search Quality Tests`);
  console.log(`API: ${API_BASE}`);
  console.log(`${'─'.repeat(60)}\n`);

  let passed = 0;
  let failed = 0;
  let warned = 0;

  for (const [query, expectedKeyword, label] of TEST_CASES) {
    const result = await runTest(query, expectedKeyword, label);
    if (result === 'pass') passed++;
    else if (result === 'fail') failed++;
    else warned++;
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Results: ${passed} passed, ${warned} warnings, ${failed} failed`);
  console.log(`Pass rate: ${Math.round(passed / TEST_CASES.length * 100)}%`);

  if (failed > 0) {
    console.log('\nFailing tests indicate missing data in D1/Vectorize.');
    console.log('Check that seed-applications.js and ingest-pdfs.js have been run.\n');
    process.exit(1);
  }
  console.log();
}

async function runTest(query, expectedKeyword, label) {
  try {
    const response = await fetch(`${API_BASE}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, limit: 5 }),
    });

    if (!response.ok) {
      console.log(`${FAIL} [${label}]`);
      console.log(`   Query: "${query}"`);
      console.log(`   HTTP ${response.status}: ${await response.text().slice(0, 100)}`);
      return 'fail';
    }

    const data = await response.json();
    const results = data.results || [];

    if (results.length === 0) {
      console.log(`${WARN} [${label}]`);
      console.log(`   Query: "${query}" → 0 results (expected keyword: "${expectedKeyword}")`);
      return 'warn';
    }

    // Check if any top-5 result mentions the expected keyword
    const keyword = expectedKeyword.toLowerCase();
    const hit = results.some(r => {
      const app = r.application;
      const text = [app.fullName, app.category, app.sub1, app.sub2, app.appNotes]
        .filter(Boolean).join(' ').toLowerCase();
      return text.includes(keyword);
    });

    const topResult = results[0].application;
    const topName = topResult.fullName || topResult.sub2 || topResult.category;

    if (hit) {
      console.log(`${PASS} [${label}]`);
      console.log(`   Query: "${query}"`);
      console.log(`   Top result: ${topName} (${results[0].application.standard})`);
      return 'pass';
    } else {
      console.log(`${WARN} [${label}]`);
      console.log(`   Query: "${query}"`);
      console.log(`   Top result: ${topName} — expected keyword "${expectedKeyword}" not found in top 5`);
      return 'warn';
    }

  } catch (err) {
    console.log(`${FAIL} [${label}] — ${err.message}`);
    return 'fail';
  }
}

main();
