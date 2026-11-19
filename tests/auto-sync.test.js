import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {
  INITIAL_CATALOG,
  episodeKey,
  mergeEntries,
  filterSort
} from '../core.js';
import {validateCatalogIntegrity, stagePagesSite, PUBLIC_SITE_FILES} from '../scripts/import-archive.mjs';
import {
  parseNewsList,
  parseNewsArticle,
  parseAndValidatePublishDate,
  fetchPublicHtml,
  withCatalogLock,
  syncCatalogFromPublicNews,
  publishCatalogUpdate
} from '../scripts/sync-public-news.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const prodCatalogPath = path.join(rootDir, 'catalog.json');
const prodCatalogBytesBefore = fs.readFileSync(prodCatalogPath);
const prodCatalogHashBefore = crypto.createHash('sha256').update(prodCatalogBytesBefore).digest('hex');
const prodCatalogInitial = JSON.parse(prodCatalogBytesBefore.toString('utf8'));
const BASE_COUNT = prodCatalogInitial.items.length;
const MAX_RADIO_NUM = Math.max(...prodCatalogInitial.items.map(x => Number(episodeKey(x.url).slice(5))));
const NEXT_RADIO_A = `radio${MAX_RADIO_NUM + 1}`;
const NEXT_RADIO_B = `radio${MAX_RADIO_NUM + 2}`;

function makeTempDir(prefix = 'vspo-radio-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeNewsListHtml(items) {
  const links = items.map(item => `
    <div class="mb-4 rounded-xl bg-white">
      <a href="${item.url}" class="custom-post-list-link">
        <img src="/public_assets/thumb.png" alt="${item.title}" />
        <div>
          <span>NEWS</span>
          <p>${item.dateLabel || ''}</p>
          <p>${item.title}</p>
        </div>
      </a>
    </div>
  `).join('\n');
  return `<!doctype html><html lang="ja"><body><main><h1>投稿</h1>${links}</main></body></html>`;
}

function makeNewsArticleHtml({headerDate = '', title = 'ラジオコンテンツ更新のお知らせ', bodyHtml = ''}) {
  return `<!doctype html><html lang="ja"><head><title>ファンクラブ | ${title}</title></head><body>
    <main>
      <div><span>NEWS</span>${headerDate ? `<p>${headerDate}</p>` : ''}<div>${title}</div></div>
      <div class="post-show"><div class="c-slate">${bodyHtml}</div></div>
    </main>
  </body></html>`;
}

