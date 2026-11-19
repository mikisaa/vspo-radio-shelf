/** Merge manually or publicly confirmed radio page URLs into the shared catalog.
 * Never signs in, crawls member pages, downloads media, or guesses unconfirmed links.
 * Usage: node scripts/import-archive.mjs path/to/archive-candidates.json [--write]
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {normalizeOfficialUrl, episodeKey, cleanDate, cleanText} from '../core.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultCatalog = path.join(projectRoot, 'catalog.json');

export function mergeArchive(catalog, source) {
  const rawItems = Array.isArray(source) ? source : source?.items;
  if (!Array.isArray(rawItems)) throw new Error('候補データは配列、または {"items": [...]} にしてください。');
  if (!Array.isArray(catalog?.items)) throw new Error('既存の catalog.json が不正です。');
  if (rawItems.length > 2000) throw new Error('候補は2000件以内にしてください。');

  const result = catalog.items.map(x => ({...x}));
  const known = new Map(result.map((e, i) => [episodeKey(e.url), i]));
  const accepted = new Set();
  const errors = [];
  const conflicts = [];
  let added = 0;
  let enriched = 0;

  for (const [i, item] of rawItems.entries()) {
    const location = `items[${i}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) { errors.push(`${location}: JSONオブジェクトが必要`); continue; }
    const url = normalizeOfficialUrl(item.url);
    if (!url) { errors.push(`${location}: fc.vspo.jp のラジオ個別URLのみ許可`); continue; }
    const key = episodeKey(url);
    if (accepted.has(key)) continue;
    accepted.add(key);
    const rawTitle = typeof item.title === 'string' ? item.title.trim() : '';
    if (rawTitle.length > 120) { errors.push(`${location}: タイトルが120文字を超えています`); continue; }
    if (item.date && !cleanDate(item.date)) { errors.push(`${location}: 日付は YYYY-MM-DD`); continue; }
    // Do not publish private notes or the contents of member-only radio episodes.
    if ('notes' in item && item.notes) { errors.push(`${location}: notes は収録しません（非公開情報防止）`); continue; }
    const incoming = {
      url,
      title: cleanText(rawTitle, 120),
      date: cleanDate(item.date || ''),
      hosts: cleanText(item.hosts || '', 160),
      notes: ''
    };
    if (known.has(key)) {
      const at = known.get(key);
      const existing = result[at];
      // The existing reference wins; never overwrite a confirmed title or date silently.
      const changes = {};
      for (const field of ['title', 'date', 'hosts']) {
        if (!existing[field] && incoming[field]) changes[field] = incoming[field];
        if (existing[field] && incoming[field] && existing[field] !== incoming[field] &&
          !(field === 'title' && /^ラジオ（radio\d+）$/.test(existing[field]))) {
          conflicts.push(`${location}: ${key} の ${field} は既存値と異なります（保持）`);
        }
        if (field === 'title' && /^ラジオ（radio\d+）$/.test(existing[field]) && rawTitle) changes.title = incoming.title;
      }
      if (Object.keys(changes).length) { result[at] = {...existing, ...changes}; enriched++; }
    } else {
      known.set(key, result.length);
      result.push({...incoming, title: incoming.title || `ラジオ（${key}）`});
      added++;
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  result.sort((a, b) => (b.date || '').localeCompare(a.date || '') || episodeKey(b.url).localeCompare(episodeKey(a.url), undefined, {numeric: true}));
  return {catalog: {...catalog, items: result}, summary: {input: rawItems.length, added, enriched, total: result.length, conflicts}};
}

export function validateCatalogIntegrity(previousCatalog, nextCatalog) {
  if (!nextCatalog || typeof nextCatalog !== 'object' || !Array.isArray(nextCatalog.items)) {
    throw new Error('更新後の catalog データ構造が不正です。');
  }
  if (previousCatalog && Array.isArray(previousCatalog.items) && nextCatalog.items.length < previousCatalog.items.length) {
    throw new Error(`カタログ件数が減少しています（${previousCatalog.items.length} -> ${nextCatalog.items.length}）。破損防止のため中断します。`);
  }
  const seenKeys = new Set();
  for (const [i, item] of nextCatalog.items.entries()) {
    const normalized = normalizeOfficialUrl(item?.url);
    if (!normalized) throw new Error(`catalog.items[${i}]: 不正なURLが含まれています`);
    const key = episodeKey(normalized);
    if (!key || seenKeys.has(key)) throw new Error(`catalog.items[${i}]: 重複または不正なキー ${key}`);
    seenKeys.add(key);
    if (typeof item.title !== 'string' || !item.title.trim() || item.title.length > 120) {
      throw new Error(`catalog.items[${i}]: タイトルが不正です`);
    }
    if (item.date !== '' && cleanDate(item.date) !== item.date) {
      throw new Error(`catalog.items[${i}]: 日付が不正です (${item.date})`);
    }
    if (typeof item.hosts !== 'string' || item.hosts.length > 160) {
      throw new Error(`catalog.items[${i}]: hosts が不正です`);
    }
    if (typeof item.notes !== 'string' || item.notes.length > 1000) {
      throw new Error(`catalog.items[${i}]: notes が不正です`);
    }
  }
  if (previousCatalog && Array.isArray(previousCatalog.items)) {
    const nextByKey = new Map(nextCatalog.items.map(item => [episodeKey(item.url), item]));
    for (const prev of previousCatalog.items) {
      const key = episodeKey(prev.url);
      const after = nextByKey.get(key);
      if (!after) throw new Error(`既存エピソード ${key} が消失しています。`);
      if (prev.notes && after.notes !== prev.notes) throw new Error(`既存エピソード ${key} の notes が変更されています。`);
      if (prev.date && after.date !== prev.date) throw new Error(`既存エピソード ${key} の date が変更されています。`);
      if (prev.hosts && after.hosts !== prev.hosts) throw new Error(`既存エピソード ${key} の hosts が変更されています。`);
      if (prev.title && !/^ラジオ（radio\d+）$/.test(prev.title) && after.title !== prev.title) {
        throw new Error(`既存エピソード ${key} の title が変更されています。`);
      }
    }
  }
  return true;
}

export function writeCatalogAtomically(catalogPath, nextCatalog) {
  const serialized = `${JSON.stringify(nextCatalog, null, 2)}\n`;
  const reparsed = JSON.parse(serialized);
  if (!Array.isArray(reparsed.items) || reparsed.items.length !== nextCatalog.items.length) {
    throw new Error('JSONシリアライズ検証に失敗しました。');
  }
  const draft = `${catalogPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(draft, serialized, 'utf8');
    fs.renameSync(draft, catalogPath);
  } catch (err) {
    try { if (fs.existsSync(draft)) fs.unlinkSync(draft); } catch { /* ignore cleanup error */ }
    throw err;
  }
}

