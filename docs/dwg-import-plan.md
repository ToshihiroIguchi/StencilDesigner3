# DWG 読み込み機能 実装計画

StencilDesigner3 に **DWG ファイルの読み込み（インポート）** 機能を追加するための詳細計画。
DWG の書き出しは対象外（読み込み専用）。

---

## 1. 目的とスコープ

### ゴール
- ブラウザ内（バックエンド不要・静的SPAのまま）で DWG ファイルを開けるようにする。
- **大半の実用 DWG が読めること**を最優先要件とする（バージョン網羅・エンティティ網羅・ブロック展開・堅牢なエラー処理）。
- 取り込み結果は既存の DXF 取り込みと同じ `ImportResult`（`Polygon[]` + `Layer[]`）に統一し、以降のパイプライン（正規化・編集・保存・DXF書き出し）を共有する。

### 非ゴール
- DWG 書き出し（不要）。
- DXF→DWG 等の変換機能。
- 注釈系（TEXT/MTEXT/DIMENSION 等）のジオメトリ化（マスク設計に不要。件数のみ集計して無視）。

---

## 2. 採用ライブラリと計測根拠

### ライブラリ
- **`@mlightcad/libredwg-web`**（GNU LibreDWG の WebAssembly 版、GPL-3.0、活発にメンテ）。
- デフォルトビルドは **DWG 読み込み専用**（DXF読み書き・JSON・DWG書き出しは無効化済み＝サイズ削減）。本用途に最適。
- `LibreDwg.create()` → `dwg_read_data(bytes, Dwg_File_Type.DWG)` → `convert()` で
  型付き `DwgDatabase`（`entities` / `tables` / `header` / `objects` / `classes`）が得られる。

### 計測結果（実測サマリ。詳細は付録A）
- 配信サイズ：WASM 本体 6.3MB（**gzip 1.6MB**）＋生グルーJS 109KB。初回のみDL・キャッシュ可。
- WASM 初期化：**56〜99ms**（アプリ起動時に1回。遅延ロードで起動自体は重くしない）。
- パース時間：一般的な図面で **1ファイル 10〜20ms**。内部オブジェクトが多い重い図面（2.18MB級）で約1.26秒。
  - 支配的なのは `convert()`（ネイティブ→JS変換）であり、DWGデコード自体ではない。
  - 時間はファイルサイズより**内部オブジェクト総数（ブロック定義含む）に比例**する。

---

## 3. 法的対応（GPL-3.0 コンプライアンス）★最重要

LibreDWG / `@mlightcad/libredwg-web` は **GPL-3.0**。WASM をブラウザへ配信する＝ユーザーへのバイナリ「頒布(convey)」に当たり、かつ本アプリは API 呼び出しでデータ構造を共有する**結合著作物**となる。したがって**配信されるアプリ全体を GPL-3.0 と整合させる**必要がある（GPL-3 採用は承認済み）。

実施事項（実装フェーズで対応）:

1. **プロジェクトの再ライセンス**
   - 現状 `LICENSE` は MIT。著作権者は本人（Toshihiro Iguchi）なので再ライセンス可能。
   - `LICENSE` を **GPL-3.0 全文**に差し替え（ファイル名は `LICENSE` 維持、または `COPYING` を併設）。
   - `package.json` の `"license"` を `"GPL-3.0-or-later"` に変更。
   - README に「本アプリは LibreDWG を組み込むため GPL-3.0-or-later で配布」と明記。
   - 旧 MIT 期間の扱い：履歴上のMITは残るが、DWG機能を含むリリース以降はGPL-3.0として配布する旨をリリースノート/READMEに記載。

2. **第三者ライセンス表示（NOTICE / THIRD-PARTY）**
   - `THIRD-PARTY-LICENSES.md` を追加し、LibreDWG と `@mlightcad/libredwg-web` の著作権表示・GPL-3.0・取得元URL（GNU LibreDWG, mlightcad リポジトリ）を明記。
   - WASM 同梱物の著作権・ライセンス通知を**除去・改変しない**。

