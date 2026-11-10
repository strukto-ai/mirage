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
let outdir: string
let files: Map<string, number>

beforeAll(() => {
  outdir = mkdtempSync(join(tmpdir(), 'mirage-cloudflare-bundle-'))
  const wrangler = fileURLToPath(new URL('../node_modules/.bin/wrangler', import.meta.url))
  execFileSync(
    wrangler,
    [
      'deploy',
      '--dry-run',
      '--outdir',
      outdir,
      '--config',
      fileURLToPath(new URL('./wrangler.toml', import.meta.url)),
      '--alias',
      `cpu-features:${fileURLToPath(new URL('./cpu_features.ts', import.meta.url))}`,
    ],
    { stdio: 'pipe', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
  )
  files = new Map(
    readdirSync(outdir)
      .filter((name) => !name.endsWith('.map'))
      .map((name) => [name, statSync(join(outdir, name)).size]),
  )
}, 120_000)

afterAll(() => {
  rmSync(outdir, { recursive: true, force: true })
})

it('fits the upload limit', () => {
  const total = [...files.values()].reduce((sum, size) => sum + size, 0)
  expect(total).toBeLessThan(LIMIT)
})

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
