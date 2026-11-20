import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  INITIAL_CATALOG,
  episodeKey,
  normalizeEpisode,
  isProvisionalTitle,
  canUpgradeProvisionalTitle,
  splitOfficialDisplayTitle,
  mergeEntries,
  applyBackup
} from '../core.js';
import {mergeArchive, validateCatalogIntegrity, validateManualEnrichInputs, parseCliArgs} from '../scripts/import-archive.mjs';
import {syncCatalogFromPublicNews} from '../scripts/sync-public-news.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const prodCatalogPath = path.join(rootDir, 'catalog.json');
const prodCatalog = JSON.parse(fs.readFileSync(prodCatalogPath, 'utf8'));

test('v1.6: catalog.json が119件以上・URL重複なし・既存118件保持・確認済みradio119が正しいこと', () => {
  assert.ok(prodCatalog.items.length >= 119, '登録件数が119件を下回っています');
  const byKey = new Map(prodCatalog.items.map(item => [episodeKey(item.url), item]));
  assert.equal(byKey.size, prodCatalog.items.length, 'URLキーの重複が存在します');
  for (let n = 1; n <= 119; n++) {
    assert.ok(byKey.has(`radio${n}`), `radio${n} が存在しません`);
  }
  // 既存118件の情報変更なし確認
  for (const initItem of INITIAL_CATALOG) {
    assert.deepEqual(byKey.get(episodeKey(initItem.url)), initItem);
  }
  // 公式ページのスクリーンショットで確認したradio119の正式情報を維持する
  assert.deepEqual(byKey.get('radio119'), {
    url: 'https://fc.vspo.jp/gallery/radio119',
    title: '【第76回】ぶいすぽっ！の雑談部今日も解散できません！',
    date: '2026-11-19',
    hosts: '兎咲ミミ/紡木こかげ',
    notes: ''
  });
  // Service Worker v8 更新確認
  const swSource = fs.readFileSync(path.join(rootDir, 'sw.js'), 'utf8');
  assert.match(swSource, /const\s+CACHE_NAME\s*=\s*'radio-shelf-v8'/);
});

test('v1.6: 手動補完用 workflow_dispatch / CLI 入力値検証（validateManualEnrichInputs）', () => {
  // 全て空なら通常自動同期モード（null）
  assert.equal(validateManualEnrichInputs({url: '', title: '', hosts: ''}), null);

  // URL未指定でタイトルや出演者だけ指定された場合はエラー
  assert.throws(() => validateManualEnrichInputs({url: '', title: '【第76回】番組名'}), /confirmed_url/);
  assert.throws(() => validateManualEnrichInputs({url: '', hosts: '出演者A'}), /confirmed_url/);

  // 不正URL拒否
  assert.throws(() => validateManualEnrichInputs({url: 'https://evil.example/gallery/radio119', title: 'test'}), /confirmed_url/);
  assert.throws(() => validateManualEnrichInputs({url: 'https://fc.vspo.jp/post/news189', title: 'test'}), /confirmed_url/);

  // URLのみで補完内容が空の場合はエラー
  assert.throws(() => validateManualEnrichInputs({url: 'https://fc.vspo.jp/gallery/radio119', title: '', hosts: ''}), /いずれか1つ以上/);

  // タイトル末尾括弧と hosts の不一致はエラー
  assert.throws(
    () => validateManualEnrichInputs({
      url: 'https://fc.vspo.jp/gallery/radio119',
      title: '【第76回】ぶいすぽっ！の雑談部今日も解散できません！【花芽すみれ/橘ひなの】',
      hosts: '別の出演者'
    }),
    /一致しません/
  );

  // 正常な手動補完入力の正規化
  assert.deepEqual(
    validateManualEnrichInputs({
      url: 'https://fc.vspo.jp/gallery/radio119/',
      title: '【第76回】ぶいすぽっ！の雑談部今日も解散できません！【花芽すみれ/橘ひなの】',
      hosts: ''
    }),
    {
      key: 'radio119',
      url: 'https://fc.vspo.jp/gallery/radio119',
      title: '【第76回】ぶいすぽっ！の雑談部今日も解散できません！',
      hosts: '花芽すみれ/橘ひなの',
      date: ''
    }
  );
});