3. **対応するソースの提供（GPL §6）**
   - 配信物に対応するソースを提供：
     - 本アプリ：GitHub リポジトリ（公開）がそのままソース提供を満たす。
     - LibreDWG/WASM：上流の公開リポジトリへの明示リンク（バージョン固定）を `THIRD-PARTY-LICENSES.md` とアプリ内「バージョン情報/About」に記載。
   - 配布ビルド（GitHub Pages 等）には About ダイアログまたはフッタに「ソースコード」「ライセンス」リンクを設置。

4. **CI/リリースへの反映**
   - 既存のリリースワークフロー（dist アーカイブ公開）に `LICENSE`・`THIRD-PARTY-LICENSES.md` を必ず同梱。
   - 配布物に WASM とそのライセンス通知が含まれることを確認するチェックを追加（任意）。

> 注意：本計画ドキュメントを追加する**この PR/ブランチ時点では LibreDWG をまだバンドルしない**ため GPL 義務は発生しない。再ライセンス等は「Phase 1（依存追加）」と同一 PR 内で必ず同時に行うこと。

---

## 4. 「大半のDWGを読める」ための堅牢性戦略 ★重要要件

DWG が読めず空取り込みになる事故を避けるための具体策。

### 4.1 バージョン網羅
- LibreDWG は R13〜R2018+（および一部の旧版 R11/R12/R10 等）を**ライブラリ側で自動判別**して読む。
  - 実測で AC1014(r14)/AC1015(2000)/AC1021(2007)/AC1027(2013)/AC1032(2018) の読み込みを確認済み。
- アプリ側でバージョン分岐は不要。マジックバイト（先頭 `AC10xx`）で簡易判定し、未知でもまず読みに行く。

### 4.2 エンティティ網羅（変換対象を DXF 版より広げる）
既存 DXF 取り込みは `LINE/ARC/CIRCLE/LWPOLYLINE/POLYLINE` のみ。DWG 版では以下まで拡張する:

| エンティティ | 扱い |
|---|---|
| LINE | セグメント（既存流用） |
| LWPOLYLINE / POLYLINE(2D) | 開→セグメント連結 / 閉→リング（bulge対応・既存流用） |
| ARC / CIRCLE | 円弧近似（既存 `arcToPoints` 流用） |
| **ELLIPSE** | 楕円弧をポリライン近似（新規。`getCircleSegments` ベースで分割） |
| **SPLINE** | 制御点/フィット点から折れ線近似（新規。許容誤差で分割） |
| **INSERT（ブロック参照）** | **ブロック定義を再帰展開**（後述 4.3）★最重要 |
| POINT | レジストマーク等に使う場合のみ対応（任意） |
| SOLID / 3DFACE | 輪郭をリング化（任意） |
| HATCH | 境界パスをリング化（任意・優先度低） |
| TEXT/MTEXT/DIMENSION/その他 | 無視（件数のみ `ignoredCounts` に集計） |

### 4.3 ブロック（INSERT）展開 ★最重要
**DWG は実図面でブロックを多用するため、INSERT を展開しないと「読めるのに何も出ない」事故が頻発する。** これが「大半で読める」の鍵。

- `DwgDatabase` のブロック定義（`tables.BLOCK_RECORD` / `objects` 内のブロックエンティティ群）を引き、`INSERT` ごとに:
  - 平行移動（insertion point）、`xscale/yscale/zscale`、回転角を**変換行列**として適用。
  - 行列適用後の座標を `mmToUm` + Y反転で取り込み。
  - **MINSERT（行列複製）**の row/col/spacing にも対応。
  - **ネストしたブロック参照を再帰展開**（循環参照ガード付き、深さ上限を設定）。
- 変換は整数 µm 規約を守るため、行列適用後に `Math.round`。回転・スケールで生じる浮動小数は最終段で丸める。

### 4.4 堅牢なエラー処理
- `dwg_read_data` の戻り `error` は**ビットフラグ**。低位（警告：例 4, 68 等）は**致命ではない**。
  - 方針：**エンティティが1つでも取得できたら成功扱い**。警告はコンソール＆取り込みダイアログに「注意」として表示。
  - 重大エラー（読み込み完全失敗・データ無し）のみ失敗としてユーザーに分かりやすく通知。
