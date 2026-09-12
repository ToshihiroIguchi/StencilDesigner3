# Third-Party Licenses

This application (StencilDesigner3) bundles the following third-party components within its distribution (artifacts served to the browser). The copyright, license, and source origin for each component are specified below. Due to the inclusion of GPL-3.0 components, the entire application is distributed under **GPL-3.0-or-later** (see `LICENSE` in the root directory).

---

## @mlightcad/libredwg-web (GPL-3.0)

- Purpose: DWG file loading (WebAssembly; `.wasm` bundled in distribution)
- Version: ^0.7.2
- License: GNU General Public License v3.0 (GPL-3.0)
- Source Origin / Corresponding Source: https://github.com/mlightcad/libredwg-web
- npm: https://www.npmjs.com/package/@mlightcad/libredwg-web

`@mlightcad/libredwg-web` is a WebAssembly port of GNU LibreDWG built with Emscripten, and contains code derived from LibreDWG.

## GNU LibreDWG (GPL-3.0)

- Purpose: Core DWG/DXF library underlying `@mlightcad/libredwg-web`
- License: GNU General Public License v3.0 (GPL-3.0)
- Source Origin / Corresponding Source: https://www.gnu.org/software/libredwg/
- Source Repository: https://git.savannah.gnu.org/cgit/libredwg.git

---

## Provision of Corresponding Source (GPL §6)

- The complete Corresponding Source for this application itself is available in this repository (https://github.com/ToshihiroIguchi/StencilDesigner3).
- The Corresponding Source for bundled third-party GPL components can be obtained from the "Source Origin / Corresponding Source" links listed above (fixed versions).
- Distributed packages include this file and `LICENSE` (full text of GPL-3.0). Copyright and license notices contained in third-party components are not removed or altered.

---

## Other Dependent Libraries

Below are other primary runtime dependencies utilized by this application. Each library is governed by its respective license (mostly permissive licenses such as MIT):

- clipper-lib (Boost Software License)
- dxf-parser (MIT)
- @tarikjabiri/dxf (MIT)
- jspdf (MIT)
- localforage (Apache-2.0)
- opentype.js (MIT)

For the exact license terms of each library, please refer to the LICENSE files located under `node_modules/<package>/`.

---

## Bundled Fonts (OFL-1.1)

The application bundles the following font files in `public/fonts/`:

- **Big Shoulders Stencil Display** (`BigShouldersStencilDisplay-Regular.ttf`)
  - Copyright 2019 The Big Shoulders Stencil Display Project Authors (https://github.com/xotypeco/big_shoulders_stencil)
  - License: SIL Open Font License, Version 1.1 (see `public/fonts/OFL.txt`)
- **Noto Sans JP** (`NotoSansJP-Regular.ttf`)
  - Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Noto Sans'.
  - License: SIL Open Font License, Version 1.1