test('v1.6: isProvisionalTitle / canUpgradeProvisionalTitle / splitOfficialDisplayTitle の厳密な判定', () => {
  assert.equal(isProvisionalTitle('第76回ラジオ'), true);
  assert.equal(isProvisionalTitle('ラジオ（radio119）'), true);
  assert.equal(isProvisionalTitle('【第76回】ぶいすぽっ！の雑談部今日も解散できません！'), false);
  assert.equal(isProvisionalTitle('お気に入り回'), false);

  // 同じ回数番号の正式タイトルのみ昇格許可、回数不一致や無関係文字列・逆戻りは拒否
  assert.equal(canUpgradeProvisionalTitle('第76回ラジオ', '【第76回】ぶいすぽっ！の雑談部今日も解散できません！'), true);
  assert.equal(canUpgradeProvisionalTitle('ラジオ（radio119）', '第76回ラジオ'), true);
  assert.equal(canUpgradeProvisionalTitle('ラジオ（radio119）', '【第76回】ぶいすぽっ！の雑談部今日も解散できません！'), true);
  assert.equal(canUpgradeProvisionalTitle('第76回ラジオ', '【第75回】ぶいすぽっ！の雑談部今日も解散できません！'), false);
  assert.equal(canUpgradeProvisionalTitle('第76回ラジオ', 'different'), false);
  assert.equal(canUpgradeProvisionalTitle('【第76回】ぶいすぽっ！の雑談部今日も解散できません！', '第76回ラジオ'), false);

  // 会員一覧の表示タイトルからの自動分離
  assert.deepEqual(
    splitOfficialDisplayTitle('【第76回】ぶいすぽっ！の雑談部今日も解散できません！【花芽すみれ/橘ひなの】'),
    {
      title: '【第76回】ぶいすぽっ！の雑談部今日も解散できません！',
      hosts: '花芽すみれ/橘ひなの',
      conflict: false
    }
  );
  // 末尾括弧と hosts 引数の不一致検知
  assert.equal(
    splitOfficialDisplayTitle('【第76回】ぶいすぽっ！の雑談部今日も解散できません！【花芽すみれ/橘ひなの】', '別の出演者').conflict,
    true
  );
});

