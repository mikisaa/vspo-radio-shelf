# 過去ラジオの登録（ぶいすぽっ！ラジオ）

## 状況

初期カタログには、一般公開された公式ニュースでURLが確認できた4件だけが入っています。`gallery/radioN` の数字は番組の第N回と一致しません。URLを推測して生成しないでください。

アプリの「過去回をまとめて追加」にラジオの個別URLを複数貼ると、その端末だけに登録できます。**共通カタログ**に登録する場合は、下記の JSON 手順を使います。

## Antigravity向け依頼文（コピペ）

```text
目的：私が会員登録済みの「ぶいすぽっ！ファンクラブ」ラジオの各回を、私の個人用リンク集（GitHub: mikisaa/vspo-radio-shelf）に登録するため、公式ページの個別URLと表示上の公開情報だけを整理する。

作業範囲：
1. 私が自分でログイン済みのブラウザを利用できるなら、公式サイト https://fc.vspo.jp/gallery/category/radio の通常の画面を開く。ログインを要求されたら私が手動で行う。資格情報を受け取らない。
2. 普通に表示されるラジオ一覧を私と同じ範囲で確認し、各エピソードのURL・表示されるタイトル・表示される公開日を記録する。公式サイトの画面を手動操作する範囲にとどめる。
3. 非公開情報（アカウント情報、Cookie、トークン、会員番号、限定音声、動画、本文、台本、サムネイル）は取得・転記・アップロードしない。ネットワークタブ、内部API、ページソース解析、認証回避、大量巡回は実行しない。
4. 実際に画面で確認できた個別URLだけを記録し、連番からURLやタイトルを推測しない。各回の番号が表示されない場合はタイトルを省略してよい。公開日が不明なら空欄にする。
5. `archive-candidates.json` として、以下の形式で保存する。`notes` や会員限定コンテンツは含めない。
   {"items":[{"url":"https://fc.vspo.jp/gallery/radio99","title":"第56回ラジオ","date":"2026-07-02","hosts":""}]}
6. `node scripts/import-archive.mjs archive-candidates.json` でdry-run検証し、件数・重複・競合・未確認を報告する。危険な不一致は勝手に上書きしない。
7. 問題がなければ `node scripts/import-archive.mjs archive-candidates.json --write` により `catalog.json` に追加し、既存4件は保持する。
8. `npm test` でテストし、差分をレビューしてから `mikisaa/vspo-radio-shelf` の main にコミット・pushする。他のリポジトリを変更しない。
9. 最後に「確認した件数／新規登録／重複／要確認／未確認の期間／実施テスト／コミットSHA」を報告する。

途中でアクセス制限・利用規約上の懸念・操作の停止が必要な場合は、無理に収集せず現時点で確認できた情報だけ報告する。
```

## 取り込み例

`archive-candidates.json`（公開カタログへ登録してよい**URLとメタデータのみ**）:

```json
{
  "items": [
    {"url":"https://fc.vspo.jp/gallery/radio99","title":"第56回ラジオ","date":"2026-07-02","hosts":""}
  ]
}
```

テストと反映:

```bash
node scripts/import-archive.mjs archive-candidates.json
node scripts/import-archive.mjs archive-candidates.json --write
npm test
```

GitHub Pagesの `catalog.json` が公開更新されると、アプリが起動時などにデータを取り込みます。お気に入りや視聴済みは各端末のブラウザ内に保持されます。

## 制約

- 公式のFAQは、加入月より前のコンテンツは視聴・ダウンロードできないと説明しています。登録できても再生できるとは限りません。
- 公式利用規約はシステム解析、無断転載を制限しています。権利・規約を尊重してください。
- このアプリは非公式です。公開GitHub上に会員限定の音声・画像・認証情報を置かないでください。