- 取り込み 0 件時は「対応エンティティが見つかりません（ブロック未展開/未対応種別）」と理由を提示し、`ignoredCounts` 内訳を表示。
- WASM ロード失敗（CSP/ネットワーク）時のフォールバックメッセージ。
- 1ファイル中の一部エンティティ変換失敗は **try/catch でスキップ**し、全体を止めない（部分取り込み）。

### 4.5 単位の扱い
- 既存 DXF 取り込みは mm 前提（`mmToUm`）。DWG も model 単位をそのまま mm とみなす（既存挙動と一貫）。
- 将来対応：`header.$INSUNITS` を見てスケール補正（インチ等）。初版では既存同様 mm 固定＋必要なら取り込み後にスケール調整で対応。

---

## 5. アーキテクチャ / ファイル別変更

```
src/dxf/importer.ts        後段パイプラインを共通関数へ抽出（リファクタ）
src/dwg/importer.ts        新規: importDwg(buf) … DwgDatabase → ImportResult
src/dwg/blocks.ts          新規: ブロック展開・変換行列ユーティリティ
src/dwg/worker.ts          新規: Web Worker でパース実行（重い図面のUIフリーズ回避）
src/dwg/libredwg.ts        新規: WASM 遅延ロード + locateFile 解決のラッパ
src/ui/app.ts              ドロップ/メニュー/ファイル入力に .dwg を追加、進捗表示
vite.config.*              .wasm を遅延チャンク/アセットとして配置
LICENSE / package.json     GPL-3.0 へ（Phase 1 で同時に）
THIRD-PARTY-LICENSES.md    新規（第三者ライセンス表示）
```

### 設計方針
- `importDxf` の**後段**（segments/closedRings → レイヤ別連結 → 外/穴分類 → レイヤ表構築 → `normalizeAll`）を
  `buildImportResult(segments, closedRings, rawLayers): ImportResult` として抽出し、DXF/DWG 両方で共有。
- `importDwg` は `DwgDatabase` を走査して **segments/closedRings を生成するだけ**。座標変換・bulge・円弧近似は既存ヘルパ（`arcToPoints`/`bulgeToArcPoints`/`expandPolylineVerts`/`mmToUm`/Y反転）を流用。
- レイヤは `tables.LAYER` から構築（既存 `aciToHex`/`normalizeLinetype` 流用）。
- `dwg_free()` で WASM メモリを必ず解放（finally 節）。

---

## 6. フェーズ別タスク

> **進捗注記:** Phase 1–6 はすべて実装・検証・main マージ済み（PR #3〜#7）。詳細経緯は `dwg-import-impl-spec.md` と memory を参照。

### Phase 1｜依存追加・遅延ロード基盤・GPL整合（同一PR）
- [x] `npm install @mlightcad/libredwg-web`
- [x] `LICENSE` を GPL-3.0 全文へ、`package.json` の license 更新、`THIRD-PARTY-LICENSES.md` 追加、README 追記
- [x] `src/dwg/libredwg.ts`：`LibreDwg.create()` の遅延 `import()` と `.wasm` の `locateFile` 解決
- [x] Vite で `.wasm` が初期バンドルに入らず遅延チャンク化されることを確認

### Phase 2｜変換コア（DwgDatabase → ImportResult）
- [x] `src/dxf/importer.ts`：後段を `buildImportResult(...)` に抽出（DXF 側の挙動は不変・既存テストで担保）
- [x] `src/dwg/importer.ts`：`importDwg(buf: ArrayBuffer): Promise<ImportResult>`
  - [x] LINE/ARC/CIRCLE/LWPOLYLINE/POLYLINE をマッピング（フィールド名差分を吸収）
  - [x] エラーコードを警告/致命に分類、部分取り込み（try/catch）
  - [x] `ignoredCounts` 集計