test('v1.6: mergeEntries による仮タイトルから正式タイトルへの補完・出演者追加・お気に入り/視聴済み/メモ保持・手動編集保護・冪等性', () => {
  const localState = [
    // 1) 自動登録された仮タイトル「第76回ラジオ」＋お気に入り・視聴済み・メモあり（タイトル・出演者は未編集）
    normalizeEpisode({
      url: 'https://fc.vspo.jp/gallery/radio119',
      title: '第76回ラジオ',
      date: '2026-11-19',
      hosts: '',
      notes: 'とても面白かった回',
      favorite: true,
      heard: true,
      lastOpened: 1763550000000,
      userEdited: ['notes']
    }, 'feed'),
    // 2) ユーザーが意図的にタイトルと出演者を手動編集済み（userEdited で保護）
    normalizeEpisode({
      url: 'https://fc.vspo.jp/gallery/radio120',
      title: '第77回ラジオ',
      date: '2026-11-26',
      hosts: '',
      notes: '手動で仮タイトルのまま固定',
      favorite: true,
      userEdited: ['title', 'hosts', 'notes']
    }, 'feed'),
    // 3) カスタムタイトルに手動変更済み（userEdited 無しの旧データ形式でもカスタム文字列として保護）
    normalizeEpisode({
      url: 'https://fc.vspo.jp/gallery/radio121',
      title: 'マイベスト神回',
      date: '2026-12-03',
      hosts: '自分のメモ表記',
      heard: true
    }, 'local')
  ];
  const hidden = ['radio121'];

  const enrichedFeed = [
    {
      url: 'https://fc.vspo.jp/gallery/radio119',
      title: '【第76回】ぶいすぽっ！の雑談部今日も解散できません！',
      date: '2026-11-19',
      hosts: '花芽すみれ/橘ひなの',
      notes: ''
    },
    {
      url: 'https://fc.vspo.jp/gallery/radio120',
      title: '【第77回】ぶいすぽっ！の雑談部今日も解散できません！',
      date: '2026-11-26',
      hosts: '小森めと/白波らむね',
      notes: ''
    },
    {
      url: 'https://fc.vspo.jp/gallery/radio121',
      title: '【第78回】ぶいすぽっ！の雑談部今日も解散できません！',
      date: '2026-12-03',
      hosts: '胡桃のあ/猫汰つな',
      notes: ''
    }
  ];

  const first = mergeEntries(localState, enrichedFeed, 'feed');
  assert.equal(first.added, 0);
  assert.equal(first.enriched, 1); // radio119 のみ補完され、radio120 / radio121 は手動編集保護により変更なし

  const byKey = new Map(first.entries.map(e => [e.key, e]));

  // radio119: 正式タイトル・出演者が補完され、お気に入り・視聴済み・メモ・lastOpened が保持される
  const r119 = byKey.get('radio119');
  assert.equal(r119.title, '【第76回】ぶいすぽっ！の雑談部今日も解散できません！');
  assert.equal(r119.hosts, '花芽すみれ/橘ひなの');
  assert.equal(r119.notes, 'とても面白かった回');
  assert.equal(r119.favorite, true);
  assert.equal(r119.heard, true);
  assert.equal(r119.lastOpened, 1763550000000);
  assert.deepEqual(r119.userEdited, ['notes']);

  // radio120: userEdited により手動設定値が保護される
  const r120 = byKey.get('radio120');
  assert.equal(r120.title, '第77回ラジオ');
  assert.equal(r120.hosts, '');
  assert.equal(r120.favorite, true);

  // radio121: カスタムタイトル・出演者および非表示設定が保護される
  const r121 = byKey.get('radio121');
  assert.equal(r121.title, 'マイベスト神回');
  assert.equal(r121.hosts, '自分のメモ表記');
  assert.equal(r121.heard, true);
  assert.equal(first.entries.filter(e => !hidden.includes(e.key)).length, 2);

  // 冪等性：2回目以降の同期では added: 0, enriched: 0
  const second = mergeEntries(first.entries, enrichedFeed, 'feed');
  assert.equal(second.added, 0);
  assert.equal(second.enriched, 0);
  assert.deepEqual(second.entries, first.entries);

  // バックアップ互換性検証（v1 JSONバックアップの書き出し→読み込み）
  const backupPayload = {
    app: 'radio-shelf',
    version: 1,
    exportedAt: '2026-11-19T15:00:00.000Z',
    entries: localState,
    hidden
  };
  const restored = applyBackup({entries: first.entries, hidden: []}, backupPayload, enrichedFeed);
  const restoredMap = new Map(restored.entries.map(e => [e.key, e]));
  assert.equal(restoredMap.get('radio119').title, '【第76回】ぶいすぽっ！の雑談部今日も解散できません！');
  assert.equal(restoredMap.get('radio119').hosts, '花芽すみれ/橘ひなの');
  assert.equal(restoredMap.get('radio119').notes, 'とても面白かった回');
  assert.equal(restoredMap.get('radio120').title, '第77回ラジオ');
  assert.equal(restoredMap.get('radio120').hosts, '');
  assert.deepEqual(restored.hidden, ['radio121']);
});

