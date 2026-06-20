# DWG 読み込み 実装仕様書（実装担当=Sonnet 向けハンドオフ）

本書は `docs/dwg-import-plan.md`（全体計画）を**コードレベルまで具体化**した実装手順書。
実装者はこの仕様に沿って進めること。型・API・座標変換・ブロック展開・テスト手順を確定値で記載する。

> 前提ルール（CLAUDE.md 準拠・厳守）
> - 幾何座標は **整数 µm**。float源（DWG座標）は必ず `Math.round`。
> - 幾何編集後は `normalize()`/`normalizeAll()` を呼ぶ。
> - DWG はI/O専用。内部ジオメトリは必ず `Polygon` に変換。
> - ドキュメント・コメント・UI 文言は日本語、コード識別子は英語。
> - PR タイトル/本文・コミット subject は英語（conventional commit）。
> - 本機能の依存は GPL-3.0。後述の GPL 対応を**依存追加と同一PR**で必ず実施。

---

## 0. ライブラリ確定情報

- パッケージ: `@mlightcad/libredwg-web@^0.7.2`（GPL-3.0）
- 使い方（ラッパAPI）:
  ```ts
  import { LibreDwg, Dwg_File_Type } from '@mlightcad/libredwg-web';
  const libredwg = await LibreDwg.create(wasmDir); // wasmDir = libredwg-web.wasm のあるディレクトリ
  const dwg = libredwg.dwg_read_data(new Uint8Array(buf), Dwg_File_Type.DWG);
  const db  = libredwg.convert(dwg);   // => DwgDatabase
  // ... 変換 ...
  libredwg.dwg_free(dwg);              // finally で必ず解放
  ```
- `.wasm` 実体: `node_modules/@mlightcad/libredwg-web/wasm/libredwg-web.wasm`（6.3MB）。
  - `LibreDwg.create(filepath)` は `locateFile` に `${filepath}/libredwg-web.wasm` を渡す実装。
  - ブラウザでは Vite のアセットURL（`?url`）で解決し、その親ディレクトリ相当を渡す（後述 §5）。
- 注意: `dwg_read_data` の戻りに `error`（ビットフラグ）がある。**低位（警告）でもデータは取れる**。エンティティが取得できていれば成功扱いにする。

---

## 1. 確定済み型スキーマ（実測の .d.ts より。これに従えば推測不要）

`libredwg.convert(dwg)` が返す `DwgDatabase`:

```ts
interface DwgDatabase {
  tables: {
    BLOCK_RECORD: { entries: DwgBlockRecordTableEntry[] };
    LAYER:        { entries: DwgLayerTableEntry[] };
    LTYPE: ...; STYLE: ...; /* 他は未使用 */
  };
  objects: { ... };          // 本機能では未使用
  header:  DwgHeader;        // 将来 $INSUNITS 参照用
  entities: DwgEntity[];     // モデル空間エンティティ（便宜フラット配列）
  classes:  DwgClass[];
}
```

ベース & 主要エンティティ（必要フィールドのみ抜粋）:

