import fs from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {pathToFileURL} from 'node:url';
import {validateCatalogIntegrity} from './import-archive.mjs';

export const LIVE_CATALOG_URL = 'https://mikisaa.github.io/vspo-radio-shelf/catalog.json';

// Compare the complete JSON, not just the latest key or catalog count.
// A malformed/unreachable public response cannot be considered healthy.
export async function checkLiveCatalog(expected, {
  fetchImpl = globalThis.fetch,
  attempts = 2,
  delayMs = 5000,
  timeoutMs = 10000,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  log = console.log
} = {}) {
  validateCatalogIntegrity(null, expected);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetchImpl(`${LIVE_CATALOG_URL}?v=${Date.now()}-${attempt}`, {
        headers: {'Cache-Control': 'no-cache'},
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const actual = await res.json();
      if (isDeepStrictEqual(actual, expected)) {
        log(`Live catalog verified (attempt ${attempt}): ${expected.items.length} items, version=${expected.version}`);
        return true;
      }
      log(`Live catalog differs (attempt ${attempt}): expected=${expected.items.length}, actual=${Array.isArray(actual?.items) ? actual.items.length : 'invalid'}`);
    } catch (err) {
      log(`Live catalog unavailable (attempt ${attempt}): ${err.message}`);
    }
    if (attempt < attempts) await sleep(delayMs);
  }
  return false;
}

async function main() {
  const mode = process.argv[2];
  if (!['--check', '--verify'].includes(mode) || process.argv.length !== 3) {
    throw new Error('Usage: node scripts/pages-catalog-health.mjs --check|--verify');
  }
  const expected = JSON.parse(fs.readFileSync(new URL('../catalog.json', import.meta.url), 'utf8'));
  const matched = await checkLiveCatalog(expected, mode === '--verify' ? {attempts: 18, delayMs: 10000} : {});
  if (!matched) {
    console.error('Live catalog was not verified against the expected commit.');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error(err.message);
    process.exitCode = 2;
  });
}
