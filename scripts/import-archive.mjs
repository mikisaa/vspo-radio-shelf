/** Merge manually or publicly confirmed radio page URLs and metadata into the shared catalog.
 * Never signs in, crawls member pages, downloads media, or guesses unconfirmed links/hosts.
 *
 * Usage:
 *   node scripts/import-archive.mjs path/to/archive-candidates.json [--write]
 *   node scripts/import-archive.mjs --url https://fc.vspo.jp/gallery/radio119 --title "【第76回】...【出演者】" [--hosts "..."] [--date YYYY-MM-DD] [--write]
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  normalizeOfficialUrl,
  episodeKey,
  cleanDate,
  cleanText,
  canUpgradeProvisionalTitle,
  splitOfficialDisplayTitle
} from '../core.js';

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
    if (rawTitle.length > 160) { errors.push(`${location}: タイトルが長すぎます`); continue; }
    const split = splitOfficialDisplayTitle(rawTitle, typeof item.hosts === 'string' ? item.hosts : '');
    if (split.conflict) {
      errors.push(`${location}: タイトル末尾の出演者（${split.bracketHosts}）と hosts（${split.hosts}）が一致しません`);
      continue;
    }
    if (split.title.length > 120) { errors.push(`${location}: タイトルが120文字を超えています`); continue; }
    if (item.date && !cleanDate(item.date)) { errors.push(`${location}: 日付は YYYY-MM-DD`); continue; }
    // Do not publish private notes or the contents of member-only radio episodes.
    if ('notes' in item && item.notes) { errors.push(`${location}: notes は収録しません（非公開情報防止）`); continue; }
    const incoming = {
      url,
      title: split.title,
      date: cleanDate(item.date || ''),
      hosts: split.hosts,
      notes: ''
    };
    if (known.has(key)) {
      const at = known.get(key);
      const existing = result[at];
      // Confirmed values win; fill missing fields and upgrade provisional titles (e.g. "第76回ラジオ" -> "【第76回】<番組名>").
      const changes = {};
      for (const field of ['date', 'hosts']) {
        if (!existing[field] && incoming[field]) changes[field] = incoming[field];
        else if (existing[field] && incoming[field] && existing[field] !== incoming[field]) {
          conflicts.push(`${location}: ${key} の ${field} は既存値と異なります（保持）`);
        }
      }
      if (!existing.title && incoming.title) {
        changes.title = incoming.title;
      } else if (incoming.title && canUpgradeProvisionalTitle(existing.title, incoming.title)) {
        changes.title = incoming.title;
      } else if (existing.title && incoming.title && existing.title !== incoming.title) {
        conflicts.push(`${location}: ${key} の title は既存値と異なります（保持）`);
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
      if (prev.title && after.title !== prev.title && !canUpgradeProvisionalTitle(prev.title, after.title)) {
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

export function validateManualEnrichInputs({url = '', title = '', hosts = '', date = ''} = {}) {
  const u = String(url || '').trim();
  const t = String(title || '').trim();
  const h = String(hosts || '').trim();
  const d = String(date || '').trim();

  if (!u && !t && !h && !d) return null;
  if (!u) {
    throw new Error('手動補完では confirmed_url（公式ラジオ個別URL）の指定が必須です。');
  }
  const normalizedUrl = normalizeOfficialUrl(u);
  if (!normalizedUrl) {
    throw new Error('confirmed_url には https://fc.vspo.jp/gallery/radio番号 のみを指定してください。');
  }
  if (!t && !h && !d) {
    throw new Error('手動補完では confirmed_title、confirmed_hosts、date のいずれか1つ以上を指定してください。');
  }
  if (d && !cleanDate(d)) {
    throw new Error('日付は実在する YYYY-MM-DD 形式で指定してください。');
  }
  const split = splitOfficialDisplayTitle(t, h);
  if (split.conflict) {
    throw new Error(`タイトル末尾の出演者（${split.bracketHosts}）と confirmed_hosts（${split.hosts}）が一致しません。`);
  }
  if (split.title.length > 120) {
    throw new Error('タイトルが120文字を超えています。');
  }
  if (split.hosts.length > 160) {
    throw new Error('出演者名が160文字を超えています。');
  }
  return {
    key: episodeKey(normalizedUrl),
    url: normalizedUrl,
    title: split.title,
    hosts: split.hosts,
    date: d ? cleanDate(d) : ''
  };
}

export function parseCliArgs(args) {
  let write = false;
  let candidatesPath = null;
  const inline = {url: '', title: '', hosts: '', date: ''};
  let hasInline = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--write') { write = true; continue; }
    if (a === '--url' || a === '--title' || a === '--hosts' || a === '--date') {
      const val = args[++i];
      if (val === undefined) throw new Error(`${a} の値を指定してください。`);
      inline[a.slice(2)] = val;
      hasInline = true;
      continue;
    }
    if (a.startsWith('--')) throw new Error(`不明なオプションです: ${a}`);
    if (candidatesPath) throw new Error('候補ファイルは1つだけ指定してください。');
    candidatesPath = a;
  }

  if (hasInline && candidatesPath) {
    throw new Error('JSONファイル指定と --url 直接指定は同時に使えません。');
  }
  if (!hasInline && !candidatesPath) {
    return null;
  }
  return {write, candidatesPath, inlineItem: hasInline ? inline : null};
}

function main() {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (!parsed) {
    console.error('使い方:\n  node scripts/import-archive.mjs archive-candidates.json [--write]\n  node scripts/import-archive.mjs --url https://fc.vspo.jp/gallery/radio119 --title "【第76回】...【出演者】" [--hosts "..."] [--date YYYY-MM-DD] [--write]');
    process.exitCode = 2;
    return;
  }
  const readJSON = p => JSON.parse(fs.readFileSync(p, 'utf8'));
  const previousCatalog = readJSON(defaultCatalog);
  const candidateSource = parsed.inlineItem ? {items: [parsed.inlineItem]} : readJSON(parsed.candidatesPath);
  const {catalog, summary} = mergeArchive(previousCatalog, candidateSource);
  console.log(JSON.stringify(summary, null, 2));
  if (summary.conflicts.length) { console.warn('既存情報との相違（上書きなし）:\n' + summary.conflicts.join('\n')); }
  if (parsed.write) {
    if (summary.conflicts.length) {
      throw new Error('既存情報との競合が検出されたため書き込みを中止しました。');
    }
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