### Phase 3｜網羅性拡張（「大半で読める」要件）
- [x] `src/dwg/blocks.ts`：INSERT/MINSERT 展開（平行移動・スケール・回転、再帰＋循環ガード）
- [x] ELLIPSE 近似、SPLINE 折れ線近似（SPLINE は de Boor / centripetal Catmull-Rom + 適応的弦高分割で精密化。PR #5）
- [ ] （任意）SOLID/3DFACE/POINT/HATCH 対応 — 未対応（`ignoredCounts` 計上のみ。優先度低）
- [x] 取り込み 0 件時の理由提示 UI

### Phase 4｜Web Worker 化
- [x] `src/dwg/worker.ts`：パース（read+convert+変換）を Worker で実行し `ImportResult` を postMessage
- [x] UI にスピナー/進捗表示、キャンセル（任意）

### Phase 5｜UI 配線（`src/ui/app.ts`）
- [x] ドロップ判定に `dwg` 追加 → `loadDwgFile(file)`（`file.arrayBuffer()`）
- [x] ファイル入力 `accept` とメニューに `.dwg` 追加、`importDwg()` メソッド
- [x] 取り込み後は既存 `showImportDialog(result)` を流用（変更不要）
- [x] About/フッタに「ソースコード」「ライセンス」リンク（GPL §6）

### Phase 6｜テスト・検証
- [x] 単体（Vitest）：各バージョン DWG（r14/2000/2007/2013/2018）で entity 数・bbox・レイヤ・ブロック展開を検証
- [x] ブロック多用 DWG で「空にならない」回帰テスト
- [x] エラーコード警告ファイルが成功扱いになることを検証
- [x] E2E（Playwright）：`.dwg` ドロップ → ダイアログ → 描画
- [x] 本番ビルドで WASM が遅延チャンク分離・初期ロードに非混入を確認
- [x] 配布物に LICENSE / THIRD-PARTY が同梱されることを確認（`release.yml` zip に明示追加）

---

## 7. リスクと対応

| リスク | 影響 | 対応 |
|---|---|---|
| ブロック未展開で空取り込み | 「読めない」事故 | Phase 3 で INSERT 再帰展開を必須実装 |
| 重い図面でUIフリーズ | 体感品質 | Web Worker 化（Phase 4） |
| 初期バンドル肥大 | 起動遅延 | WASM 遅延ロード（DWGを開く時のみ） |
| エラーコード誤判定で失敗扱い | 読めるのに弾く | 低位コードは警告扱い・部分取り込み |
| 単位差（インチ等） | 寸法ズレ | 初版mm固定、将来 `$INSUNITS` 対応 |
| WASM の locateFile / CSP | ロード失敗 | アセット配置とCSP設定、フォールバック表示 |

---

## 8. 完了条件（Definition of Done）
- 代表的な複数バージョンの実 DWG（ブロック多用含む）が、空にならず正しく取り込める。
- 取り込み結果が既存編集・保存・DXF書き出しと矛盾なく連携する。
- GPL-3.0 コンプライアンス（ライセンス・第三者表示・ソース提供リンク）が配布物に反映済み。
- 重い図面でも UI がフリーズしない（Worker 化）。
- 既存 DXF 取り込みの挙動・テストが不変。

---

## 付録A：計測の生データ（参考）

ライブラリ `@mlightcad/libredwg-web@0.7.2`、Node 24（V8）。best of 3。

| ファイル | サイズ | read | convert | 合計 | model空間entity |
|---|---|---|---|---|---|
| example_2018.dwg | 149 KB | 4.9ms | 9.7ms | 15ms | 63 |
| example_2013.dwg | 147 KB | 6.5ms | 8.1ms | 15ms | 63 |
| TS1.dwg | 418 KB | 4.7ms | 5.3ms | 10ms | 28 |
| example_2000.dwg | 583 KB | 5.4ms | 9.9ms | 15ms | 61 |
| example_r14.dwg | 440 KB | 5.8ms | 11.8ms | 18ms | 61 |
| Dynblocks.dwg | 2.18 MB | 119ms | 1141ms | 1261ms | 121（※ブロック定義多数） |

- WASM 初期化：56〜99ms（1回のみ）
- 配信：WASM 6.3MB / gzip 1.6MB、生グルーJS 109KB
- パース中の `error code 4/68` は非致命警告（データは正常取得）
