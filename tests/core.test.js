import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeOfficialUrl, episodeKey, normalizeEpisode, mergeEntries, extractFromAnnouncement, extractOfficialRadioLinks, filterSort} from '../core.js';
test('公式のラジオ個別URLだけ受け入れる', () => {
  assert.equal(normalizeOfficialUrl('https://fc.vspo.jp/gallery/radio99?foo=bar#play'), 'https://fc.vspo.jp/gallery/radio99');
  assert.equal(normalizeOfficialUrl('https://fc.vspo.jp/ja/gallery/radio40/'), 'https://fc.vspo.jp/ja/gallery/radio40');
  assert.equal(episodeKey('https://fc.vspo.jp/ja/gallery/radio40'), 'radio40');
  for (const bad of ['https://evil.tld/gallery/radio99', 'https://fc.vspo.jp.evil.tld/gallery/radio99', 'javascript:alert(1)', 'http://fc.vspo.jp/gallery/radio99', 'https://fc.vspo.jp/gallery/category/radio', 'https://fc.vspo.jp/post/news156', 'https://user:pass@fc.vspo.jp/gallery/radio99']) assert.equal(normalizeOfficialUrl(bad), null);
});
test('登録データを正規化する', () => {
  const x = normalizeEpisode({url:'https://fc.vspo.jp/gallery/radio99', title:' hello ', favorite:true, heard:true, date:'2026-02-30', notes:' test '});
  assert.equal(x.title, 'hello'); assert.equal(x.favorite, true); assert.equal(x.heard, true); assert.equal(x.date, ''); assert.equal(x.notes, 'test');
});
test('カタログ更新時に重複せず、ユーザー設定は残る', () => {
  const old = normalizeEpisode({url:'https://fc.vspo.jp/gallery/radio99', title:'お気に入りタイトル', favorite:true, heard:true, notes:'自分のメモ'});
  const result = mergeEntries([old], [{url:'https://fc.vspo.jp/ja/gallery/radio99',title:'第56回ラジオ',date:'2026-07-02'}, {url:'https://fc.vspo.jp/gallery/radio79',title:'第36回ラジオ'}]);
  assert.equal(result.added,1); assert.equal(result.entries.length,2);
  assert.equal(result.entries[0].favorite,true); assert.equal(result.entries[0].heard,true);
  assert.equal(result.entries[0].notes,'自分のメモ'); assert.equal(result.entries[0].title,'お気に入りタイトル'); assert.equal(result.entries[0].date,'2026-07-02');
});
test('お知らせテキストからURLと日付を抽出', () => {
  const x = extractFromAnnouncement('2026/07/02\n第56回ラジオを更新しました。\nhttps://fc.vspo.jp/gallery/radio99');
  assert.deepEqual(x, {url:'https://fc.vspo.jp/gallery/radio99', title:'第56回ラジオ', date:'2026-07-02'});
  assert.equal(extractFromAnnouncement('https://example.com/gallery/radio99'), null);
});
test('表示フィルターと並び替え', () => {
  const items = [normalizeEpisode({url:'https://fc.vspo.jp/gallery/radio79',title:'第36回ラジオ',date:'2026-02-12',heard:true}), normalizeEpisode({url:'https://fc.vspo.jp/gallery/radio99', title:'第56回ラジオ',date:'2026-07-02',favorite:true})];
  assert.deepEqual(filterSort(items).map(x=>x.key), ['radio99','radio79']);
  assert.deepEqual(filterSort(items, {filter:'favorites'}).map(x=>x.key), ['radio99']);
  assert.deepEqual(filterSort(items, {filter:'unheard'}).map(x=>x.key), ['radio99']);
  assert.deepEqual(filterSort(items, {search:'３６'}).map(x=>x.key), ['radio79']);
});

test('過去回のURLを一括抽出して重複を排除', () => {
  const text = ['公式からコピーしたリンク', 'https://fc.vspo.jp/gallery/radio99', 'https://fc.vspo.jp/ja/gallery/radio99?ref=mine', 'https://fc.vspo.jp/ja/gallery/radio22', 'https://evil.test/gallery/radio21'].join('\n');
  assert.deepEqual(extractOfficialRadioLinks(text).map(x => x.url), ['https://fc.vspo.jp/gallery/radio99', 'https://fc.vspo.jp/ja/gallery/radio22']);
  assert.deepEqual(extractOfficialRadioLinks('不正なリンク https://evil.test/gallery/radio123'), []);
  assert.equal(extractOfficialRadioLinks('https://fc.vspo.jp/gallery/radio1 https://fc.vspo.jp/gallery/radio2', 1).length, 1);
});