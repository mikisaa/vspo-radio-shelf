/** Detect newly published radio links from public official NEWS pages and append safely to catalog.json.
 * Never logs in, never accesses member-only pages/APIs/media, and never guesses sequential URLs or unconfirmed metadata.
 *
 * Usage:
 *   node scripts/sync-public-news.mjs                        # dry-run against public NEWS
 *   node scripts/sync-public-news.mjs --write                # validate and update local catalog.json atomically
 *   node scripts/sync-public-news.mjs --write --git-publish  # fetch, sync, test, commit, and push with conflict retry
 */
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {normalizeOfficialUrl, episodeKey, cleanDate, cleanText} from '../core.js';
import {mergeArchive, validateCatalogIntegrity, writeCatalogAtomically} from './import-archive.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_CATALOG_PATH = path.join(projectRoot, 'catalog.json');
export const PUBLIC_NEWS_LIST_URL = 'https://fc.vspo.jp/post';
export const MIN_VALID_DATE = '2024-01-01';

function makeError(code, message, cause) {
  const err = new Error(message);
  err.code = code;
  if (cause) err.cause = cause;
  return err;
}

function decodeBasicEntities(text) {
  return String(text || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function stripNonVisibleHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<template[\s\S]*?<\/template>/gi, ' ')
    .replace(/<[a-z0-9-]+\b[^>]*(?:\bhidden\b|display\s*:\s*none)[^>]*>[\s\S]*?<\/[a-z0-9-]+>/gi, ' ');
}

function stripTagsToText(html) {
  return decodeBasicEntities(
    stripNonVisibleHtml(html).replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}

export function getJstTodayString(now = new Date()) {
  const jstMs = now.getTime() + 9 * 60 * 60 * 1000;
  return new Date(jstMs).toISOString().slice(0, 10);
}

export function parseAndValidatePublishDate(text, {now = new Date(), strictInvalidToken = false} = {}) {
  if (typeof text !== 'string' || !text.trim()) return '';
  const normalized = text.normalize('NFKC');
  const m = normalized.match(/\b(20\d{2})\s*[\/\-年.]\s*(\d{1,2})\s*[\/\-月.]\s*(\d{1,2})\s*日?/);
  if (!m) return '';
  const candidate = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  const validIso = cleanDate(candidate);
  if (!validIso) {
    if (strictInvalidToken) {
      throw makeError('INVALID_DATE', `公開日に存在しない無効な日付が含まれています: ${m[0]}`);
    }
    return '';
  }
  const todayJst = getJstTodayString(now);
  if (validIso < MIN_VALID_DATE || validIso > todayJst) {
    throw makeError('INVALID_DATE', `公開日が許容範囲外（未来日付またはサービス開始前）です: ${validIso} (JST当日: ${todayJst})`);
  }
  return validIso;
}

export function isAllowedPublicNewsUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  try {
    const parsed = new URL(raw.trim(), 'https://fc.vspo.jp');
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'fc.vspo.jp' || parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) {
      return null;
    }
    if (/^\/(?:ja\/)?post(?:\/category\/news)?\/?$/.test(parsed.pathname) || /^\/(?:ja\/)?post\/news[1-9][0-9]*\/?$/.test(parsed.pathname)) {
      return `https://fc.vspo.jp${parsed.pathname.replace(/\/$/, '')}`;
    }
    return null;
  } catch {
    return null;
  }
}

export function isAllowedNewsArticleUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  try {
    const parsed = new URL(raw.trim(), 'https://fc.vspo.jp');
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'fc.vspo.jp' || parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) {
      return null;
    }
    if (!/^\/(?:ja\/)?post\/news[1-9][0-9]*\/?$/.test(parsed.pathname)) return null;
    return `https://fc.vspo.jp${parsed.pathname.replace(/\/$/, '')}`;
  } catch {
    return null;
  }
}

