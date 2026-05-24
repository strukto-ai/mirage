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

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

function cliBin(): string {
  const pkgPath = require.resolve('@struktoai/mirage-cli/package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
    bin: { mirage: string }
  }
  return join(dirname(pkgPath), pkg.bin.mirage)
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0
      srv.close(() => {
        resolve(port)
      })
    })
  })
}

interface DiffResult {
  added: string[]
  modified: string[]
  deleted: string[]
}

function run(bin: string, env: Record<string, string>, args: string[]): unknown {
  const r = spawnSync(process.execPath, [bin, ...args], {
    env,
    encoding: 'utf-8',
    timeout: 60000,
  })
  if (r.status !== 0) {
    throw new Error(`mirage ${args.join(' ')} exited ${String(r.status)}\n${r.stderr}`)
  }
  const out = r.stdout.trim()
  return out === '' ? {} : (JSON.parse(out) as unknown)
}

function showLog(bin: string, env: Record<string, string>, id: string, ref: string): void {
  const entries = run(bin, env, ['workspace', 'log', id, '-b', ref]) as {
    message: string
  }[]
  console.log(`=== log ${ref} ===`)
  for (const e of entries) console.log(e.message)
}

function showDiff(
  bin: string,
  env: Record<string, string>,
  id: string,
  a: string,
  b: string,
): void {
  const d = run(bin, env, ['workspace', 'diff', id, a, b]) as DiffResult
  console.log(`=== diff ${a} ${b} ===`)
  for (const p of d.added) console.log(`added: ${p}`)
  for (const p of d.modified) console.log(`modified: ${p}`)
  for (const p of d.deleted) console.log(`deleted: ${p}`)
}

async function main(): Promise<void> {
  const bin = cliBin()
  const work = mkdtempSync(join(tmpdir(), 'mirage-version-'))
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v
  env.MIRAGE_DAEMON_URL = `http://127.0.0.1:${String(await freePort())}`
  env.MIRAGE_VERSION_ROOT = join(work, 'repos')
  env.MIRAGE_IDLE_GRACE_SECONDS = '60'
  const cfg = join(work, 'config.yaml')
  writeFileSync(cfg, 'mounts:\n  /:\n    resource: ram\n    mode: write\n')
  try {
    const id = (run(bin, env, ['workspace', 'create', cfg]) as { id: string }).id
    console.log('=== create workspace (ram mount) ===')

    run(bin, env, ['execute', '-w', id, '-c', 'echo one > /a.txt'])
    run(bin, env, ['workspace', 'commit', id, '-m', 'first'])
    console.log("=== committed 'first' on main ===")

    run(bin, env, ['workspace', 'branch', id, 'exp'])
    console.log('=== branched exp from main ===')

    run(bin, env, ['execute', '-w', id, '-c', 'echo two > /a.txt'])
    run(bin, env, ['execute', '-w', id, '-c', 'echo new > /b.txt'])
    run(bin, env, ['workspace', 'commit', id, '-b', 'exp', '-m', 'on exp'])
    console.log("=== committed 'on exp' on exp ===")

    run(bin, env, ['execute', '-w', id, '-c', 'echo three > /a.txt'])
    run(bin, env, ['execute', '-w', id, '-c', 'rm /b.txt'])
    run(bin, env, ['workspace', 'commit', id, '-b', 'main', '-m', 'second'])
    console.log("=== committed 'second' on main ===")

    showLog(bin, env, id, 'main')
    showLog(bin, env, id, 'exp')
    showDiff(bin, env, id, 'main', 'exp')
  } finally {
    spawnSync(process.execPath, [bin, 'daemon', 'stop'], {
      env,
      encoding: 'utf-8',
      timeout: 30000,
    })
    rmSync(work, { recursive: true, force: true })
  }
}

await main()
