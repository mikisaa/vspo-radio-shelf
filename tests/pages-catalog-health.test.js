import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {checkLiveCatalog, LIVE_CATALOG_URL} from '../scripts/pages-catalog-health.mjs';

const expected = {version: 'test', items: [
  {url: 'https://fc.vspo.jp/gallery/radio120', title: '第77回ラジオ', date: '2026-11-19', hosts: '', notes: ''}
]};
const check = (fetchImpl, extra = {}) => checkLiveCatalog(expected, {
  fetchImpl, log: () => {}, sleep: async () => {}, ...extra
});
const response = data => ({ok: true, json: async () => data});

test('Pages: full match is healthy and does not need a redeploy', async () => {
  let calls = 0;
  assert.equal(await check(async (url, options) => {
    calls++;
    assert.ok(url.startsWith(`${LIVE_CATALOG_URL}?v=`));
    assert.equal(options.headers['Cache-Control'], 'no-cache');
    assert.ok(options.signal instanceof AbortSignal);
    return response(structuredClone(expected));
  }), true);
  assert.equal(calls, 1);
});

test('Pages: missing episode or any differing metadata requires recovery', async () => {
  for (const differing of [
    {...expected, items: []},
    {...expected, version: 'old'},
    {...expected, items: [{...expected.items[0], date: '2026-11-26'}]},
    {...expected, items: [{...expected.items[0], hosts: 'different'}]},
    {items: null}
  ]) assert.equal(await check(async () => response(differing)), false);
});

test('Pages: network, HTTP and parse errors are never classified as healthy', async () => {
  assert.equal(await check(async () => { throw new Error('offline'); }), false);
  assert.equal(await check(async () => ({ok: false, status: 503})), false);
  assert.equal(await check(async () => ({ok: true, json: async () => { throw new SyntaxError('not JSON'); }})), false);
});

test('Pages: bounded retry allows propagation and stops on full match', async () => {
  let calls = 0, waits = 0;
  const matched = await check(async () => response(++calls === 2 ? expected : {...expected, items: []}), {
    attempts: 3, sleep: async () => { waits++; }
  });
  assert.equal(matched, true);
  assert.equal(calls, 2);
  assert.equal(waits, 1);
});

test('Pages: dry run cannot trigger recovery, stale no-update run can, and verification uses the exact commit', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/sync-new-radio.yml', import.meta.url), 'utf8');
  assert.match(workflow, /id: pages_health\s+if: inputs\.dry_run != true/);
  assert.match(workflow, /node scripts\/pages-catalog-health\.mjs --check \|\| STATUS=\$\?/);
  assert.match(workflow, /if \[ "\$\{STATUS\}" = "1" \]; then[\s\S]*?DEPLOY=true/);
  assert.match(workflow, /if: needs\.sync-catalog\.outputs\.deploy_required == 'true'/);
  assert.match(workflow, /verify-pages:[\s\S]*?ref: \$\{\{ needs\.sync-catalog\.outputs\.commit_sha \}\}[\s\S]*?node scripts\/pages-catalog-health\.mjs --verify/);
});

test('Pages: deployment waits for the completed build and exact non-expired artifact', () => {
  const deploy = fs.readFileSync(new URL('../.github/workflows/deploy-pages.yml', import.meta.url), 'utf8');
  const sync = fs.readFileSync(new URL('../.github/workflows/sync-new-radio.yml', import.meta.url), 'utf8');
  assert.match(deploy, /build:[\s\S]*?artifact_id: \$\{\{ steps\.upload\.outputs\.artifact_id \}\}/);
  assert.match(deploy, /deploy:\s+needs: build/);
  assert.match(deploy, /actions: read/);
  assert.match(deploy, /Wait for uploaded Pages artifact[\s\S]*?select\(\.expired == false\)[\s\S]*?grep -Fxq "\$\{ARTIFACT_ID\}"/);
  assert.match(deploy, /uses: actions\/deploy-pages@v4[\s\S]*?artifact_name: \$\{\{ needs\.build\.outputs\.artifact_name \}\}/);
  assert.match(sync, /deploy-pages:[\s\S]*?permissions:[\s\S]*?actions: read/);
});
