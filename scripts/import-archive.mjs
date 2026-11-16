/** Merge manually confirmed public radio page URLs into the shared catalog.
 * Never signs in, crawls, downloads media, or accesses the VSPO website.
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
  result.sort((a, b) => (b.date || '').localeCompare(a.date || '') || episodeKey(b.url).localeCompare(episodeKey(a.url), undefined, {numeric:true}));
  return {catalog: {...catalog, items: result}, summary: {input: rawItems.length, added, enriched, total: result.length, conflicts}};
}

function main() {
  const args = process.argv.slice(2);
  const candidatesPath = args.find(a => !a.startsWith('--'));
  if (!candidatesPath || args.some(a => a.startsWith('--') && a !== '--write')) {
    console.error('使い方: node scripts/import-archive.mjs archive-candidates.json [--write]');
    process.exitCode = 2; return;
  }
  const readJSON = p => JSON.parse(fs.readFileSync(p, 'utf8'));
  const {catalog, summary} = mergeArchive(readJSON(defaultCatalog), readJSON(candidatesPath));
  console.log(JSON.stringify(summary, null, 2));
  if (summary.conflicts.length) { console.warn('既存情報との相違（上書きなし）:\n'+summary.conflicts.join('\n')); }
  if (args.includes('--write')) {
    catalog.version = `${new Date().toISOString().slice(0,10)}-archive-import`;
    const draft = `${defaultCatalog}.tmp`;
    fs.writeFileSync(draft, `${JSON.stringify(catalog,null,2)}\n`, 'utf8');
    fs.renameSync(draft, defaultCatalog);
    console.log('catalog.json を更新しました。差分を確認してからコミットしてください。');
  } else {
    console.log('DRY RUN：catalog.json は変更していません。更新する場合は --write を付けてください。');
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (e) { console.error(String(e.message)); process.exitCode = 1; }
}