export function parseNewsList(html, {now = new Date()} = {}) {
  if (typeof html !== 'string' || html.trim().length < 100) {
    throw makeError('SOURCE_UNAVAILABLE', '公開NEWS一覧のHTMLが空または不正です。');
  }
  const anchorRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const seen = new Set();
  const radioArticles = [];
  let totalNewsLinks = 0;

  for (const match of html.matchAll(anchorRegex)) {
    const articleUrl = isAllowedNewsArticleUrl(match[1]);
    if (!articleUrl) continue;
    totalNewsLinks++;
    if (seen.has(articleUrl)) continue;
    const innerHtml = match[2] || '';
    const altText = [...innerHtml.matchAll(/\balt=["']([^"']*)["']/gi)].map(m => m[1]).join(' ');
    const visibleText = `${stripTagsToText(innerHtml)} ${decodeBasicEntities(altText)}`.trim();
    if (!visibleText.includes('ラジオ')) continue;
    seen.add(articleUrl);
    radioArticles.push({
      articleUrl,
      listDate: parseAndValidatePublishDate(visibleText, {now, strictInvalidToken: true}),
      headline: cleanText(visibleText, 160)
    });
  }

  if (totalNewsLinks === 0) {
    throw makeError('SOURCE_UNAVAILABLE', '公開NEWS一覧から記事リンクを検出できませんでした（サイト停止またはHTML構造変更の可能性があります）。');
  }

  return radioArticles;
}