```ts
interface DwgEntity {
  type: string;            // 'LINE' | 'LWPOLYLINE' | 'POLYLINE2D' | 'ARC' | ...
  handle: string;
  layer: string;
  colorIndex?: number;     // 負値=レイヤoff, 256=BYLAYER
  lineType?: string;
  lineweight?: number;
  isInPaperSpace?: boolean;// true はペーパー空間 → スキップ
  isVisible?: boolean;
  ownerBlockRecordSoftId: string;
}

interface DwgPoint2D { x: number; y: number; }
interface DwgPoint3D { x: number; y: number; z: number; }

interface DwgLineEntity extends DwgEntity {           // 'LINE'
  startPoint: DwgPoint3D; endPoint: DwgPoint3D;
}

interface DwgLWPolylineEntity extends DwgEntity {     // 'LWPOLYLINE'
  flag: number;                                       // bit0(=1): 閉
  vertices: DwgLWPolylineVertex[];
  elevation: number;
}
interface DwgLWPolylineVertex extends DwgPoint2D { id: number; bulge: number; startWidth?: number; endWidth?: number; }

interface DwgPolyline2dEntity extends DwgEntity {     // 'POLYLINE2D'
  flag: number;                                       // bit0(=1): 閉
  vertices: DwgVertex2dEntity[];                      // DwgVertex2dEntity extends DwgPoint3D, { bulge, id, ... }
  elevation: number;
}
interface DwgPolyline3dEntity extends DwgEntity {     // 'POLYLINE3D'
  flag: number; vertices: DwgVertex3dEntity[];        // DwgVertex3dEntity extends DwgPoint3D
}

interface DwgArcEntity extends DwgEntity {            // 'ARC'
  center: DwgPoint3D; radius: number; startAngle: number; endAngle: number;
}
interface DwgCircleEntity extends DwgEntity {         // 'CIRCLE'
  center: DwgPoint3D; radius: number;
}
interface DwgEllipseEntity extends DwgEntity {        // 'ELLIPSE'
  center: DwgPoint3D; majorAxisEndPoint: DwgPoint3D;  // 中心からの相対ベクトル
  axisRatio: number; startAngle: number; endAngle: number;
}
interface DwgSplineEntity extends DwgEntity {         // 'SPLINE'
  degree: number; controlPoints: DwgPoint3D[]; fitPoints: DwgPoint3D[];
  knots: number[]; weights?: number[];
}
interface DwgInsertEntity extends DwgEntity {         // 'INSERT'
  name: string;                                       // 参照ブロック名
  insertionPoint: DwgPoint3D;
  xScale: number; yScale: number; zScale: number;
  rotation: number;                                   // radian（§8で実測確定）
  columnCount: number; rowCount: number;
  columnSpacing: number; rowSpacing: number;
  attribs: DwgAttribEntity[];
}

interface DwgBlockRecordTableEntry {                  // ブロック定義
  name: string;                                       // 例 '*Model_Space', 'MYBLOCK'
  basePoint: DwgPoint3D;                              // ブロック原点
  entities: DwgEntity[];                              // ブロック内エンティティ
}

interface DwgLayerTableEntry {
  name: string; colorIndex: number; color: number;
  lineType: string; frozen: boolean; off: boolean;
  locked: boolean; plotFlag: number; lineweight: number;
}
```

> ブロック展開の要点: `INSERT.name` を `tables.BLOCK_RECORD.entries` から `name` で検索し、その `entities` を再帰展開する。
> モデル空間自体もブロック（`*Model_Space`/`*Paper_Space`）。`db.entities` を使えばモデル空間ぶんは取得済みなので、トップレベルは `db.entities` を起点にしてよい。

---

## 2. 既存コードの再利用と抽出（リファクタ）

`src/dxf/importer.ts` の `importDxf()` 後段を共通関数に抽出する。挙動は不変（既存テストで担保）。

```ts
// src/dxf/importer.ts に追加（export）
export function buildImportResult(
  segments: Array<{ seg: [Vertex, Vertex]; layer: string }>,
  closedRings: Array<{ ring: Ring; layer: string }>,
  rawLayers: Array<Partial<Layer> & { name: string; colorIndex?: number; frozen?: boolean; lineType?: string; lineweight?: number; locked?: boolean; plot?: boolean }>,
): ImportResult
```

中身は現行 `importDxf` の以下をそのまま移植:
- open セグメントのレイヤ別 `chainSegments` 連結
- `closedRings` と結合 → `classifyAndBuildPolygons`
- レイヤ表構築（`aciToHex` / `normalizeLinetype` / `REGMARK`→`isAperture`）
- entityで使用されたが表に無いレイヤの補完
- 戻り: `{ polygons: normalizeAll(polygons), layers, ignoredCounts }`

そして `importDxf()` 自身を、抽出した `buildImportResult()` を呼ぶ形に書き換える（DXF専用ロジック＝entityの読み取りだけ残す）。

既存ヘルパ（**DWG変換でも再利用**、必要なら export）:
- `mmToUm(v)` … `Math.round(v*1000)`
- `arcToPoints(cx,cy,r,startDeg,endDeg,ccw)` … 度入力・Y反転込み
- `bulgeToArcPoints(p1x,p1y,p2x,p2y,bulge)`
- `expandPolylineVerts(verts, isClosed)`
- 座標規約: DWG/DXF は Y-up、内部は Y-down。**取り込み時に y を反転**（既存は `vertex(mmToUm(x), mmToUm(-y))`）。

---

## 3. 新規ファイル

