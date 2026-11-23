#!/usr/bin/env node
// The build's version as BUILD.json holds it (docs/build-info.md).
//
// The calliope-build workflow sets BUILD_CHANNEL, BUILD_VERSION, BUILD_COMMIT
// and BUILD_AT once per job; vite.config.js compiles the same object in as
// __BUILD_INFO__ (logged once to the console, src/app.vue), and the workflow
// writes BUILD.json next to the build with `node bin/build-info.js`. Without
// those variables (`npm run dev:campus`, a local build) the channel is "local"
// and version and commit come from git.
//
// A copy of calliope-mini-python-editor's bin/build-info.js, the editor that
// defines the format; only `ui`, `widget` and `libs` differ per editor.
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const CHANNELS = ['live', 'dev', 'local']

const here = fileURLToPath(new URL('.', import.meta.url))

const git = (args) => {
  try {
    return execSync(`git ${args}`, {
      cwd: here,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
  } catch {
    return ''
  }
}

/**
 * @param {Record<string, string | undefined>} env
 */
export const buildInfo = (env = process.env) => {
  const channel = env.BUILD_CHANNEL || 'local'
  if (!CHANNELS.includes(channel)) {
    throw new Error(
      `BUILD_CHANNEL must be one of ${CHANNELS.join(', ')}, not "${channel}"`,
    )
  }
  return {
    channel,
    // live: the tag (calliope-vX.Y.Z); dev: the branch (calliope-main).
    version: env.BUILD_VERSION || git('rev-parse --abbrev-ref HEAD') || 'local',
    commit: env.BUILD_COMMIT || git('rev-parse HEAD'),
    builtAt: env.BUILD_AT || new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    // UMO carries neither calliope-ui nor the connection widget.
    ui: null,
    widget: null,
    // Pinned library forks, name → commit; UMO has none.
    libs: {},
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.stdout.write(JSON.stringify(buildInfo(), null, 2) + '\n')
}
