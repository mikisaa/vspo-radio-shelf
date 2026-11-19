import {INITIAL_CATALOG, normalizeOfficialUrl, episodeKey, normalizeEpisode, normalizeUserEdited, isProvisionalTitle, splitOfficialDisplayTitle, mergeEntries, applyBackup, extractFromAnnouncement, extractOfficialRadioLinks, filterSort} from './core.js';

const STORAGE_KEY = 'radio-shelf-v1';
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const svg = id => `<svg class="icon" aria-hidden="true"><use href="#i-${id}"/></svg>`;
const state = {
  entries: [], hidden: [], filter: 'all', query: '', sort: 'newest',
  editingKey: null, lastSync: '', syncTimer: null, toastTimer: null
};

function readSaved() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    const entries = Array.isArray(data.entries) ? data.entries.slice(0, 10000).map(x => normalizeEpisode(x, x?.source)).filter(Boolean) : [];
    const hidden = Array.isArray(data.hidden) ? data.hidden.filter(x => /^radio\d+$/.test(x)).slice(0, 10000) : [];
    return {entries, hidden, lastSync: typeof data.lastSync === 'string' ? data.lastSync : ''};
  } catch { return {entries: [], hidden: [], lastSync: ''}; }
}
function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({version: 1, entries: state.entries, hidden: state.hidden, lastSync: state.lastSync})); }
  catch { toast('ブラウザに保存できません。バックアップを書き出してください。'); }
}
function iconNode(name) { const box = document.createElement('span'); box.innerHTML = svg(name); return box.firstElementChild; }
function makeButton(text, icon, cls, aria, handler) {
  const b = document.createElement('button'); b.type = 'button'; b.className = cls;
  if (aria) b.setAttribute('aria-label', aria);
  if (icon) b.append(iconNode(icon));
  if (text) {const t = document.createElement('span'); t.textContent = text; b.append(t);}
  b.addEventListener('click', handler); return b;
}
function toast(message) {
  const el = $('#toast'); el.textContent = message; el.classList.add('visible');
  clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => el.classList.remove('visible'), 3500);
}
function dateLabel(iso) {
  if (!iso) return '公開日未登録';
  return iso.replace(/-/g, '.');
}
function render() {
  const visible = state.entries.filter(e => !state.hidden.includes(e.key));
  $('#total-count').textContent = visible.length;
  $('#unheard-count').textContent = visible.filter(e => !e.heard).length;
  $('#fav-count').textContent = visible.filter(e => e.favorite).length;
  $('#tab-all').textContent = visible.length;
  $('#last-sync').textContent = state.lastSync ? `前回確認: ${new Date(state.lastSync).toLocaleString('ja-JP')}` : '未確認';
  const filtered = filterSort(visible, {filter: state.filter, search: state.query, sort: state.sort});
  const list = $('#list'); list.replaceChildren();
  $('#empty').hidden = !!filtered.length;
  $('#empty-detail').textContent = visible.length === 0 ? '公式のラジオURLを登録して、自分用のライブラリを作りましょう。' : '検索条件を変更するか、ラジオを追加してください。';
  for (const e of filtered) list.append(renderEpisode(e));
}
function renderEpisode(e) {
  const article = document.createElement('article'); article.className = 'episode-card';
  const artwork = document.createElement('div'); artwork.className = 'episode-art';
  artwork.append(iconNode('headphones'));
  const badge = document.createElement('span'); badge.textContent = 'RADIO'; artwork.append(badge);

  const contents = document.createElement('div'); contents.className = 'episode-info';
  const meta = document.createElement('div'); meta.className = 'episode-meta';
  const published = document.createElement('span'); published.textContent = dateLabel(e.date); meta.append(published);
  if (e.heard) { const heard = document.createElement('span'); heard.className = 'heard-tag'; heard.textContent = '視聴済み'; meta.append(heard); }
  const title = document.createElement('h3'); title.textContent = e.title;
  contents.append(meta, title);
  if (e.hosts) {const hosts = document.createElement('p'); hosts.className = 'hosts'; hosts.textContent = e.hosts; contents.append(hosts);}
  if (e.notes) { const notes = document.createElement('p'); notes.className = 'notes'; notes.textContent = e.notes; contents.append(notes); }
  const controls = document.createElement('div'); controls.className = 'episode-controls';
  const play = document.createElement('a'); play.className = 'play-link'; play.href = e.url; play.target = '_blank'; play.rel = 'noopener noreferrer';
  play.append(iconNode('play'), document.createTextNode(' 公式で聴く'), iconNode('external'));
  play.addEventListener('click', () => { const item = state.entries.find(x => x.key === e.key); if (item) {item.lastOpened = Date.now(); persist();} });
  const fav = makeButton('', 'heart', `small-icon ${e.favorite ? 'is-fav' : ''}`, e.favorite ? 'お気に入り解除' : 'お気に入り登録', () => update(e.key, {favorite: !e.favorite}));
  fav.setAttribute('aria-pressed', String(e.favorite)); fav.title = 'お気に入り';
  const heard = makeButton('', 'check', `small-icon ${e.heard ? 'is-heard' : ''}`, e.heard ? '未視聴に戻す' : '視聴済みにする', () => update(e.key, {heard: !e.heard}));
  heard.setAttribute('aria-pressed', String(e.heard)); heard.title = '視聴済みを切替';
  const edit = makeButton('', 'more', 'small-icon', '詳細・編集', () => openEditor(e)); edit.title = '詳細・編集';
  controls.append(play, fav, heard, edit);
  article.append(artwork, contents, controls); return article;
}
function update(key, patch) {
  const idx = state.entries.findIndex(e => e.key === key); if (idx < 0) return;
  state.entries[idx] = {...state.entries[idx], ...patch}; persist(); render();
}
function openEditor(episode = null, prefill = null) {
  const dialog = $('#add-dialog'); const form = $('#episode-form'); form.reset();
  $('#form-error').hidden = true; $('#paste-text').value = '';
  state.editingKey = episode?.key || null;
  $('#dialog-title').textContent = episode ? 'ラジオを編集' : 'ラジオを追加';
  $('#delete-btn').hidden = !episode;
  const input = episode || prefill;
  if (input) {$('#episode-url').value = input.url || ''; $('#episode-title').value = input.title || ''; $('#episode-date').value = input.date || ''; $('#episode-hosts').value = input.hosts || ''; $('#episode-notes').value = input.notes || '';}
  dialog.showModal();
  setTimeout(() => (prefill?.url ? $('#episode-title') : $('#episode-url')).focus(), 0);
}
function showFormError(str) {const err = $('#form-error'); err.textContent = str; err.hidden = false;}
function saveForm(event) {
  event.preventDefault();
  const url = normalizeOfficialUrl($('#episode-url').value);
  if (!url) return showFormError('公式のラジオ個別URL（https://fc.vspo.jp/gallery/radio番号）を入力してください。');
  const split = splitOfficialDisplayTitle($('#episode-title').value, $('#episode-hosts').value);
  if (split.conflict) return showFormError('タイトル末尾の出演者名と出演者欄の入力内容が一致しません。');
  const next = normalizeEpisode({url, title: split.title, date: $('#episode-date').value, hosts: split.hosts, notes: $('#episode-notes').value}, 'local');
  if (!next || !next.title) return showFormError('タイトルを入力してください。');
  const old = state.entries.find(e => e.key === state.editingKey);
  const duplicate = state.entries.find(e => e.key === next.key && e.key !== state.editingKey);
  if (duplicate && !state.hidden.includes(next.key)) return showFormError('同じ回は既に登録されています。既存の回を編集してください。');
  // Changing URL changes the key. Never delete earlier entry silently.
  if (old && old.key !== next.key) return showFormError('登録済みの回のURLは変更できません。別の回として追加してください。');
  const edited = new Set(normalizeUserEdited(old?.userEdited));
  if (old) {
    for (const field of ['title', 'date', 'hosts', 'notes']) {
      if (old[field] !== next[field]) edited.add(field);
    }
  } else {
    if (!isProvisionalTitle(next.title)) edited.add('title');
    for (const field of ['date', 'hosts', 'notes']) {
      if (next[field]) edited.add(field);
    }
  }
  const merged = old ? {...old, ...next, favorite: old.favorite, heard: old.heard, lastOpened: old.lastOpened, source: old.source} : next;
  if (edited.size) merged.userEdited = [...edited];
  else delete merged.userEdited;
  state.entries = [...state.entries.filter(e => e.key !== next.key), merged];
  state.hidden = state.hidden.filter(k => k !== next.key);
  persist(); render(); $('#add-dialog').close(); toast(old ? '変更を保存しました' : 'ラジオを追加しました');
}
function removeEdited() {
  if (!state.editingKey) return;
  if (!confirm('この回を一覧から非表示にしますか？ 再登録すると表示されます。')) return;
  state.hidden = [...new Set([...state.hidden, state.editingKey])];
  persist(); render(); $('#add-dialog').close(); toast('一覧から非表示にしました');
}
async function syncCatalog({quiet = false} = {}) {
  try {
    const url = new URL('./catalog.json', location.href);
    url.searchParams.set('v', String(Date.now()));
    const response = await fetch(url, {cache: 'no-store', credentials: 'omit'});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (!payload || !Array.isArray(payload.items) || payload.items.length > 10000) throw new Error('catalog.json が不正です');
    const merged = mergeEntries(state.entries, payload.items, 'feed');
    state.entries = merged.entries; state.lastSync = new Date().toISOString();
    persist(); render();
    if (!quiet || merged.added > 0 || merged.enriched > 0) {
      const msg = merged.added && merged.enriched
        ? `カタログから${merged.added}件を追加・${merged.enriched}件を更新しました`
        : merged.added
          ? `カタログから${merged.added}件を追加しました`
          : merged.enriched
            ? `カタログから${merged.enriched}件の情報を補完しました`
            : 'カタログは最新です';
      toast(msg);
    }
  } catch (error) {
    if (!quiet) toast('カタログを確認できませんでした。保存済みの一覧は使えます。');
    console.info('Catalog synchronization unavailable:', error.message);
  }
}
function downloadBackup() {
  const payload = {app: 'radio-shelf', version: 1, exportedAt: new Date().toISOString(), entries: state.entries, hidden: state.hidden};
  const blob = new Blob([JSON.stringify(payload, null, 2)], {type: 'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `radio-shelf-backup-${new Date().toISOString().slice(0,10)}.json`;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('バックアップを書き出しました');
}
async function importBackup(file) {
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) return toast('バックアップは2MB以下のJSONファイルを選択してください');
  try {
    const payload = JSON.parse(await file.text());
    const restored = applyBackup(state, payload, INITIAL_CATALOG);
    state.entries = restored.entries;
    state.hidden = restored.hidden;
    persist(); render(); toast(`バックアップを取り込みました（${restored.importedCount}件）`);
  } catch { toast('対応していないJSON形式です'); }
}
function extractNotice() {
  const result = extractFromAnnouncement($('#paste-text').value);
  if (!result) return showFormError('ラジオの公式URLが見つかりませんでした。');
  $('#episode-url').value = result.url;
  if (result.title) $('#episode-title').value = result.title;
  if (result.date) $('#episode-date').value = result.date;
  $('#form-error').hidden = true; toast('URLと確認できた情報を入力しました');
}
function importBulkLinks() {
  const input = $('#bulk-text').value;
  const links = extractOfficialRadioLinks(input);
  if (!links.length) {
    $('#bulk-error').textContent = '公式ラジオ個別URLが見つかりません。サイトのラジオURLを貼り付けてください。';
    $('#bulk-error').hidden = false;
    return;
  }
  const merged = mergeEntries(state.entries, links, 'local');
  state.entries = merged.entries;
  // Restore previously hidden links explicitly pasted by the user.
  const imported = new Set(links.map(x => episodeKey(x.url)));
  state.hidden = state.hidden.filter(key => !imported.has(key));
  persist(); render();
  $('#bulk-dialog').close(); $('#bulk-text').value = '';
  toast(`${merged.added}件を追加しました（重複は除外）`);
}

function handleSharedUrl() {
  const qs = new URLSearchParams(location.search);
  const input = qs.get('add') || qs.get('url');
  if (!input) return;
  const valid = normalizeOfficialUrl(input);
  if (valid) openEditor(null, {url: valid, title: ''});
  else toast('共有されたURLは公式ラジオのURLではありません');
  try { history.replaceState(null, '', location.pathname + location.hash); } catch { /* file:// preview */ }
}
function boot() {
  const saved = readSaved();
  state.entries = mergeEntries(saved.entries, INITIAL_CATALOG).entries;
  state.hidden = saved.hidden; state.lastSync = saved.lastSync;
  persist();
  $('#add-btn').addEventListener('click', () => openEditor());
  $('#bulk-btn').addEventListener('click', () => {$('#bulk-error').hidden = true; $('#bulk-dialog').showModal();});
  $('#bulk-import-btn').addEventListener('click', importBulkLinks);
  $('#empty-add').addEventListener('click', () => openEditor());
  $('#settings-btn').addEventListener('click', () => $('#settings-dialog').showModal());
  $$('.close-dialog').forEach(btn => btn.addEventListener('click', () => btn.closest('dialog').close()));
  $$('dialog').forEach(dialog => dialog.addEventListener('click', ev => { if (ev.target === dialog) dialog.close(); }));
  $('#episode-form').addEventListener('submit', saveForm);
  $('#delete-btn').addEventListener('click', removeEdited);
  $('#extract-btn').addEventListener('click', extractNotice);
  $('#search').addEventListener('input', e => {state.query = e.target.value; render();});
  $('#sort').addEventListener('change', e => {state.sort = e.target.value; render();});
  $$('.tab').forEach(tab => tab.addEventListener('click', () => {
    state.filter = tab.dataset.filter;
    $$('.tab').forEach(t => {t.classList.toggle('active', t === tab); t.setAttribute('aria-selected', String(t === tab));});
    render();
  }));
  $('#sync-btn').addEventListener('click', () => syncCatalog());
  $('#settings-sync').addEventListener('click', () => syncCatalog());
  $('#export-btn').addEventListener('click', downloadBackup);
  $('#import-btn').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', async e => {await importBackup(e.target.files?.[0]); e.target.value = '';});
  render(); handleSharedUrl();
  syncCatalog({quiet: true});
  // Checks the static catalog when the app is open. It does not scrape FC pages.
  state.syncTimer = setInterval(() => {if (document.visibilityState === 'visible') syncCatalog({quiet: true});}, 30 * 60 * 1000);
  document.addEventListener('visibilitychange', () => {if (document.visibilityState === 'visible') syncCatalog({quiet: true});});
  if ('serviceWorker' in navigator && ['http:', 'https:'].includes(location.protocol)) {
    window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
  }
}
boot();