### 3.1 `src/dwg/libredwg.ts` — WASM 遅延ロード
```ts
import wasmUrl from '@mlightcad/libredwg-web/wasm/libredwg-web.wasm?url';
import type { LibreDwg as LibreDwgType } from '@mlightcad/libredwg-web';

let instance: LibreDwgType | null = null;

export async function getLibreDwg(): Promise<LibreDwgType> {
  if (instance) return instance;
  const { LibreDwg } = await import('@mlightcad/libredwg-web'); // 遅延 import
  // wasmUrl から locateFile 用ディレクトリを解決
  const dir = wasmUrl.slice(0, wasmUrl.lastIndexOf('/'));
  instance = await LibreDwg.create(dir);
  return instance;
}
```
> `create(dir)` は `${dir}/libredwg-web.wasm` を fetch する。Vite が `?url` でハッシュ付きURLを与えるためファイル名が変わる場合は、`locateFile` を上書きして `wasmUrl` を直接返す実装に変更する（§5参照）。動作確認しながら確実な方を採用。

### 3.2 `src/dwg/blocks.ts` — 変換行列・ブロック展開
- 2x3 アフィン行列（µm 整数化は最終段）。
- `INSERT` → 平行移動(insertionPoint) × 回転(rotation) × スケール(x/y) を合成。`basePoint` を減算してから適用。
- `MINSERT`（columnCount/rowCount>1）は row×col で平行移動複製。
- 再帰展開（`visited: Set<blockName>` で循環ガード、`depth` 上限 16）。

```ts
export interface Mat { a:number;b:number;c:number;d:number;e:number;f:number; } // [[a c e],[b d f]]
export function identity(): Mat
export function multiply(m1: Mat, m2: Mat): Mat
export function apply(m: Mat, x: number, y: number): { x: number; y: number } // float（呼び出し側で round）
export function insertMatrix(ins: DwgInsertEntity, basePoint: DwgPoint3D): Mat
```

### 3.3 `src/dwg/importer.ts` — 変換コア
```ts
import type { ImportResult } from '../dxf/importer';
export async function importDwg(buf: ArrayBuffer): Promise<ImportResult>;
```
処理:
1. `getLibreDwg()` → `dwg_read_data` → `convert`（try/finally で `dwg_free`）。
2. `db.entities`（モデル空間）を起点に走査。`isInPaperSpace` は除外。
3. 各 entity を §4 のマッピングで `segments` / `closedRings` に積む（座標は §2 のヘルパで µm + Y反転）。`INSERT` は §3.2 で展開し、行列適用後に同じマッピングを再帰適用。
4. レイヤ表は `db.tables.LAYER.entries` を `buildImportResult` の rawLayers 形へ変換。
5. `buildImportResult(segments, closedRings, rawLayers)` を返す。
6. 個々 entity の変換は try/catch で囲み、失敗はスキップ＋`ignoredCounts['_error']++`（全体を止めない）。

---

## 4. エンティティ → 中間表現マッピング

| type | 変換 |
|---|---|
| `LINE` | `startPoint,endPoint` を2頂点セグメント |
| `LWPOLYLINE` | `flag&1` で閉判定。bulge は `bulgeToArcPoints`。閉→`closedRings`、開→セグメント列 |
| `POLYLINE2D` | 同上（vertices は `DwgVertex2dEntity`、`x,y,bulge`） |
| `POLYLINE3D` | z無視、x/yのみ。`flag&1` で閉 |
| `ARC` | `arcToPoints(center.x,center.y,radius,startAngle,endAngle)`（startAngle/endAngle は radian → `*180/π` で度変換。§8で実測確定）→セグメント列 |
| `CIRCLE` | `arcToPoints(...,0,360)` の最終点を除いて `closedRings` |
| `ELLIPSE` | `majorAxisEndPoint`(相対)から長軸長・角度算出、`axisRatio`で短軸。startAngle/endAngle（§8）でパラメトリック分割し折れ線化。閉(全周)なら`closedRings` |
| `SPLINE` | まず `fitPoints` があればそれを折れ線として使用。無ければ `controlPoints` を de Boor で degree 次評価し許容誤差で分割（簡易実装可: 制御点折れ線でも可だが精度注意）。閉フラグで `closedRings` |
| `INSERT` | §3.2 でブロック展開（行列適用→子entityを再帰マッピング）。`attribs` は無視 |
| `POINT` | 既定は無視（必要なら REGMARK 用に対応） |
| `SOLID`/`3DFACE` | 任意: 角点をリング化 |
| `HATCH` | 任意・優先度低: 境界パスをリング化 |
| その他 (`TEXT`/`MTEXT`/`DIMENSION`/`MLINE`/`VIEWPORT`/...) | 無視。`ignoredCounts[type]++` |

