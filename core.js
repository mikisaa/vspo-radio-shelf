// The app only stores official *page links*. It never handles media URLs or auth cookies.
export const OFFICIAL_HOME = 'https://fc.vspo.jp/gallery/category/radio';
export const INITIAL_CATALOG = [
  {url: 'https://fc.vspo.jp/gallery/radio99', title: '第56回ラジオ', date: '2026-07-02', hosts: '', notes: '公式ニュース news156 より確認'},
  {url: 'https://fc.vspo.jp/gallery/radio79', title: '第36回ラジオ', date: '2026-02-12', hosts: '', notes: '公式ニュース news130 より確認'},
  {url: 'https://fc.vspo.jp/ja/gallery/radio40', title: '第20回ラジオ（再投稿版）', date: '2025-05-13', hosts: '', notes: '公式ニュース news70 より確認。再投稿版。'},
  {url: 'https://fc.vspo.jp/ja/gallery/radio22', title: '第2回ラジオ', date: '2024-12-26', hosts: '', notes: '公式ニュース news38 より確認'}
];

export function normalizeOfficialUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'fc.vspo.jp' || parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) return null;
    if (!/^\/(?:ja\/|en\/)?gallery\/radio[0-9]+\/?$/.test(parsed.pathname)) return null;
    return `https://fc.vspo.jp${parsed.pathname.replace(/\/$/, '')}`;
  } catch { return null; }
}
export function episodeKey(url) {
  const normalized = normalizeOfficialUrl(url);
  if (!normalized) return null;
  const m = normalized.match(/\/radio([0-9]+)$/);
  return m ? `radio${BigInt(m[1]).toString()}` : null;
}
export function cleanText(value, max = 120) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
export function cleanDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? value : '';
}
export function normalizeEpisode(candidate, source = 'local') {
  if (!candidate || typeof candidate !== 'object') return null;
  const url = normalizeOfficialUrl(candidate.url);
  if (!url) return null;
  const title = cleanText(candidate.title || `ラジオ（${episodeKey(url)}）`, 120);
  const e = {
    key: episodeKey(url), url, title, date: cleanDate(candidate.date),
    hosts: cleanText(candidate.hosts, 160), notes: cleanText(candidate.notes, 1000),
    favorite: candidate.favorite === true, heard: candidate.heard === true,
    lastOpened: Number.isFinite(candidate.lastOpened) && candidate.lastOpened > 0 ? candidate.lastOpened : 0,
    source: source === 'feed' ? 'feed' : 'local'
  };
  return e;
}
export function mergeEntries(current, incoming, source = 'feed') {
  const merged = new Map(current.map(item => [item.key, item]));
  let added = 0, enriched = 0;
  for (const raw of incoming) {
    const next = normalizeEpisode(raw, source);
    if (!next) continue;
    const prev = merged.get(next.key);
    if (!prev) { merged.set(next.key, next); added++; continue; }
    // User labels and private notes always win; fill only missing fields from public catalog.
    const changes = {};
    for (const field of ['date', 'hosts']) if (!prev[field] && next[field]) changes[field] = next[field];
    if (/^ラジオ（radio\d+）$/.test(prev.title) && next.title) changes.title = next.title;
    if (Object.keys(changes).length) { merged.set(next.key, {...prev, ...changes}); enriched++; }
  }
  return {entries: [...merged.values()], added, enriched};
}
export function extractFromAnnouncement(text) {
  const value = typeof text === 'string' ? text.slice(0, 30000) : '';
  const match = value.match(/https:\/\/fc\.vspo\.jp\/(?:ja\/|en\/)?gallery\/radio[0-9]+/i);
  const url = match ? normalizeOfficialUrl(match[0]) : null;
  if (!url) return null;
  const round = value.match(/第\s*([0-9０-９]+)\s*回\s*ラジオ/);
  const date = value.match(/\b(20\d{2})[\/-](\d{1,2})[\/-](\d{1,2})\b/);
  let title = '';
  if (round) title = `第${round[1].normalize('NFKC')}回ラジオ`;
  const parsedDate = date ? cleanDate(`${date[1]}-${date[2].padStart(2, '0')}-${date[3].padStart(2, '0')}`) : '';
  return {url, title, date: parsedDate};
}
// Imports only explicit official radio URLs supplied by the user. Never guesses missing links.
export function extractOfficialRadioLinks(text, limit = 500) {
  if (typeof text !== 'string') return [];
  const matches = text.slice(0, 100000).match(/https:\/\/fc\.vspo\.jp\/(?:ja\/|en\/)?gallery\/radio[0-9]+(?:\/?[?#][^\s<>"']*)?/gi) || [];
  const unique = new Map();
  for (const found of matches) {
    const url = normalizeOfficialUrl(found.replace(/[、。,;!?）\]}>]+$/, ''));
    if (!url) continue;
    const key = episodeKey(url);
    if (!unique.has(key)) unique.set(key, {url, title: `ラジオ（${key}）`, date: '', hosts: '', notes: ''});
    if (unique.size >= limit) break;
  }
  return [...unique.values()];
}

export function filterSort(entries, {filter = 'all', search = '', sort = 'newest'} = {}) {
  const q = search.normalize('NFKC').trim().toLocaleLowerCase('ja');
  const kept = entries.filter(e => {
    if (filter === 'unheard' && e.heard) return false;
    if (filter === 'heard' && !e.heard) return false;
    if (filter === 'favorites' && !e.favorite) return false;
    if (!q) return true;
    return [e.title, e.hosts, e.notes, e.date, e.key].some(v => String(v || '').normalize('NFKC').toLocaleLowerCase('ja').includes(q));
  });
  const compare = (a, b) => {
    if (sort === 'oldest') return (a.date || '').localeCompare(b.date || '') || a.key.localeCompare(b.key);
    if (sort === 'recent') return (b.lastOpened || 0) - (a.lastOpened || 0) || (b.date || '').localeCompare(a.date || '');
    if (sort === 'title') return a.title.localeCompare(b.title, 'ja', {numeric: true});
    return (b.date || '').localeCompare(a.date || '') || b.key.localeCompare(a.key, undefined, {numeric: true});
  };
  return kept.sort(compare);
}