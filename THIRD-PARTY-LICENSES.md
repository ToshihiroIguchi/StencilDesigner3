# 第三者ライセンス表示 (Third-Party Licenses)

本アプリケーション（StencilDesigner3）は、配布物（ブラウザへ配信される成果物）に
以下の第三者コンポーネントを同梱しています。各コンポーネントの著作権・ライセンス・
取得元を以下に明記します。GPL-3.0 コンポーネントの組み込みにより、本アプリ全体は
**GPL-3.0-or-later** で配布されます（ルートの `LICENSE` を参照）。

---

## @mlightcad/libredwg-web (GPL-3.0)

- 用途: DWG ファイルの読み込み（WebAssembly。`.wasm` を配布物に同梱）
- バージョン: ^0.7.2
- ライセンス: GNU General Public License v3.0 (GPL-3.0)
- 取得元 / 対応ソース: https://github.com/mlightcad/libredwg-web
- npm: https://www.npmjs.com/package/@mlightcad/libredwg-web

`@mlightcad/libredwg-web` は GNU LibreDWG を Emscripten で WebAssembly 化したもので、
内部に LibreDWG 由来のコードを含みます。

## GNU LibreDWG (GPL-3.0)

- 用途: 上記 `@mlightcad/libredwg-web` の基盤となる DWG/DXF ライブラリ本体
- ライセンス: GNU General Public License v3.0 (GPL-3.0)
- 取得元 / 対応ソース: https://www.gnu.org/software/libredwg/
- ソースリポジトリ: https://git.savannah.gnu.org/cgit/libredwg.git

---

## 対応するソースの提供について (GPL §6)

- 本アプリケーション自身の完全な対応ソースは、本リポジトリ
  （https://github.com/ToshihiroIguchi/StencilDesigner3 ）です。
- 同梱する第三者 GPL コンポーネントの対応ソースは、上記の各「取得元 / 対応ソース」
  リンク（バージョン固定）から取得できます。
- 配布物には本ファイルおよび `LICENSE`（GPL-3.0 全文）を同梱します。第三者コンポーネント
  に含まれる著作権・ライセンス通知は除去・改変しません。

---

## その他の依存ライブラリ

以下は本アプリが利用するその他の主な依存（ランタイム同梱されるもの）。各ライセンスは
それぞれのパッケージに従います（多くは MIT 等のパーミッシブライセンス）。

- clipper-lib (Boost Software License)
- dxf-parser (MIT)
- @tarikjabiri/dxf (MIT)
- jspdf (MIT)
- localforage (Apache-2.0)
- opentype.js (MIT)

各ライブラリの正確なライセンス条文は `node_modules/<package>/` 配下の LICENSE 等を参照
してください。
