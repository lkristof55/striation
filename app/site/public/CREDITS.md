# Credits: Striation ($STRIAE)

Every third-party asset shipped in `site/public/`, with its source and license.

## 3D and textures

| Asset | File | Author | Source | License |
|---|---|---|---|---|
| Monochrome Studio 02 (HDRI, 1k .hdr) | `tex/monochrome_studio_02_1k.hdr` | Grzegorz Wronkowski | https://polyhaven.com/a/monochrome_studio_02 | CC0 1.0 |
| Striation bench (bullet built from the CHILL create tx fixture, lead core, CT gantry, couch) | `models/striation-bench.glb` | Striation contributors (procedural: the bullet geometry is generated from a recorded pump.fun create tx; draco-compressed with gltf-transform) | built for this project | MIT (this repository) |
| Draco decoder (`draco_decoder.js`, `draco_decoder.wasm`, `draco_wasm_wrapper.js`) | `draco/` | Google / The Draco Authors, shipped with three.js r186 | https://github.com/google/draco | Apache-2.0 |

## Fonts

| Face | File | Author | Source | License |
|---|---|---|---|---|
| Mohave (variable, latin) | `fonts/Mohave-VF-latin.woff2` | Gumpita Rahayu, Tokotype | https://fonts.google.com/specimen/Mohave | SIL Open Font License 1.1 |
| Atkinson Hyperlegible Next (variable, latin) | `fonts/AtkinsonHyperlegibleNext-VF-latin.woff2` | Braille Institute of America | https://fonts.google.com/specimen/Atkinson+Hyperlegible+Next | SIL Open Font License 1.1 |
| Atkinson Hyperlegible Mono (variable, latin) | `fonts/AtkinsonHyperlegibleMono-VF-latin.woff2` | Braille Institute of America | https://fonts.google.com/specimen/Atkinson+Hyperlegible+Mono | SIL Open Font License 1.1 |

The full license text and copyright notice of each font ships next to it: `fonts/OFL-*.txt`.

## Data referenced by the design

- Relay tip-account table: 0xfnzero/sol-trade-sdk `src/constants/swqos.rs` (MIT), used by the library (`src/tips.js`).
- Launch-tool names appear as plain text only. They are factual attributions from the tools' own public stamps (metadata host, description, cited fee collector). No logos or trade dress are used.
