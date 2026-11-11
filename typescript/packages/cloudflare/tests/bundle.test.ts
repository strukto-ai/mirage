// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, it } from 'vitest'

const LIMIT = 64 * 1024 * 1024
const WRANGLER = fileURLToPath(new URL('../node_modules/.bin/wrangler', import.meta.url))
const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url))
let outdir: string
let files: Map<string, number>

/** Each file a dry run of `config` would upload, by size, given extra `args`. */
function dryRun(into: string, config: string, args: readonly string[]): Map<string, number> {
  execFileSync(
    WRANGLER,
    [
      'deploy',
      '--dry-run',
      '--outdir',
      into,
      '--config',
      path(config),
      '--alias',
      `cpu-features:${path('../src/cpu_features.ts')}`,
      ...args,
    ],
    { stdio: 'pipe', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
  )
  return new Map(
    readdirSync(into)
      .filter((name) => !name.endsWith('.map'))
      .map((name) => [name, statSync(join(into, name)).size]),
  )
}

const total = (sizes: Map<string, number>) => [...sizes.values()].reduce((sum, n) => sum + n, 0)

beforeAll(() => {
  outdir = mkdtempSync(join(tmpdir(), 'mirage-cloudflare-bundle-'))
  files = dryRun(outdir, './wrangler.toml', [])
}, 120_000)

afterAll(() => {
  rmSync(outdir, { recursive: true, force: true })
})

it('fits the upload limit', () => {
  expect(total(files)).toBeLessThan(LIMIT)
})

// The `1password` source's core takes a Worker that also carries the
// rest past the limit unminified, so the quickstart sets `minify`.
it('fits the upload limit with the 1password source, minified', () => {
  const into = mkdtempSync(join(tmpdir(), 'mirage-cloudflare-bundle-1password-'))
  try {
    const sizes = dryRun(into, './bundle_onepassword.toml', [
      '--minify',
      '--alias',
      `@1password/sdk-core:${path('../src/generated/onepassword_core.js')}`,
    ])
    expect([...sizes.keys()].some((name) => name.endsWith('onepassword_core.wasm'))).toBe(true)
    expect(total(sizes)).toBeLessThan(LIMIT)
  } finally {
    rmSync(into, { recursive: true, force: true })
  }
}, 180_000)

it('loads the Rust modules as .wasm files, with no base64 copy in the script', () => {
  for (const module of ['mirage_rs.wasm', 'mirage_shell.wasm', 'mirage_gh.wasm']) {
    expect([...files.keys()].some((name) => name.endsWith(module))).toBe(true)
  }
  // A base64 copy of a module would be one run of millions of base64
  // characters; the script's own longest run is tens of thousands.
  const script = readFileSync(join(outdir, 'worker.js'), 'latin1')
  let longest = 0
  for (const run of script.matchAll(/[A-Za-z0-9+/=]+/g)) longest = Math.max(longest, run[0].length)
  expect(longest).toBeLessThan(1024 * 1024)
})

it('carries the file server a machine mounts, with ssh2 in it', () => {
  const script = readFileSync(join(outdir, 'worker.js'), 'latin1')
  expect(script).toContain('__name(this, "PipeServer")')
  expect(script).toContain('ssh2/lib/protocol/SFTP.js')
})

it('ships no QuickJS', () => {
  expect([...files.keys()].some((name) => name.includes('qjs'))).toBe(false)
})