function createMockFetch(routes) {
  return async url => {
    const handler = routes[url];
    if (!handler) {
      return {ok: false, status: 404, url, headers: new Map(), text: async () => 'Not Found'};
    }
    if (typeof handler === 'function') return handler(url);
    const hdrs = new Map(Object.entries(handler.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      ok: handler.ok ?? ((handler.status ?? 200) >= 200 && (handler.status ?? 200) < 300),
      status: handler.status ?? 200,
      url: handler.finalUrl ?? url,
      headers: {get: name => hdrs.get(String(name).toLowerCase()) || null},
      text: async () => handler.body ?? ''
    };
  };
}

test('1. 既知エピソードのみの状態：公開NEWSがすべて登録済みなら無変更（no_updates）で終了する', async t => {
  const tmp = makeTempDir();
  t.after(() => fs.rmSync(tmp, {recursive: true, force: true}));
  const catalogPath = path.join(tmp, 'catalog.json');
  fs.copyFileSync(prodCatalogPath, catalogPath);
  const before = fs.readFileSync(catalogPath, 'utf8');

  const fetchImpl = createMockFetch({
    'https://fc.vspo.jp/post': {
      body: makeNewsListHtml([
        {url: 'https://fc.vspo.jp/post/news189', dateLabel: '2026年11月19日', title: 'ラジオコンテンツ更新のお知らせ'},
        {url: 'https://fc.vspo.jp/post/news188', dateLabel: '2026年11月12日', title: 'ラジオコンテンツ更新のお知らせ'},
        {url: 'https://fc.vspo.jp/post/news176', dateLabel: '2026年11月01日', title: '11月壁紙更新のお知らせ'}
      ])
    },
    'https://fc.vspo.jp/post/news189': {
      body: makeNewsArticleHtml({
        headerDate: '2026/11/19',
        bodyHtml: '<p>第76回ラジオを更新しました。</p><p><a href="https://fc.vspo.jp/gallery/radio119">https://fc.vspo.jp/gallery/radio119</a></p>'
      })
    },
    'https://fc.vspo.jp/post/news188': {
      body: makeNewsArticleHtml({
        headerDate: '2026/11/12',
        bodyHtml: '<p>第75回ラジオを更新しました。</p><p><a href="https://fc.vspo.jp/gallery/radio118">https://fc.vspo.jp/gallery/radio118</a><a href="https://fc.vspo.co.jp/ja/gallery/radio1"></a></p>'
      })
    }
  });

  const res = await syncCatalogFromPublicNews({
    catalogPath,
    write: true,
    fetchImpl,
    now: () => new Date('2026-11-19T12:00:00Z')
  });
  assert.equal(res.status, 'no_updates');
  assert.equal(res.updated, false);
  assert.equal(res.added, 0);
  assert.equal(res.total, BASE_COUNT);
  assert.equal(fs.readFileSync(catalogPath, 'utf8'), before);
});

test('2 & 10. 次回新着を追加するテスト＆既存全件維持：INITIAL_CATALOG固定のまま新着を取り込み、番組名・出演者を捏造せず既存データを完全保持する', async t => {
  const tmp = makeTempDir();
  t.after(() => fs.rmSync(tmp, {recursive: true, force: true}));
  const catalogPath = path.join(tmp, 'catalog.json');
  fs.copyFileSync(prodCatalogPath, catalogPath);
  const originalCatalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

  const fetchImpl = createMockFetch({
    'https://fc.vspo.jp/post': {
      body: makeNewsListHtml([
        {url: 'https://fc.vspo.jp/post/news901', dateLabel: '2026年11月26日', title: 'ラジオコンテンツ更新のお知らせ'},
        {url: 'https://fc.vspo.jp/post/news189', dateLabel: '2026年11月19日', title: 'ラジオコンテンツ更新のお知らせ'},
        {url: 'https://fc.vspo.jp/post/news188', dateLabel: '2026年11月12日', title: 'ラジオコンテンツ更新のお知らせ'}
      ])
    },
    'https://fc.vspo.jp/post/news901': {
      body: makeNewsArticleHtml({
        headerDate: '2026/11/26',
        bodyHtml: `<p>第77回ラジオを更新しました。</p><p>詳しくは下記ページよりご確認ください。</p><p><a href="https://fc.vspo.jp/gallery/${NEXT_RADIO_A}">https://fc.vspo.jp/gallery/${NEXT_RADIO_A}</a><a href="https://fc.vspo.jp/gallery/radio1"></a></p>`
      })
    },
    'https://fc.vspo.jp/post/news189': {
      body: makeNewsArticleHtml({
        headerDate: '2026/11/19',
        bodyHtml: '<p>第76回ラジオを更新しました。</p><p><a href="https://fc.vspo.jp/gallery/radio119">https://fc.vspo.jp/gallery/radio119</a></p>'
      })
    },
    'https://fc.vspo.jp/post/news188': {
      body: makeNewsArticleHtml({
        headerDate: '2026/11/12',
        bodyHtml: '<p>第75回ラジオを更新しました。</p><p><a href="https://fc.vspo.jp/gallery/radio118">https://fc.vspo.jp/gallery/radio118</a></p>'
      })
    }
  });

  const res = await syncCatalogFromPublicNews({
    catalogPath,
    write: true,
    fetchImpl,
    now: () => new Date('2026-11-26T12:00:00Z')
  });

  assert.equal(res.status, 'updated');
  assert.equal(res.added, 1);
  assert.deepEqual(res.addedKeys, [NEXT_RADIO_A]);
  assert.equal(res.total, BASE_COUNT + 1);
  assert.equal(INITIAL_CATALOG.length, 118);

  const updated = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  assert.equal(updated.items.length, BASE_COUNT + 1);
  assert.equal(updated.version, '2026-11-26-auto-news');

  const addedEntry = updated.items.find(x => episodeKey(x.url) === NEXT_RADIO_A);
  assert.deepEqual(addedEntry, {
    url: `https://fc.vspo.jp/gallery/${NEXT_RADIO_A}`,
    title: '第77回ラジオ',
    date: '2026-11-26',
    hosts: '',
    notes: ''
  });

  const updatedByKey = new Map(updated.items.map(x => [episodeKey(x.url), x]));
  for (const orig of originalCatalog.items) {
    assert.deepEqual(updatedByKey.get(episodeKey(orig.url)), orig);
  }
});

test('3. 同一URLの二重検出＆dry_run検証：一覧重複や /ja/ 揺れ、連続実行でも重複せず、dry_run時は一切書き換えない', async t => {
  const tmp = makeTempDir();
  t.after(() => fs.rmSync(tmp, {recursive: true, force: true}));
  const catalogPath = path.join(tmp, 'catalog.json');
  fs.copyFileSync(prodCatalogPath, catalogPath);
  const initialBytes = fs.readFileSync(catalogPath, 'utf8');

  const fixedNow = () => new Date('2026-11-28T00:00:00Z');
  const fetchImpl = createMockFetch({
    'https://fc.vspo.jp/post': {
      body: makeNewsListHtml([
        {url: 'https://fc.vspo.jp/post/news902', dateLabel: '2026年11月27日', title: 'ラジオコンテンツ再投稿のお知らせ'},
        {url: 'https://fc.vspo.jp/post/news901', dateLabel: '2026年11月26日', title: 'ラジオコンテンツ更新のお知らせ'}
      ])
    },
    'https://fc.vspo.jp/post/news902': {
      body: makeNewsArticleHtml({
        headerDate: '2026/11/27',
        bodyHtml: `<p>第77回ラジオを更新しました。</p><p>https://fc.vspo.jp/ja/gallery/${NEXT_RADIO_A}</p>`
      })
    },
    'https://fc.vspo.jp/post/news901': {
      body: makeNewsArticleHtml({
        headerDate: '2026/11/26',
        bodyHtml: `<p>第77回ラジオを更新しました。</p><p>https://fc.vspo.jp/gallery/${NEXT_RADIO_A}</p>`
      })
    }
  });

  const dry = await syncCatalogFromPublicNews({catalogPath, write: false, fetchImpl, now: fixedNow});
  assert.equal(dry.status, 'dry_run_updates');
  assert.equal(dry.updated, false);
  assert.equal(dry.added, 1);
  assert.equal(fs.readFileSync(catalogPath, 'utf8'), initialBytes);

  const first = await syncCatalogFromPublicNews({catalogPath, write: true, fetchImpl, now: fixedNow});
  assert.equal(first.added, 1);
  assert.equal(first.total, BASE_COUNT + 1);
  const snapshotAfterFirst = fs.readFileSync(catalogPath, 'utf8');

  const second = await syncCatalogFromPublicNews({catalogPath, write: true, fetchImpl, now: fixedNow});
  assert.equal(second.status, 'no_updates');
  assert.equal(second.added, 0);
  assert.equal(fs.readFileSync(catalogPath, 'utf8'), snapshotAfterFirst);
});

test('4 & 5. 出演者未確認・公開日未確認・回数未記載でも捏造せず、画面用の正規化・並び替え・検索が正常動作する', async t => {
  const tmp = makeTempDir();
  t.after(() => fs.rmSync(tmp, {recursive: true, force: true}));
  const catalogPath = path.join(tmp, 'catalog.json');
  fs.copyFileSync(prodCatalogPath, catalogPath);

  const fetchImpl = createMockFetch({
    'https://fc.vspo.jp/post': {
      body: makeNewsListHtml([
        {url: 'https://fc.vspo.jp/post/news905', dateLabel: '', title: 'ラジオ特別回および次回出演者変更のお知らせ'}
      ])
    },
    'https://fc.vspo.jp/post/news905': {
      body: makeNewsArticleHtml({
        headerDate: '',
        bodyHtml: `<p>次回出演者が変更となりました（変更後：花芽すみれ・花芽なずな）。</p><p>最新回はこちら：https://fc.vspo.jp/gallery/${NEXT_RADIO_B}</p>`
      })
    }
  });

  const res = await syncCatalogFromPublicNews({catalogPath, write: true, fetchImpl});
  assert.equal(res.added, 1);

  const updated = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const added = updated.items.find(x => episodeKey(x.url) === NEXT_RADIO_B);
  assert.deepEqual(added, {
    url: `https://fc.vspo.jp/gallery/${NEXT_RADIO_B}`,
    title: `ラジオ（${NEXT_RADIO_B}）`,
    date: '',
    hosts: '',
    notes: ''
  });

  const mergedForUi = mergeEntries([], updated.items, 'feed');
  assert.equal(mergedForUi.entries.length, BASE_COUNT + 1);
  assert.equal(filterSort(mergedForUi.entries).length, BASE_COUNT + 1);
  assert.equal(filterSort(mergedForUi.entries, {sort: 'oldest'}).length, BASE_COUNT + 1);
  assert.equal(filterSort(mergedForUi.entries, {sort: 'title'}).length, BASE_COUNT + 1);
  assert.deepEqual(filterSort(mergedForUi.entries, {search: NEXT_RADIO_B}).map(x => x.key), [NEXT_RADIO_B]);
});

test('6 & P1監査. 不正URL・別回アンカー混在・未来日付・無効日付をすべて厳格に拒否する', () => {
  const now = new Date('2026-11-19T12:00:00Z');

  const badArticleHtml = makeNewsArticleHtml({
    headerDate: '2026/11/19',
    bodyHtml: `
      <p>http://fc.vspo.jp/gallery/radio999</p>
      <p>https://fc.vspo.co.jp/gallery/radio999</p>
      <p>https://evil.example.com/gallery/radio999</p>
      <p>https://fc.vspo.jp/gallery/category/radio</p>
      <p>https://fc.vspo.jp/form/radio-questionnaire</p>
    `
  });
  assert.equal(parseNewsArticle(badArticleHtml, '2026-11-19', {now}), null);

  const mixedTextAndAnchorHtml = makeNewsArticleHtml({
    headerDate: '2026/11/19',
    bodyHtml: '<p>https://fc.vspo.jp/gallery/radio998 を公開しました。前回のアーカイブは<a href="https://fc.vspo.jp/gallery/radio997">こちら</a></p>'
  });
  assert.throws(() => parseNewsArticle(mixedTextAndAnchorHtml, '2026-11-19', {now}), {code: 'AMBIGUOUS_ARTICLE'});

  const futureHtml = makeNewsArticleHtml({
    headerDate: '2026/11/20',
    bodyHtml: '<p>第77回ラジオを更新しました。</p><p>https://fc.vspo.jp/gallery/radio998</p>'
  });
  assert.throws(() => parseNewsArticle(futureHtml, '', {now}), {code: 'INVALID_DATE'});
  assert.throws(() => parseAndValidatePublishDate('2099-01-01', {now, strictInvalidToken: true}), {code: 'INVALID_DATE'});

  const invalidCalendarHtml = makeNewsArticleHtml({
    headerDate: '2026/02/30',
    bodyHtml: '<p>https://fc.vspo.jp/gallery/radio998</p>'
  });
  assert.throws(() => parseNewsArticle(invalidCalendarHtml, '', {now}), {code: 'INVALID_DATE'});
  assert.throws(() => parseAndValidatePublishDate('2020-05-01', {now, strictInvalidToken: true}), {code: 'INVALID_DATE'});
});

test('7 & P1監査. 情報源停止・記事DOM構造変更・非公開/外部リダイレクト事前遮断・Cookie非出力を確認', async t => {
  const tmp = makeTempDir();
  t.after(() => fs.rmSync(tmp, {recursive: true, force: true}));
  const catalogPath = path.join(tmp, 'catalog.json');
  fs.copyFileSync(prodCatalogPath, catalogPath);
  const before = fs.readFileSync(catalogPath, 'utf8');

  await assert.rejects(
    () => syncCatalogFromPublicNews({
      catalogPath,
      write: true,
      fetchImpl: createMockFetch({'https://fc.vspo.jp/post': {ok: false, status: 503, body: 'Service Unavailable'}})
    }),
    {code: 'SOURCE_UNAVAILABLE'}
  );

  await assert.rejects(
    () => syncCatalogFromPublicNews({
      catalogPath,
      write: true,
      fetchImpl: async () => { throw new Error('ECONNRESET'); }
    }),
    {code: 'SOURCE_UNAVAILABLE'}
  );

  assert.throws(() => parseNewsList('<html><body><div>メンテナンス中</div></body></html>'), {code: 'SOURCE_UNAVAILABLE'});

  assert.throws(
    () => parseNewsArticle('<html><body><main><p>NEWS 2026/11/19</p><p>https://fc.vspo.jp/gallery/radio998</p></main></body></html>', '2026-11-19'),
    {code: 'SOURCE_UNAVAILABLE'}
  );

  let evilVisited = false;
  const redirectMock = createMockFetch({
    'https://fc.vspo.jp/post': {
      status: 302,
      headers: {location: 'https://evil.example.com/phish', 'set-cookie': '_session=SECRET_COOKIE_VALUE'}
    },
    'https://evil.example.com/phish': () => {
      evilVisited = true;
      return {ok: true, status: 200, text: async () => 'evil'};
    }
  });
  await assert.rejects(
    async () => {
      try {
        await fetchPublicHtml('https://fc.vspo.jp/post', {fetchImpl: redirectMock});
      } catch (err) {
        assert.ok(!String(err.message).includes('SECRET_COOKIE_VALUE'));
        throw err;
      }
    },
    {code: 'SOURCE_UNAVAILABLE'}
  );
  assert.equal(evilVisited, false);

  await assert.rejects(
    () => fetchPublicHtml('https://fc.vspo.jp/post/news189', {
      fetchImpl: createMockFetch({
        'https://fc.vspo.jp/post/news189': {status: 302, headers: {location: 'https://fc.vspo.jp/members-only'}}
      })
    }),
    {code: 'SOURCE_UNAVAILABLE'}
  );

  assert.equal(fs.readFileSync(catalogPath, 'utf8'), before);
});

test('9. カタログの破損防止：破損JSONへの書き込み拒否と整合性ガードが機能する', async t => {
  const tmp = makeTempDir();
  t.after(() => fs.rmSync(tmp, {recursive: true, force: true}));
  const brokenPath = path.join(tmp, 'catalog.json');
  fs.writeFileSync(brokenPath, '{ broken json ', 'utf8');

  await assert.rejects(
    () => syncCatalogFromPublicNews({
      catalogPath: brokenPath,
      write: true,
      fetchImpl: createMockFetch({})
    }),
    {code: 'CATALOG_CORRUPTED'}
  );
  assert.equal(fs.readFileSync(brokenPath, 'utf8'), '{ broken json ');

  const prod = JSON.parse(fs.readFileSync(prodCatalogPath, 'utf8'));
  assert.throws(() => validateCatalogIntegrity(prod, {version: 'v', items: prod.items.slice(1)}), /減少/);
  const tampered = prod.items.map(x => x.url.endsWith('/radio99') ? {...x, notes: ''} : x);
  assert.throws(() => validateCatalogIntegrity(prod, {version: 'v', items: tampered}), /notes/);
});

test('11. iPhoneでの新着同期：既存データ・お気に入り・視聴済み・メモ・非表示を維持したまま新着回が自動反映される', () => {
  const baseCatalog = JSON.parse(fs.readFileSync(prodCatalogPath, 'utf8'));
  const initialSync = mergeEntries([], baseCatalog.items, 'feed');
  const iphoneEntries = initialSync.entries.map(e => {
    if (e.key === 'radio118') return {...e, favorite: true, heard: true, notes: '最新のお気に入りメモ', lastOpened: 1763400000000};
    if (e.key === 'radio99') return {...e, favorite: true};
    return e;
  });
  const iphoneHidden = ['radio5'];

  const remoteCatalogItems = [
    {url: `https://fc.vspo.jp/gallery/${NEXT_RADIO_A}`, title: '第77回ラジオ', date: '2026-11-26', hosts: '', notes: ''},
    ...baseCatalog.items
  ];

  const afterSync = mergeEntries(iphoneEntries, remoteCatalogItems, 'feed');
  assert.equal(afterSync.added, 1);
  assert.equal(afterSync.enriched, 0);
  assert.equal(afterSync.entries.length, BASE_COUNT + 1);

  const byKey = new Map(afterSync.entries.map(e => [e.key, e]));
  assert.equal(byKey.get(NEXT_RADIO_A).title, '第77回ラジオ');
  assert.equal(byKey.get('radio118').favorite, true);
  assert.equal(byKey.get('radio118').heard, true);
  assert.equal(byKey.get('radio118').notes, '最新のお気に入りメモ');
  assert.equal(byKey.get('radio99').favorite, true);

  const visibleOnIphone = filterSort(afterSync.entries.filter(e => !iphoneHidden.includes(e.key)));
  assert.equal(visibleOnIphone.length, BASE_COUNT);
  assert.equal(visibleOnIphone[0].key, NEXT_RADIO_A);

  const resync = mergeEntries(afterSync.entries, remoteCatalogItems, 'feed');
  assert.equal(resync.added, 0);
  assert.equal(resync.entries.length, BASE_COUNT + 1);
});

test('8 & 12 & Pages成果物生成. ロック・push失敗ロールバック・手動更新との競合再判定・最新コミットからのPages成果物生成', async t => {
  const tmp = makeTempDir('vspo-git-sync-');
  t.after(() => fs.rmSync(tmp, {recursive: true, force: true}));

  const lockTarget = path.join(tmp, 'lock-catalog.json');
  fs.copyFileSync(prodCatalogPath, lockTarget);
  await withCatalogLock(lockTarget, async () => {
    await assert.rejects(
      () => syncCatalogFromPublicNews({catalogPath: lockTarget, write: true, fetchImpl: createMockFetch({})}),
      {code: 'CATALOG_LOCKED'}
    );
  });

  const bareDir = path.join(tmp, 'remote.git');
  const cloneA = path.join(tmp, 'cloneA');
  const cloneB = path.join(tmp, 'cloneB');
  const gitIn = (dir, args) => execFileSync('git', args, {cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();

  fs.mkdirSync(bareDir);
  gitIn(bareDir, ['init', '--bare', '-b', 'main']);

  fs.mkdirSync(cloneA);
  gitIn(cloneA, ['init', '-b', 'main']);
  gitIn(cloneA, ['config', 'user.name', 'Manual Maintainer']);
  gitIn(cloneA, ['config', 'user.email', 'maintainer@example.com']);
  for (const f of PUBLIC_SITE_FILES) {
    fs.copyFileSync(path.join(rootDir, f), path.join(cloneA, f));
  }
  fs.mkdirSync(path.join(cloneA, 'assets'), {recursive: true});
  for (const asset of fs.readdirSync(path.join(rootDir, 'assets'))) {
    fs.copyFileSync(path.join(rootDir, 'assets', asset), path.join(cloneA, 'assets', asset));
  }
  gitIn(cloneA, ['add', '.']);
  gitIn(cloneA, ['commit', '-m', 'initial catalog']);
  gitIn(cloneA, ['remote', 'add', 'origin', bareDir]);
  gitIn(cloneA, ['push', '-u', 'origin', 'main']);

  gitIn(tmp, ['clone', bareDir, cloneB]);
  gitIn(cloneB, ['config', 'user.name', 'Auto Sync Bot']);
  gitIn(cloneB, ['config', 'user.email', 'bot@example.com']);

  const fixedNow = () => new Date('2026-12-05T00:00:00Z');
  const mockNewsNextA = createMockFetch({
    'https://fc.vspo.jp/post': {
      body: makeNewsListHtml([
        {url: 'https://fc.vspo.jp/post/news901', dateLabel: '2026年11月26日', title: 'ラジオコンテンツ更新のお知らせ'}
      ])
    },
    'https://fc.vspo.jp/post/news901': {
      body: makeNewsArticleHtml({
        headerDate: '2026/11/26',
        bodyHtml: `<p>第77回ラジオを更新しました。</p><p>https://fc.vspo.jp/gallery/${NEXT_RADIO_A}</p>`
      })
    }
  });

  const hookPath = path.join(bareDir, 'hooks', 'pre-receive');
  fs.writeFileSync(hookPath, '#!/bin/sh\necho "remote outage" >&2\nexit 1\n', {mode: 0o755});

  await assert.rejects(
    () => publishCatalogUpdate({
      repoDir: cloneB,
      fetchImpl: mockNewsNextA,
      now: fixedNow,
      runTests: () => {}
    }),
    {code: 'GIT_PUSH_FAILED'}
  );
  assert.equal(gitIn(cloneB, ['status', '--porcelain']), '');
  assert.equal(JSON.parse(fs.readFileSync(path.join(cloneB, 'catalog.json'), 'utf8')).items.length, BASE_COUNT);

  fs.unlinkSync(hookPath);

  const catalogA = JSON.parse(fs.readFileSync(path.join(cloneA, 'catalog.json'), 'utf8'));
  catalogA.items.unshift({
    url: `https://fc.vspo.jp/gallery/${NEXT_RADIO_A}`,
    title: '【第77回】ぶいすぽっ！の雑談部今日も解散できません！',
    date: '2026-11-26',
    hosts: '兎咲ミミ/蝶屋はなび',
    notes: ''
  });
  catalogA.version = '2026-11-26-manual';
  fs.writeFileSync(path.join(cloneA, 'catalog.json'), `${JSON.stringify(catalogA, null, 2)}\n`, 'utf8');
  gitIn(cloneA, ['add', 'catalog.json']);
  gitIn(cloneA, ['commit', '-m', `feat: manual add ${NEXT_RADIO_A}`]);
  gitIn(cloneA, ['push', 'origin', 'main']);
  const remoteShaAfterA = gitIn(cloneA, ['rev-parse', 'HEAD']);

  const resultB = await publishCatalogUpdate({
    repoDir: cloneB,
    fetchImpl: mockNewsNextA,
    now: fixedNow,
    runTests: () => {}
  });
  assert.equal(resultB.status, 'no_updates');
  assert.equal(resultB.pushed, false);
  assert.equal(gitIn(cloneB, ['rev-parse', 'HEAD']), remoteShaAfterA);

  const mockNewsNextB = createMockFetch({
    'https://fc.vspo.jp/post': {
      body: makeNewsListHtml([
        {url: 'https://fc.vspo.jp/post/news902', dateLabel: '2026年12月03日', title: 'ラジオコンテンツ更新のお知らせ'}
      ])
    },
    'https://fc.vspo.jp/post/news902': {
      body: makeNewsArticleHtml({
        headerDate: '2026/12/03',
        bodyHtml: `<p>第78回ラジオを更新しました。</p><p>https://fc.vspo.jp/gallery/${NEXT_RADIO_B}</p>`
      })
    }
  });

  let injectedConcurrentPush = false;
  const baseGitB = args => gitIn(cloneB, args);
  const racingGit = args => {
    if (args[0] === 'push' && !injectedConcurrentPush) {
      injectedConcurrentPush = true;
      fs.writeFileSync(path.join(cloneA, 'README-temp.txt'), 'concurrent manual commit\n', 'utf8');
      gitIn(cloneA, ['add', 'README-temp.txt']);
      gitIn(cloneA, ['commit', '-m', 'docs: concurrent manual update']);
      gitIn(cloneA, ['push', 'origin', 'main']);
    }
    return baseGitB(args);
  };

  const retried = await publishCatalogUpdate({
    repoDir: cloneB,
    fetchImpl: mockNewsNextB,
    now: fixedNow,
    git: racingGit,
    runTests: () => {}
  });
  assert.equal(retried.status, 'pushed');
  assert.equal(retried.pushed, true);
  assert.equal(retried.attempts, 2);
  assert.equal(retried.commitSha, gitIn(bareDir, ['rev-parse', 'main']));

  const deployCheckout = path.join(tmp, 'deploy-checkout');
  gitIn(tmp, ['clone', bareDir, deployCheckout]);
  gitIn(deployCheckout, ['checkout', retried.commitSha]);
  fs.writeFileSync(path.join(deployCheckout, 'archive-candidates.json'), '{"items":[]}', 'utf8');
  const stagedOut = path.join(tmp, '_site');
  const staged = stagePagesSite(deployCheckout, stagedOut);
  assert.equal(staged.catalogCount, BASE_COUNT + 2);
  assert.ok(fs.existsSync(path.join(stagedOut, 'index.html')));
  assert.ok(fs.existsSync(path.join(stagedOut, 'assets', 'icon-192.png')));
  assert.ok(!fs.existsSync(path.join(stagedOut, 'archive-candidates.json')));
  assert.ok(!fs.existsSync(path.join(stagedOut, '.git')));
});

test('P0最終監査：package-lock.json非依存構成と GitHub Actions YAML の構文・最小権限・古いSHA防止設定を検証', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
  assert.equal(fs.existsSync(path.join(rootDir, 'package-lock.json')), false);

  const syncYml = fs.readFileSync(path.join(rootDir, '.github', 'workflows', 'sync-new-radio.yml'), 'utf8');
  const deployYml = fs.readFileSync(path.join(rootDir, '.github', 'workflows', 'deploy-pages.yml'), 'utf8');

  for (const yml of [syncYml, deployYml]) {
    assert.ok(!/\bnpm\s+ci\b/.test(yml));
    assert.ok(!/cache\s*:\s*['"]?npm['"]?/.test(yml));
  }

  assert.match(deployYml, /\bworkflow_call\s*:/);
  assert.match(deployYml, /\bexpected_sha\s*:/);
  assert.match(deployYml, /Checked-out SHA[\s\S]*does not match expected newly pushed SHA/);

  assert.match(syncYml, /^permissions:\r?\n\s+contents:\s*read\b/m);
  assert.match(deployYml, /^permissions:\r?\n\s+contents:\s*read\b/m);
  assert.match(syncYml, /sync-catalog:[\s\S]*?permissions:\r?\n\s+contents:\s*write\b/);
  assert.match(syncYml, /deploy-pages:[\s\S]*?uses:\s*\.\/\.github\/workflows\/deploy-pages\.yml[\s\S]*?ref:\s*\$\{\{\s*needs\.sync-catalog\.outputs\.commit_sha\s*\}\}/);
});

test('本番 catalog.json にテスト用の架空データが一切混入・変更されていないこと（119件現状維持）', () => {
  const afterBytes = fs.readFileSync(prodCatalogPath);
  const afterHash = crypto.createHash('sha256').update(afterBytes).digest('hex');
  assert.equal(afterHash, prodCatalogHashBefore);
  const prodCatalog = JSON.parse(afterBytes.toString('utf8'));
  assert.ok(prodCatalog.items.length >= 119);
  assert.equal(prodCatalog.items.length, BASE_COUNT);
});