test('v1.6: 会員ページ確認後の手動補完（import-archive.mjs）および次回以降の2段階自動登録・事後補完ライフサイクル', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vspo-v16-'));
  t.after(() => fs.rmSync(tmp, {recursive: true, force: true}));
  const catalogPath = path.join(tmp, 'catalog.json');
  fs.copyFileSync(prodCatalogPath, catalogPath);
  // 本番radio119は既に正式補完済み。仮登録→正式補完のテストは一時コピーのみ初期状態に戻す。
  const provisionalFixture = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const provisional119 = provisionalFixture.items.find(x => episodeKey(x.url) === 'radio119');
  assert.ok(provisional119, 'テスト用のradio119が見つかりません');
  provisional119.title = '第76回ラジオ';
  provisional119.hosts = '';
  fs.writeFileSync(catalogPath, `${JSON.stringify(provisionalFixture, null, 2)}\n`, 'utf8');

  // CLI パーサー検証
  const cli = parseCliArgs(['--url', 'https://fc.vspo.jp/gallery/radio119', '--title', '【第76回】ぶいすぽっ！の雑談部今日も解散できません！【兎咲ミミ/紡木こかげ】', '--write']);
  assert.equal(cli.write, true);
  assert.equal(cli.inlineItem.url, 'https://fc.vspo.jp/gallery/radio119');

  // 1) 会員ページで確認した1行表示タイトルを渡すと、radio119 が正式タイトル＋出演者に補完される（テスト用コピー上で検証）
  const beforeCatalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const {catalog: enriched119, summary: sum1} = mergeArchive(beforeCatalog, {items: [cli.inlineItem]});
  assert.equal(sum1.added, 0);
  assert.equal(sum1.enriched, 1);
  assert.equal(sum1.total, beforeCatalog.items.length);
  assert.deepEqual(sum1.conflicts, []);
  assert.equal(validateCatalogIntegrity(beforeCatalog, enriched119), true);

  const item119 = enriched119.items.find(x => episodeKey(x.url) === 'radio119');
  assert.deepEqual(item119, {
    url: 'https://fc.vspo.jp/gallery/radio119',
    title: '【第76回】ぶいすぽっ！の雑談部今日も解散できません！',
    date: '2026-11-19',
    hosts: '兎咲ミミ/紡木こかげ',
    notes: ''
  });

  // 同じ補完を再実行しても冪等（added: 0, enriched: 0）
  const {summary: sumIdempotent} = mergeArchive(enriched119, {items: [cli.inlineItem]});
  assert.equal(sumIdempotent.added, 0);
  assert.equal(sumIdempotent.enriched, 0);
  assert.deepEqual(sumIdempotent.conflicts, []);

  fs.writeFileSync(catalogPath, `${JSON.stringify(enriched119, null, 2)}\n`, 'utf8');

  // 2) 次回以降（radio950 / 第77回）の2段階ライフサイクル：
  //    Step A: 初回発見時は公開NEWSから URL・回数・公開日のみ登録
  const makeList = title => `<!doctype html><html><body><main><a href="https://fc.vspo.jp/post/news950"><p>2026年11月26日</p><p>${title}</p></a></main></body></html>`;
  const stepAFetch = async url => ({
    ok: true,
    status: 200,
    url,
    headers: {get: () => null},
    text: async () => url.endsWith('/post')
      ? makeList('ラジオコンテンツ更新のお知らせ')
      : '<!doctype html><html><body><main><p>NEWS 2026/11/26</p><div class="post-show"><div><p>第77回ラジオを更新しました。</p><p>https://fc.vspo.jp/gallery/radio950</p></div></div></main></body></html>'
  });

  const stepA = await syncCatalogFromPublicNews({
    catalogPath,
    write: true,
    fetchImpl: stepAFetch,
    now: () => new Date('2026-11-26T12:00:00Z')
  });
  assert.equal(stepA.status, 'updated');
  assert.equal(stepA.added, 1);
  assert.equal(stepA.enriched, 0);

  //    Step B: 後日、公開情報源に正式な番組名・出演者が掲載された場合、既存 radio950 を自動補完（enriched: 1）
  const stepBFetch = async url => ({
    ok: true,
    status: 200,
    url,
    headers: {get: () => null},
    text: async () => url.endsWith('/post')
      ? makeList('ラジオ詳細追記のお知らせ')
      : '<!doctype html><html><body><main><p>NEWS 2026/11/26</p><div class="post-show"><div><p>【第77回】ぶいすぽっ！の雑談部今日も解散できません！【小森めと/白波らむね】</p><p>https://fc.vspo.jp/gallery/radio950</p></div></div></main></body></html>'
  });

  const stepB = await syncCatalogFromPublicNews({
    catalogPath,
    write: true,
    fetchImpl: stepBFetch,
    now: () => new Date('2026-11-27T12:00:00Z')
  });
  assert.equal(stepB.status, 'updated');
  assert.equal(stepB.added, 0);
  assert.equal(stepB.enriched, 1);
  assert.deepEqual(stepB.enrichedKeys, ['radio950']);

  const afterStepB = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const r950 = afterStepB.items.find(x => episodeKey(x.url) === 'radio950');
  assert.deepEqual(r950, {
    url: 'https://fc.vspo.jp/gallery/radio950',
    title: '【第77回】ぶいすぽっ！の雑談部今日も解散できません！',
    date: '2026-11-26',
    hosts: '小森めと/白波らむね',
    notes: ''
  });

  //    Step C: 再実行時は完全冪等（no_updates）
  const stepC = await syncCatalogFromPublicNews({
    catalogPath,
    write: true,
    fetchImpl: stepBFetch,
    now: () => new Date('2026-11-27T13:00:00Z')
  });
  assert.equal(stepC.status, 'no_updates');
  assert.equal(stepC.added, 0);
  assert.equal(stepC.enriched, 0);
});