> セグメント連結は既存 `chainSegments`（レイヤ別）により自動でリング化される。開いたままのものは線分として扱われる（既存DXFと同じ挙動）。

---

## 5. Vite / WASM 配置（§3.1の確実化）

- 最優先: `?url` インポート＋`locateFile` 上書きで**ハッシュ付きURLを直接返す**:
  ```ts
  instance = await LibreDwg.create(); // 引数なし → 既定 locateFile
  // ↑が data: URL 埋め込み版で失敗する場合は createModule 経由で locateFile を上書き:
  // const { createModule } = await import('@mlightcad/libredwg-web/wasm/libredwg-web.js');
  // const mod = await createModule({ locateFile: () => wasmUrl });
  // instance = LibreDwg.createByWasmInstance(mod);
  ```
- 受け入れ確認: 本番ビルドで `libredwg-web.wasm` が**別チャンク/アセット**として出力され、初期ロードに含まれないこと（`dist` を確認）。
- CSP: `wasm-unsafe-eval` 等が必要なら設定。fetch失敗時はユーザーへフォールバック表示。

---

## 6. Web Worker 化

- `src/dwg/worker.ts`：`{ buf: ArrayBuffer }` を受け取り、`importDwg` 相当を実行、`ImportResult`（プレーンデータ）を `postMessage`。エラーは `{ error: string }`。
- メインは `loadDwgFile` で Worker を spawn、スピナー表示、完了で `showImportDialog(result)`。
- 注意: `ImportResult` は構造化複製可能なプレーンオブジェクトであること（関数・クラスインスタンスを含めない）。
- WASM ロードも Worker 内で行う（メインスレッドを汚さない）。`?url` は Worker からも解決可能なように Vite 設定で対応。

---

## 7. UI 配線（`src/ui/app.ts`）

- ドロップ判定（現状 `app.ts:437` 付近 `if (ext === 'dxf')`）に `dwg` を追加 → `this.loadDwgFile(file)`。
- ファイル入力 `accept` に `.dwg` 追加。メニュー/ハンドラに `importDwg()`（`#dwg-file-input` クリック or 既存入力を拡張）。
- `loadDwgFile(file)`: `const buf = await file.arrayBuffer();` → Worker 経由で `importDwg` → `showImportDialog(result)`（**既存メソッドをそのまま流用、改変不要**）。
- 失敗時: `showMessageModal({ title:'DWG取り込み', message: ... })`。0件時は理由＋`ignoredCounts` 内訳を提示。
- About/フッタに「ソースコード」「ライセンス」リンク（GPL §6、§9）。

---

## 8. 実装前に必ず確認する不確実点（VERIFY） — **全て実測で確定済み**

実フィクスチャ（`example_2018.dwg` 等）で全項目を実測し、以下のとおり確定した。

1. **角度の単位 = radian（確定）**: `ARC.startAngle/endAngle`・`ELLIPSE.startAngle/endAngle`・`INSERT.rotation` はすべて radian。既存 `arcToPoints` は度入力のため、ARC は `*180/π`（`RAD2DEG`）で度変換してから渡す（`src/dwg/importer.ts` の `RAD2DEG` / `arcPointsMm`）。INSERT.rotation は radian のまま回転行列へ（`src/dwg/blocks.ts`）。ELLIPSE はパラメトリック角を radian のまま使用。
2. **閉フラグ = 確定**: `LWPOLYLINE.flag & 1`・`POLYLINE2D.flag & 1` で閉。実装に反映済み。
3. **ブロック basePoint = 確定**: 展開時に `basePoint` を減算（`insertMatrix`）。実データで整合を確認。
4. **`db.entities` の網羅 = 確定**: モデル空間は `db.entities` を起点に取得。ペーパー空間は除外。
5. **`?url` + locateFile = 確定**: 上流 dist の wasm は `data:application/wasm;base64,` インライン化で emscripten の isDataURI が `application/octet-stream` しか認識せず失敗する罠あり。対策＝wasm を `src/dwg/libredwg-web.wasm` に vendor し `?url` 取り込み、`createModule({ locateFile: () => wasmUrl })` + `createByWasmInstance` で実アセットをロード（`vite.config.ts` の alias / `optimizeDeps.include` 併用）。本番ビルドで実アセット 1 個のみ出力を確認。