export function parseNewsArticle(html, fallbackDate = '', {now = new Date()} = {}) {
  if (typeof html !== 'string' || html.trim().length < 50) {
    throw makeError('SOURCE_UNAVAILABLE', '公開NEWS記事のHTMLが空または不正です。');
  }
  const cleanedHtml = stripNonVisibleHtml(html);

  // Require the expected public NEWS article container (.post-show); never guess from arbitrary page chrome if layout changes.
  const bodyMatch = cleanedHtml.match(/<div[^>]*class=["'][^"']*\bpost-show\b[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/i)
    || cleanedHtml.match(/<div[^>]*class=["'][^"']*\bpost-show\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
  if (!bodyMatch) {
    throw makeError('SOURCE_UNAVAILABLE', '公開NEWS記事の本文コンテナ（.post-show）が確認できません。ページ構造変更のため停止しました。');
  }

  const bodyHtml = bodyMatch[1];
  const visibleBodyText = stripTagsToText(bodyHtml);
  const fullVisibleText = stripTagsToText(cleanedHtml);

  // 1) Collect radio URLs from BOTH visible text and non-empty <a> tags so:
  //    - empty template anchor remnants (<a href=".../radio1"></a>) are ignored
  //    - any article mentioning two different episodes (text or labeled link) triggers AMBIGUOUS_ARTICLE
  const uniqueByKey = new Map();
  const urlMatches = visibleBodyText.match(/https:\/\/[^\s<>"']+/gi) || [];
  for (const rawToken of urlMatches) {
    const normalized = normalizeOfficialUrl(rawToken.replace(/[、。,;!?）\]}>]+$/, ''));
    if (!normalized) continue;
    uniqueByKey.set(episodeKey(normalized), normalized);
  }

  const anchorRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of bodyHtml.matchAll(anchorRegex)) {
    if (!stripTagsToText(m[2])) continue;
    const normalized = normalizeOfficialUrl(m[1]);
    if (normalized) uniqueByKey.set(episodeKey(normalized), normalized);
  }

  if (uniqueByKey.size === 0) return null;
  if (uniqueByKey.size > 1) {
    throw makeError('AMBIGUOUS_ARTICLE', `1つの公開NEWS記事内に複数の異なるラジオURLが含まれているため自動登録を停止しました: ${[...uniqueByKey.keys()].join(', ')}`);
  }

  const [[key, url]] = [...uniqueByKey.entries()];

  // 2) Publication date: validate strictly against invalid calendar dates and future dates.
  const headerDateMatch = fullVisibleText.match(/\bNEWS\s+(20\d{2}[\/\-年.]\d{1,2}[\/\-月.]\d{1,2}日?)/i);
  let date = '';
  if (headerDateMatch) {
    date = parseAndValidatePublishDate(headerDateMatch[1], {now, strictInvalidToken: true});
  } else if (fallbackDate) {
    date = parseAndValidatePublishDate(fallbackDate, {now, strictInvalidToken: true});
  }

  // 3) Title: never invent show names or confuse URL radioN with episode round number.
  let title = '';
  const explicitShowMatch = visibleBodyText.match(/(【第\s*[0-9０-９]+\s*回】[^\s【】]{2,80})/);
  const roundMatch = visibleBodyText.match(/第\s*([0-9０-９]+)\s*回\s*ラジオ/);
  if (explicitShowMatch) {
    title = cleanText(explicitShowMatch[1].normalize('NFKC'), 120);
  } else if (roundMatch) {
    title = `第${roundMatch[1].normalize('NFKC')}回ラジオ`;
  } else {
    title = `ラジオ（${key}）`;
  }

  // 4) Hosts: public NEWS does not provide structured episode cast. Never guess.
  return {
    key,
    url,
    title,
    date,
    hosts: ''
  };
}

export async function fetchPublicHtml(initialUrl, {fetchImpl = globalThis.fetch, timeoutMs = 15000, maxRedirects = 3} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw makeError('SOURCE_UNAVAILABLE', 'fetch 実装が利用できません。');
  }
  let currentUrl = isAllowedPublicNewsUrl(initialUrl);
  if (!currentUrl) {
    throw makeError('INVALID_SOURCE_URL', `許可されていない取得先URLです: ${initialUrl}`);
  }

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        headers: {
          'Accept': 'text/html,application/xhtml+xml',
          'User-Agent': 'vspo-radio-shelf-public-news-check/1.5 (+https://github.com/mikisaa/vspo-radio-shelf)'
        },
        signal: controller.signal
      });
    } catch (err) {
      throw makeError('SOURCE_UNAVAILABLE', `公開NEWSへの接続に失敗しました (${currentUrl}): ${err?.name === 'AbortError' ? 'TIMEOUT' : (err?.message || 'NETWORK_ERROR')}`);
    } finally {
      clearTimeout(timer);
    }

    if (!response) {
      throw makeError('SOURCE_UNAVAILABLE', `公開NEWSから応答がありません (${currentUrl})`);
    }

    // Handle HTTP redirects manually to verify target domain and path BEFORE sending any follow-up request.
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (hop >= maxRedirects) {
        throw makeError('SOURCE_UNAVAILABLE', `リダイレクト回数が上限(${maxRedirects})を超えたため停止しました (${currentUrl})`);
      }
      const locationHeader = typeof response.headers?.get === 'function' ? response.headers.get('location') : response.location;
      if (!locationHeader) {
        throw makeError('SOURCE_UNAVAILABLE', `リダイレクト先 Location ヘッダーが不正です (${currentUrl})`);
      }
      const resolvedNext = new URL(locationHeader, currentUrl).href;
      const allowedNext = isAllowedPublicNewsUrl(resolvedNext);
      if (!allowedNext) {
        throw makeError('SOURCE_UNAVAILABLE', `許可されていないリダイレクト先（別ドメインまたは非公開ページ）を検知したため停止しました: ${new URL(resolvedNext).origin}${new URL(resolvedNext).pathname}`);
      }
      currentUrl = allowedNext;
      continue;
    }

    if (!response.ok) {
      throw makeError('SOURCE_UNAVAILABLE', `公開NEWSの取得に失敗しました: HTTP ${response.status} (${currentUrl})`);
    }

    if (response.url) {
      const verifiedFinal = isAllowedPublicNewsUrl(response.url);
      if (!verifiedFinal) {
        throw makeError('SOURCE_UNAVAILABLE', `公開NEWS以外のURL応答を検知したため停止しました: ${new URL(response.url).origin}${new URL(response.url).pathname}`);
      }
    }

    // Never read or log Set-Cookie or auth headers; return body text only.
    return await response.text();
  }

  throw makeError('SOURCE_UNAVAILABLE', 'リダイレクト検証上限に達しました。');
}

export async function withCatalogLock(catalogPath, fn, {staleMs = 10 * 60 * 1000} = {}) {
  const lockPath = `${catalogPath}.lock`;
  let fd = null;
  try {
    try {
      fd = fs.openSync(lockPath, 'wx');
    } catch (err) {
      if (err?.code === 'EEXIST') {
        try {
          const stat = fs.statSync(lockPath);
          if (staleMs > 0 && Date.now() - stat.mtimeMs > staleMs) {
            fs.unlinkSync(lockPath);
            fd = fs.openSync(lockPath, 'wx');
          }
        } catch {
          // Another process still holds or just rotated the lock.
        }
        if (fd === null) {
          throw makeError('CATALOG_LOCKED', `別の同期処理が実行中です (${path.basename(lockPath)})。競合防止のため中断します。`);
        }
      } else {
        throw err;
      }
    }
    fs.writeFileSync(fd, JSON.stringify({pid: process.pid, startedAt: new Date().toISOString()}), 'utf8');
    return await fn();
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
      try { if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath); } catch { /* ignore */ }
    }
  }
}

