#!/usr/bin/env node
// Copies the editor's lazily loaded libraries (KaTeX, Mermaid, ECharts, …)
// from the pinned @umoteam/editor-external package into dist/external/, so the
// build loads them from its own origin instead of
// https://unpkg.com/@umoteam/editor-external@latest (the upstream `cdnUrl`).
//
// Why: Calliope Campus serves this build on its own origin under
// /editors/umo/, where every script the page loads runs with Campus's rights.
// An unpinned script from a CDN must not be one of them. src/app.vue points
// `cdnUrl` at `${BASE_URL}external` in every production build.
//
// Only the files the editor asks for (`${cdnUrl}/libs/…`, `${cdnUrl}/icons/…`
// in src/), not the whole package: its source maps and other ECharts builds
// are some 50 MB.
import { cpSync, existsSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const from = dirname(require.resolve('@umoteam/editor-external/package.json'))
const to = join(root, 'dist', 'external')

const FILES = [
  'libs/katex/katex.min.js',
  'libs/katex/katex.min.css',
  'libs/katex/fonts',
  'libs/mermaid/mermaid.min.js',
  'libs/echarts/echarts.min.js',
  'libs/plantuml/plantuml-encoder.min.js',
  'libs/flowchart/raphael.min.js',
  'libs/flowchart/flowchart.js',
  'libs/plyr/plyr.css',
  'libs/plyr/plyr.min.js',
  'libs/plyr/plyr.svg',
  'icons/file',
  'package.json',
]

if (!existsSync(join(root, 'dist'))) {
  throw new Error('dist/ is missing: run `vite build --mode site` first')
}
rmSync(to, { recursive: true, force: true })
for (const file of FILES) {
  const source = join(from, file)
  if (!existsSync(source)) {
    throw new Error(`@umoteam/editor-external has no ${file}`)
  }
  cpSync(source, join(to, file), { recursive: true })
}
console.log(`Copied ${FILES.length} entries of ${from} to dist/external/`)
