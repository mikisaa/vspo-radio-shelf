import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeArchive} from '../scripts/import-archive.mjs';
const initial={version:'base', items:[{url:'https://fc.vspo.jp/gallery/radio99',title:'第56回ラジオ',date:'2026-07-02',hosts:'',notes:'confirmed'}]};
test('adds verified URLs and skips duplicate /ja variants',()=>{
  const v=mergeArchive(initial,{items:[
    {url:'https://fc.vspo.jp/ja/gallery/radio120',title:'ラジオ（radio120）',date:'2026-10-01'},
    {url:'https://fc.vspo.jp/gallery/radio120', title:'different'},
    {url:'https://fc.vspo.jp/gallery/radio99',title:'different'}]});
  assert.equal(v.summary.added,1);assert.equal(v.summary.total,2);
  assert.equal(v.catalog.items.find(x=>x.url.endsWith('radio99')).title,'第56回ラジオ');
  assert.equal(v.summary.conflicts.length,1);
});
test('rejects non-official pages and member-only notes',()=>{
  assert.throws(()=>mergeArchive(initial,[{url:'https://evil.example.com/gallery/radio1'}]),/ラジオ個別URL/);
  assert.throws(()=>mergeArchive(initial,[{url:'https://fc.vspo.jp/gallery/radio121',notes:'transcript'}]),/notes/);
});
test('dry run leaves original unchanged',()=>{
  const before=JSON.stringify(initial);mergeArchive(initial,[{url:'https://fc.vspo.jp/gallery/radio90'}]);assert.equal(JSON.stringify(initial),before);
});

test('blank title does not overwrite confirmed title',()=>{
 const v=mergeArchive(initial,[{url:'https://fc.vspo.jp/gallery/radio99'}]);
 assert.equal(v.summary.conflicts.length,0);
 assert.equal(v.catalog.items[0].title,'第56回ラジオ');
});