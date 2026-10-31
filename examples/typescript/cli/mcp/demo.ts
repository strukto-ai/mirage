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

import { deepStrictEqual, ok, rejects } from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { type CLI, MountMode, RAMVFS, Workspace } from '@struktoai/mirage-node'

import { TEMPLATE as CLI_TEMPLATE, checkNames, fetchTools, fill, type Server } from './mcp_to_cli.ts'
import { TEMPLATE as MIRAGE_TEMPLATE } from './mcp_to_mirage.ts'

// Converts demo_server.ts both ways, then runs the same commands through the
// real CLI (a subprocess) and the virtual CLI (inside a workspace) and checks
// they answer alike. Run from examples/typescript:
//
//   npx tsx cli/mcp/demo.ts

const HERE = fileURLToPath(new URL('.', import.meta.url))
const SERVER: Server = { command: [process.execPath, 'demo_server.ts'], cwd: HERE }
const CASES: string[][] = [
  ['add-numbers', '{"a": 2, "b": 40}'],
  [
    'create-ticket',
    '{"title": "Fix login", "labels": ["bug"], "owner": {"name": "Ana", "email": "ana@example.com"}}',
  ],
  ['delete-project', '{"project": "core"}'],
  ['add-numbers', '[1, 2]'],
  ['add-numbers', '{"a": 1'],
  ['add-numbers', '{}', '{}'],
  ['add-numbers', '--', '{"a": 1, "b": 2}'],
  ['add-numbers', '-x'],
  ['add-numbers', '-hx'],
  ['add-numbers', '--verbose'],
  ['add-numbers', '--he'],
  ['add-numbers', '-1'],
  ['add-numbers', '-1.5'],
  ['add-numbers', '-x', '--help'],
  ['add-numbers', '-x', '-hh'],
  ['add-numbers', '--help=1'],
  ['--', 'add-numbers', '{"a": 1, "b": 2}'],
  ['--', '-x'],
  ['--'],
  ['nope'],
  ['-x'],
  ['-hx'],
  ['--verbose=1'],
  ['--he=1'],
  ['--he'],
  [],
  ['--help'],
  ['create-ticket', '--help'],
]

function quote(word: string): string {
  return `'${word.replaceAll("'", "'\\''")}'`
}

async function main(): Promise<void> {
  const tools = await fetchTools(SERVER)
  checkNames(tools)
  // Inside this folder, so the generated files resolve the example's packages.
  const out = mkdtempSync(join(HERE, '.generated-'))
  const ws = new Workspace({ '/ram': new RAMVFS() }, { mode: MountMode.WRITE })
  try {
    const real = join(out, 'demo.mjs')
    writeFileSync(real, fill(CLI_TEMPLATE, 'demo', SERVER, tools))
    const virtual = join(out, 'demo_cli.ts')
    writeFileSync(virtual, fill(MIRAGE_TEMPLATE, 'demo', SERVER, tools))
    const { DEMO } = (await import(pathToFileURL(virtual).href)) as { DEMO: CLI }
    deepStrictEqual(
      [DEMO.handlers['add-numbers']?.write, DEMO.handlers['delete-project']?.write],
      [false, true],
    )
    ws.registerCli('demo', DEMO, {})

    for (const words of CASES) {
      const line = ['demo', ...words.map(quote)].join(' ')
      const result = await ws.shell(line)
      const seen = [result.exitCode, result.stdoutText, result.stderrText]
      const run = spawnSync(process.execPath, [real, ...words], { encoding: 'utf8' })
      deepStrictEqual(seen, [run.status, run.stdout, run.stderr], line)
      console.log(`$ ${line}\n[exit ${result.exitCode}] ${result.stdoutText}${result.stderrText}`)
    }

    const line = `demo add-numbers '{"a": 2, "b": 40}' > /ram/sum.txt && cat /ram/sum.txt`
    const result = await ws.shell(line)
    deepStrictEqual(result.stdoutText, '42\n')
    console.log(`$ ${line}\n42`)

    const clash = join(out, 'name_cli.ts')
    writeFileSync(clash, fill(MIRAGE_TEMPLATE, 'name', SERVER, tools))
    const { NAME } = (await import(pathToFileURL(clash).href)) as { NAME: CLI }
    ws.registerCli('name', NAME, {})
    const refused = await ws.shell(`name add-numbers '{'`)
    ok(refused.stderrText.startsWith('name add-numbers: invalid JSON'), refused.stderrText)

    const marker = join(out, 'written')
    const slow = `demo slow-write '${JSON.stringify({ path: marker })}'`
    const running = ws.shell(slow)
    for (let tries = 0; tries < 200 && !existsSync(`${marker}.started`); tries++) await setTimeout(50)
    await ws.cancel()
    await rejects(running, { name: 'AbortError' })
    console.log(`$ ${slow}\n^C`)
    await setTimeout(3000)
    ok(!existsSync(marker), 'the cancelled tool still wrote')
  } finally {
    await ws.close()
    rmSync(out, { recursive: true, force: true })
  }
}

const entrypoint = process.argv[1]
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) await main()