export const PUBLIC_SITE_FILES = [
  'index.html',
  'player-test.html',
  'styles.css',
  'brand-theme.css',
  'core.js',
  'app.js',
  'sw.js',
  'manifest.webmanifest',
  'catalog.json'
];

export function stagePagesSite(sourceDir = projectRoot, outDir = path.join(projectRoot, '_site')) {
  const catalogSrcPath = path.join(sourceDir, 'catalog.json');
  const catalogData = JSON.parse(fs.readFileSync(catalogSrcPath, 'utf8'));
  validateCatalogIntegrity(null, catalogData);

  fs.rmSync(outDir, {recursive: true, force: true});
  fs.mkdirSync(path.join(outDir, 'assets'), {recursive: true});

  for (const relFile of PUBLIC_SITE_FILES) {
    const src = path.join(sourceDir, relFile);
    if (!fs.existsSync(src)) {
      throw new Error(`公開必須ファイルが見つかりません: ${relFile}`);
    }
    fs.copyFileSync(src, path.join(outDir, relFile));
  }

  const assetsDir = path.join(sourceDir, 'assets');
  if (!fs.existsSync(assetsDir)) {
    throw new Error('公開必須ディレクトリ assets/ が見つかりません。');
  }
  for (const entry of fs.readdirSync(assetsDir, {withFileTypes: true})) {
    if (entry.isFile() && /\.(?:png|svg|ico|webp)$/i.test(entry.name)) {
      fs.copyFileSync(path.join(assetsDir, entry.name), path.join(outDir, 'assets', entry.name));
    }
  }

  const stagedCatalog = JSON.parse(fs.readFileSync(path.join(outDir, 'catalog.json'), 'utf8'));
  if (stagedCatalog.items.length !== catalogData.items.length) {
    throw new Error('ステージングされた catalog.json の件数が一致しません。');
  }
  return {outDir, catalogCount: stagedCatalog.items.length, version: stagedCatalog.version};
}

function main() {
  const args = process.argv.slice(2);
  const candidatesPath = args.find(a => !a.startsWith('--'));
  if (!candidatesPath || args.some(a => a.startsWith('--') && a !== '--write')) {
    console.error('使い方: node scripts/import-archive.mjs archive-candidates.json [--write]');
    process.exitCode = 2; return;
  }
  const readJSON = p => JSON.parse(fs.readFileSync(p, 'utf8'));
  const previousCatalog = readJSON(defaultCatalog);
  const {catalog, summary} = mergeArchive(previousCatalog, readJSON(candidatesPath));
  console.log(JSON.stringify(summary, null, 2));
  if (summary.conflicts.length) { console.warn('既存情報との相違（上書きなし）:\n' + summary.conflicts.join('\n')); }
  if (args.includes('--write')) {
    if (summary.added === 0 && summary.enriched === 0) {
      console.log('追加・更新対象がないため catalog.json は変更しませんでした。');
      return;
    }
    validateCatalogIntegrity(previousCatalog, catalog);
    catalog.version = `${new Date().toISOString().slice(0, 10)}-archive-import`;
    writeCatalogAtomically(defaultCatalog, catalog);
    console.log('catalog.json を更新しました。差分を確認してからコミットしてください。');
  } else {
    console.log('DRY RUN：catalog.json は変更していません。更新する場合は --write を付けてください。');
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (e) { console.error(String(e.message)); process.exitCode = 1; }
}