export function readAndValidateExistingCatalog(catalogPath) {
  let raw;
  try {
    raw = fs.readFileSync(catalogPath, 'utf8');
  } catch (err) {
    throw makeError('CATALOG_CORRUPTED', `catalog.json を読み込めません: ${err.message}`, err);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw makeError('CATALOG_CORRUPTED', `既存の catalog.json が不正なJSONです: ${err.message}`, err);
  }
  try {
    validateCatalogIntegrity(null, parsed);
  } catch (err) {
    throw makeError('CATALOG_CORRUPTED', `既存の catalog.json の整合性検証に失敗しました: ${err.message}`, err);
  }
  return parsed;
}

export async function syncCatalogFromPublicNews({
  catalogPath = DEFAULT_CATALOG_PATH,
  listUrl = PUBLIC_NEWS_LIST_URL,
  write = false,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
  maxArticles = 5,
  earlyStopKnownCount = 2,
  now = () => new Date()
} = {}) {
  return withCatalogLock(catalogPath, async () => {
    const currentNow = now();
    const currentCatalog = readAndValidateExistingCatalog(catalogPath);
    const knownKeys = new Set(currentCatalog.items.map(item => episodeKey(item.url)));

    const listHtml = await fetchPublicHtml(listUrl, {fetchImpl, timeoutMs});
    const articles = parseNewsList(listHtml, {now: currentNow}).slice(0, Math.max(1, maxArticles));

    const discovered = [];
    const seenCandidateKeys = new Set();
    const checkedArticles = [];
    const skippedKnown = [];
    let consecutiveKnown = 0;

    for (const article of articles) {
      const articleHtml = await fetchPublicHtml(article.articleUrl, {fetchImpl, timeoutMs});
      const extracted = parseNewsArticle(articleHtml, article.listDate, {now: currentNow});
      checkedArticles.push(article.articleUrl);
      if (!extracted) continue;

      if (knownKeys.has(extracted.key)) {
        skippedKnown.push(extracted.key);
        consecutiveKnown++;
        if (earlyStopKnownCount > 0 && consecutiveKnown >= earlyStopKnownCount) break;
        continue;
      }

      consecutiveKnown = 0;
      if (seenCandidateKeys.has(extracted.key)) continue;
      seenCandidateKeys.add(extracted.key);
      discovered.push({
        url: extracted.url,
        title: extracted.title,
        date: extracted.date,
        hosts: extracted.hosts
      });
    }

    if (discovered.length === 0) {
      return {
        status: 'no_updates',
        updated: false,
        added: 0,
        addedKeys: [],
        total: currentCatalog.items.length,
        checkedArticles,
        skippedKnown
      };
    }

    const {catalog: nextCatalog, summary} = mergeArchive(currentCatalog, {items: discovered});
    if (summary.conflicts.length > 0) {
      throw makeError('CATALOG_CONFLICT', `既存データとの競合が検出されたため停止しました:\n${summary.conflicts.join('\n')}`);
    }
    if (summary.added === 0 && summary.enriched === 0) {
      return {
        status: 'no_updates',
        updated: false,
        added: 0,
        addedKeys: [],
        total: currentCatalog.items.length,
        checkedArticles,
        skippedKnown
      };
    }

    validateCatalogIntegrity(currentCatalog, nextCatalog);
    const dateStamp = getJstTodayString(currentNow);
    nextCatalog.version = `${dateStamp}-auto-news`;

    if (write) {
      writeCatalogAtomically(catalogPath, nextCatalog);
    }

    return {
      status: write ? 'updated' : 'dry_run_updates',
      updated: Boolean(write),
      added: summary.added,
      addedKeys: discovered.map(d => episodeKey(d.url)),
      addedItems: discovered,
      total: nextCatalog.items.length,
      version: nextCatalog.version,
      checkedArticles,
      skippedKnown
    };
  });
}

