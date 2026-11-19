import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  INITIAL_CATALOG,
  LEGACY_CATALOG_DEFAULTS,
  normalizeOfficialUrl,
  episodeKey,
  cleanDate,
  normalizeEpisode,
  mergeEntries,
  applyBackup,
  filterSort
} from '../core.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalogJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'catalog.json'), 'utf8'));

test('catalog.json を共通マスタとし、初期118件を保持したまま可変件数・未確認項目にも対応する', () => {
  assert.ok(Array.isArray(catalogJson.items));
  assert.ok(INITIAL_CATALOG.length >= 118);
  assert.ok(catalogJson.items.length >= INITIAL_CATALOG.length);

  const seenUrls = new Set();
  const seenKeys = new Set();

  for (const item of catalogJson.items) {
    const normalizedUrl = normalizeOfficialUrl(item.url);
    assert.ok(normalizedUrl, `不正URL: ${item.url}`);
    assert.equal(item.url, normalizedUrl);
    assert.ok(!seenUrls.has(normalizedUrl), `URL重複: ${normalizedUrl}`);
    seenUrls.add(normalizedUrl);

    const key = episodeKey(item.url);
    assert.ok(key && !seenKeys.has(key), `キー重複または不正: ${key}`);
    seenKeys.add(key);

    // 公開日・出演者は未確認（空文字）も許容し、値がある場合は形式を厳格検証する
    assert.ok(item.date === '' || cleanDate(item.date) === item.date, `日付不正: ${item.url} -> ${item.date}`);
    assert.equal(typeof item.hosts, 'string');
    assert.ok(item.hosts.length <= 160);
    assert.equal(typeof item.title, 'string');
    assert.ok(item.title.trim().length > 0 && item.title.length <= 120, `タイトル不正: ${item.url}`);

    // 出演者が判明している回はタイトル末尾の【出演者】と二重表示しない
    if (item.hosts) {
      assert.ok(!item.title.endsWith(`【${item.hosts}】`), `タイトル末尾に出演者が重複しています: ${item.url}`);
    }
  }

  // 初期収録済みの radio1〜radio118 が欠落せず保持されていること
  for (let n = 1; n <= 118; n++) {
    assert.ok(seenKeys.has(`radio${n}`), `radio${n} が欠けています`);
  }

  const byKey = new Map(catalogJson.items.map(item => [episodeKey(item.url), item]));
  assert.deepEqual(byKey.get('radio43'), {
    url: 'https://fc.vspo.jp/gallery/radio43',
    title: '【第23回】ぶいすぽっ！カフェでちょっとお時間いいですか？',
    date: '2025-05-29',
    hosts: 'ぶいすぽっ！運営1',
    notes: ''
  });
  assert.deepEqual(byKey.get('radio99'), {
    url: 'https://fc.vspo.jp/gallery/radio99',
    title: '【第56回】ぶいすぽっ！の雑談部今日も解散できません！',
    date: '2026-07-02',
    hosts: '白波らむね/神成きゅぴ',
    notes: '公式ニュース news156 より確認'
  });
  assert.deepEqual(byKey.get('radio79'), {
    url: 'https://fc.vspo.jp/gallery/radio79',
    title: '【第36回】ぶいすぽっ！の雑談部今日も解散できません！',
    date: '2026-02-12',
    hosts: '夢野あかり/花芽すみれ',
    notes: '公式ニュース news130 より確認'
  });
  assert.deepEqual(byKey.get('radio40'), {
    url: 'https://fc.vspo.jp/gallery/radio40',
    title: '【第20回】ぶいすぽっ！カフェでちょっとお時間いいですか？',
    date: '2025-05-08',
    hosts: '紫宮るな/猫汰つな/紡木こかげ',
    notes: '公式ニュース news70 より確認。再投稿版（再投稿告知日: 2025-05-13）。'
  });
  assert.deepEqual(byKey.get('radio22'), {
    url: 'https://fc.vspo.jp/gallery/radio22',
    title: '【第2回】ぶいすぽっ！カフェでちょっとお時間いいですか？',
    date: '2024-12-26',
    hosts: '藍沢エマ/夜乃くろむ',
    notes: '公式ニュース news38 より確認'
  });
});

test('初回起動とcatalog同期で全件を表示し、タイトル検索・出演者検索が動作する', () => {
  const bootMerged = mergeEntries([], INITIAL_CATALOG, 'feed');
  assert.equal(bootMerged.entries.length, INITIAL_CATALOG.length);

  const synced = mergeEntries(bootMerged.entries, catalogJson.items, 'feed');
  assert.equal(synced.entries.length, catalogJson.items.length);

  const visible = filterSort(synced.entries);
  assert.equal(visible.length, catalogJson.items.length);

  assert.ok(filterSort(synced.entries, {search: '雑談部'}).length >= 75);
  assert.ok(filterSort(synced.entries, {search: 'カフェでちょっとお時間'}).length >= 23);
  assert.ok(filterSort(synced.entries, {search: '第75回'}).some(e => e.key === 'radio118'));

  const mimiHanabi = filterSort(synced.entries, {search: '兎咲ミミ/蝶屋はなび'});
  assert.ok(mimiHanabi.some(e => e.key === 'radio118'));
  assert.ok(mimiHanabi.some(e => e.key === 'radio117'));
  assert.deepEqual(filterSort(synced.entries, {search: 'ぶいすぽっ！運営1'}).map(e => e.key), ['radio43']);
});