---

## 9. GPL-3.0 コンプライアンス（依存追加と同一PRで必須）

- [x] `LICENSE` を **GPL-3.0 全文**へ差し替え（著作権者本人のため再ライセンス可）。
- [x] `package.json` の `"license"` を `"GPL-3.0-or-later"` に。
- [x] `THIRD-PARTY-LICENSES.md` 追加: LibreDWG / `@mlightcad/libredwg-web` の著作権・GPL-3.0・取得元URL（バージョン固定）を明記。WASM 同梱の通知は除去しない。
- [x] README に「DWG機能のため GPL-3.0-or-later で配布」「対応ソース＝本リポジトリ＋上流リンク」を追記。
- [x] About/フッタにソース・ライセンスへのリンク（GPL §6）。
- [x] リリースワークフロー（dist公開）に `LICENSE`/`THIRD-PARTY-LICENSES.md`/`wasm` を同梱。`wasm` は `dist` に内包され zip 化される。`LICENSE`/`THIRD-PARTY-LICENSES.md` は `release.yml` の zip 対象へ明示追加済み。

---

## 10. テスト

### サンプルDWG（テストフィクスチャ。取得元）
`https://raw.githubusercontent.com/mlightcad/libredwg-web/master/test/test-data/` 配下:
- `example_r14.dwg`(AC1014) / `example_2000.dwg`(AC1015) / `example_2007.dwg`(AC1021) / `example_2013.dwg`(AC1027) / `example_2018.dwg`(AC1032)
- `2018/Dynblocks.dwg`（ブロック多用・2.18MB） / `2000/TS1.dwg`
→ `test/fixtures/dwg/` に保存（リポジトリへコミット可。サイズ留意）。

### Vitest（`src/dwg/*.test.ts`）
- [x] 各バージョンが読め、entity が **0件にならない**（空取り込み回帰防止）。
- [x] `LINE/LWPOLYLINE/ARC/CIRCLE` の bbox が妥当（µm整数・Y反転確認）。
- [x] **INSERT 展開**: ブロック含むDWGで、展開後ジオメトリが現れる（Dynblocks 等）。
- [x] 角度単位（§8-1）の確定をテストで固定。
- [x] 警告エラーコードのファイルが成功扱いになる。
- [x] `buildImportResult` 抽出後も既存DXFテストが全パス。

### Playwright（E2E）
- [x] `.dwg` をドロップ → 取り込みダイアログ → キャンバス描画。（`tests/e2e/dwg_import.spec.ts`、example_2018.dwg）
- [x] 重いDWGでUIがフリーズしない（Worker）。（同 spec、Dynblocks.dwg + rAF カウンタで検証）

### ビルド/配布
- [x] 本番ビルドで wasm が遅延チャンク分離・初期ロード非混入。（dist で wasm は単独アセット、worker は遅延チャンク。PR #7 でチャンクスリム化）
- [x] 配布物に LICENSE/THIRD-PARTY/wasm 同梱。（`release.yml` の zip 対象に LICENSE/THIRD-PARTY-LICENSES.md を追加、wasm は dist 内）

---

## 11. 受け入れ条件（DoD）
- 代表的な複数バージョン＋ブロック多用DWGが空にならず正しく取り込める。
- 取り込み結果が既存編集・保存・DXF書き出しと矛盾なく連携。
- 既存DXF取り込みの挙動・テストが不変。
- 重い図面でUIがフリーズしない。
- GPL-3.0 対応（ライセンス・第三者表示・ソース提供リンク）が配布物に反映済み。

---

## 12. 推奨コミット分割（subject は英語）
1. `refactor(dxf): extract buildImportResult from importDxf`（挙動不変・テスト緑）
2. `chore: add @mlightcad/libredwg-web and relicense to GPL-3.0`（§9 一括）
3. `feat(dwg): add wasm loader and DwgDatabase->Polygon importer`（§3.1,3.3,§4 基本entity）
4. `feat(dwg): recursive INSERT/block expansion`（§3.2）
5. `feat(dwg): add ellipse/spline approximation`（§4）
6. `perf(dwg): run parsing in a web worker`（§6）
7. `feat(ui): wire .dwg drop/menu import`（§7）
8. `test(dwg): fixtures and version/block coverage`（§10）