function defaultGitRunner(repoDir) {
  return args => execFileSync('git', args, {cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
}

function defaultTestRunner(repoDir) {
  return () => execFileSync(process.execPath, ['--test', 'tests/core.test.js', 'tests/import-archive.test.js', 'tests/migration-catalog.test.js'], {
    cwd: repoDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function isNonFastForwardError(err) {
  const msg = `${err?.message || ''}\n${err?.stderr || ''}\n${err?.stdout || ''}`;
  return /non-fast-forward|fetch first|\[rejected\]|cannot lock ref|Updates were rejected/i.test(msg);
}

export async function publishCatalogUpdate({
  repoDir = projectRoot,
  remote = 'origin',
  branch = 'main',
  maxRetries = 3,
  fetchImpl = globalThis.fetch,
  listUrl = PUBLIC_NEWS_LIST_URL,
  now = () => new Date(),
  git = defaultGitRunner(repoDir),
  runTests = defaultTestRunner(repoDir)
} = {}) {
  const catalogPath = path.join(repoDir, 'catalog.json');

  // Protect any unrelated local modifications before starting.
  const dirty = git(['status', '--porcelain']);
  if (dirty) {
    throw makeError('DIRTY_WORKTREE', '未コミットの変更が存在するため自動pushを中止しました。');
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      git(['fetch', remote, branch]);
      git(['reset', '--hard', `${remote}/${branch}`]);
    } catch (err) {
      throw makeError('GIT_FETCH_FAILED', `リモートの最新取得に失敗しました (${remote}/${branch})`, err);
    }

    const syncResult = await syncCatalogFromPublicNews({
      catalogPath,
      listUrl,
      write: true,
      fetchImpl,
      now
    });

    if (!syncResult.updated || syncResult.added === 0) {
      return {
        status: 'no_updates',
        pushed: false,
        attempts: attempt,
        syncResult
      };
    }

    try {
      runTests();
    } catch (err) {
      try { git(['checkout', '--', 'catalog.json']); } catch { /* ignore */ }
      throw makeError('TEST_FAILED', '更新後の自動テストが失敗したため catalog.json をロールバックしました。', err);
    }

    const diffCheck = git(['status', '--porcelain', 'catalog.json']);
    if (!diffCheck) {
      return {
        status: 'no_updates',
        pushed: false,
        attempts: attempt,
        syncResult
      };
    }

    const keysLabel = syncResult.addedKeys.join(', ');
    git(['add', 'catalog.json']);
    git(['commit', '-m', `chore(catalog): auto-add ${keysLabel} from public news`]);
    const commitSha = git(['rev-parse', 'HEAD']);

    try {
      git(['push', remote, `HEAD:${branch}`]);
      return {
        status: 'pushed',
        pushed: true,
        commitSha,
        attempts: attempt,
        syncResult
      };
    } catch (err) {
      // Roll back the local unpushed commit immediately so the repository stays clean.
      try {
        git(['fetch', remote, branch]);
        git(['reset', '--hard', `${remote}/${branch}`]);
      } catch {
        try { git(['reset', '--hard', 'HEAD~1']); } catch { /* ignore */ }
      }

      if (isNonFastForwardError(err) && attempt < maxRetries) {
        // Manual commit landed on main concurrently; retry against fresh main.
        continue;
      }

      throw makeError('GIT_PUSH_FAILED', 'GitHubへのpushに失敗したためローカル変更をロールバックしました。', err);
    }
  }

  throw makeError('GIT_PUSH_CONFLICT', '同時更新の競合リトライ上限に達したため安全停止しました。');
}

async function main() {
  const args = process.argv.slice(2);
  const allowedFlags = new Set(['--write', '--git-publish', '--json']);
  if (args.some(a => !allowedFlags.has(a))) {
    console.error('使い方: node scripts/sync-public-news.mjs [--write] [--git-publish] [--json]');
    process.exitCode = 2;
    return;
  }

  const write = args.includes('--write');
  const gitPublish = args.includes('--git-publish');
  const asJson = args.includes('--json');

  if (gitPublish && !write) {
    console.error('--git-publish を使う場合は --write も指定してください。');
    process.exitCode = 2;
    return;
  }

  const output = gitPublish
    ? await publishCatalogUpdate()
    : await syncCatalogFromPublicNews({write});

  console.log(JSON.stringify(output, null, 2));
  if (!asJson && !write) {
    console.log('DRY RUN：catalog.json は変更していません。反映する場合は --write を付けてください。');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(`[${err?.code || 'ERROR'}] ${err?.message || 'Unexpected error'}`);
    process.exitCode = 1;
  });
}