test('既存iPhoneの旧既定値4件は正式データへ安全にマイグレーションされ、ユーザー状態・手動編集値は保持される', () => {
  const savedOnIphone = [
    normalizeEpisode({
      ...LEGACY_CATALOG_DEFAULTS.radio99,
      favorite: true,
      heard: true,
      lastOpened: 1763000000123
    }, 'feed'),
    normalizeEpisode({
      ...LEGACY_CATALOG_DEFAULTS.radio79,
      notes: '自分の感想メモ',
      heard: true
    }, 'feed'),
    normalizeEpisode({
      ...LEGACY_CATALOG_DEFAULTS.radio40,
      favorite: true
    }, 'feed'),
    normalizeEpisode({
      url: LEGACY_CATALOG_DEFAULTS.radio22.url,
      title: 'お気に入り神回タイトル',
      date: '2024-12-27',
      hosts: 'エマたそ・くろむちゃん',
      notes: '',
      favorite: true,
      heard: true,
      lastOpened: 1762000000999
    }, 'feed')
  ];
  const hiddenKeys = ['radio22'];

  const firstSync = mergeEntries(savedOnIphone, catalogJson.items, 'feed');
  assert.equal(firstSync.added, catalogJson.items.length - 4);
  assert.equal(firstSync.enriched, 4);
  assert.equal(firstSync.entries.length, catalogJson.items.length);

  const map = new Map(firstSync.entries.map(e => [e.key, e]));

  const r99 = map.get('radio99');
  assert.equal(r99.title, '【第56回】ぶいすぽっ！の雑談部今日も解散できません！');
  assert.equal(r99.hosts, '白波らむね/神成きゅぴ');
  assert.equal(r99.date, '2026-07-02');
  assert.equal(r99.notes, '公式ニュース news156 より確認');
  assert.equal(r99.favorite, true);
  assert.equal(r99.heard, true);
  assert.equal(r99.lastOpened, 1763000000123);

  const r79 = map.get('radio79');
  assert.equal(r79.title, '【第36回】ぶいすぽっ！の雑談部今日も解散できません！');
  assert.equal(r79.hosts, '夢野あかり/花芽すみれ');
  assert.equal(r79.notes, '自分の感想メモ');
  assert.equal(r79.heard, true);

  const r40 = map.get('radio40');
  assert.equal(r40.url, 'https://fc.vspo.jp/gallery/radio40');
  assert.equal(r40.title, '【第20回】ぶいすぽっ！カフェでちょっとお時間いいですか？');
  assert.equal(r40.date, '2025-05-08');
  assert.equal(r40.hosts, '紫宮るな/猫汰つな/紡木こかげ');
  assert.match(r40.notes, /2025-05-13/);
  assert.equal(r40.favorite, true);

  const r22 = map.get('radio22');
  assert.equal(r22.title, 'お気に入り神回タイトル');
  assert.equal(r22.date, '2024-12-27');
  assert.equal(r22.hosts, 'エマたそ・くろむちゃん');
  assert.equal(r22.notes, '');
  assert.equal(r22.favorite, true);
  assert.equal(r22.heard, true);
  assert.equal(r22.lastOpened, 1762000000999);

  const visible = firstSync.entries.filter(e => !hiddenKeys.includes(e.key));
  assert.equal(visible.length, catalogJson.items.length - 1);

  const secondSync = mergeEntries(firstSync.entries, catalogJson.items, 'feed');
  const thirdSync = mergeEntries(secondSync.entries, INITIAL_CATALOG, 'feed');
  assert.equal(secondSync.added, 0);
  assert.equal(secondSync.enriched, 0);
  assert.equal(thirdSync.added, 0);
  assert.equal(thirdSync.enriched, 0);
  assert.equal(thirdSync.entries.length, catalogJson.items.length);
  assert.deepEqual(thirdSync.entries, firstSync.entries);
});

test('旧バージョンのJSONバックアップを読み込んでも互換性を保ちつつ正式データへ更新される', () => {
  const syncedState = mergeEntries([], catalogJson.items, 'feed');
  const legacyBackupPayload = {
    app: 'radio-shelf',
    version: 1,
    exportedAt: '2026-11-16T12:00:00.000Z',
    entries: [
      normalizeEpisode({...LEGACY_CATALOG_DEFAULTS.radio99, favorite: true, heard: true, notes: 'バックアップメモ', lastOpened: 99999}, 'feed'),
      normalizeEpisode({...LEGACY_CATALOG_DEFAULTS.radio40, heard: true}, 'feed')
    ],
    hidden: ['radio79']
  };

  const restored = applyBackup({entries: syncedState.entries, hidden: []}, legacyBackupPayload, INITIAL_CATALOG);
  assert.equal(restored.importedCount, 2);
  assert.equal(restored.entries.length, catalogJson.items.length);
  assert.deepEqual(restored.hidden, ['radio79']);

  const map = new Map(restored.entries.map(e => [e.key, e]));
  assert.equal(map.get('radio99').title, '【第56回】ぶいすぽっ！の雑談部今日も解散できません！');
  assert.equal(map.get('radio99').hosts, '白波らむね/神成きゅぴ');
  assert.equal(map.get('radio99').notes, 'バックアップメモ');
  assert.equal(map.get('radio99').favorite, true);
  assert.equal(map.get('radio99').heard, true);
  assert.equal(map.get('radio99').lastOpened, 99999);

  assert.equal(map.get('radio40').title, '【第20回】ぶいすぽっ！カフェでちょっとお時間いいですか？');
  assert.equal(map.get('radio40').date, '2025-05-08');
  assert.equal(map.get('radio40').heard, true);
});
