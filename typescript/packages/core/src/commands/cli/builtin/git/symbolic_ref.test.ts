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
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, it } from 'vitest'

import { createShellParser, type ShellParser } from '../../../../shell/parse/index.ts'
import { MountMode } from '../../../../types.ts'
import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import { Workspace } from '../../../../workspace/workspace/workspace.ts'
import { GIT } from './index.ts'

const BUILDER = fileURLToPath(
  new URL('../../../../../../../../integ/fixtures/git/build.sh', import.meta.url),
)
const DEC = new TextDecoder()
const require = createRequire(import.meta.url)

let parser: ShellParser
let fixture: string

beforeAll(async () => {
  parser = await createShellParser({
    engineWasm: readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm')),
    grammarWasm: readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm')),
  })
  fixture = join(mkdtempSync(join(tmpdir(), 'mirage-symbolic-ref-')), 'repo')
  execFileSync('bash', [BUILDER, fixture], { stdio: 'ignore' })
})

afterAll(() => {
  rmSync(dirname(fixture), { recursive: true, force: true })
})

async function load(ws: Workspace, root: string, relative = ''): Promise<void> {
  for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      await ws.shell(`mkdir -p /repo/${name}`)
      await load(ws, root, name)
    } else await ws.dispatch('write', `/repo/${name}`, [readFileSync(join(root, name))])
  }
}

async function workspace(): Promise<Workspace> {
  const ws = new Workspace(
    { '/repo': new RAMVFS() },
    { mode: MountMode.WRITE, shellParser: parser },
  )
  await load(ws, fixture)
  ws.registerCli('git', GIT)
  return ws
}

async function run(ws: Workspace, line: string): Promise<[number, string, string]> {
  const result = await ws.shell(`git -C /repo ${line}`)
  return [result.exitCode, DEC.decode(result.stdout), DEC.decode(result.stderr)]
}

async function cat(ws: Workspace, path: string): Promise<string> {
  return DEC.decode((await ws.shell(`cat /repo/.git/${path}`)).stdout)
}

async function logLines(ws: Workspace, path: string): Promise<string[]> {
  return (await cat(ws, `logs/${path}`)).split('\n').filter(Boolean)
}

async function exists(ws: Workspace, path: string): Promise<boolean> {
  return (await ws.shell(`test -e /repo/.git/${path}`)).exitCode === 0
}

it('logs a move as git does', async () => {
  const ws = await workspace()
  const before = await logLines(ws, 'HEAD')
  await run(ws, 'symbolic-ref HEAD refs/heads/topic')
  const moved = await logLines(ws, 'HEAD')
  expect(moved).toHaveLength(before.length + 1)
  expect(moved.at(-1)).not.toContain('\t')
  await run(ws, 'symbolic-ref HEAD refs/heads/unborn')
  expect(await logLines(ws, 'HEAD')).toEqual(moved)
  await run(ws, 'symbolic-ref refs/heads/sym refs/heads/main')
  await run(ws, 'symbolic-ref refs/other refs/heads/main')
  expect((await logLines(ws, 'refs/heads/sym'))[0]?.startsWith('0'.repeat(40))).toBe(true)
  expect(await exists(ws, 'logs/refs/other')).toBe(false)
})

it('lets core.logAllRefUpdates decide which refs are logged', async () => {
  const ws = await workspace()
  await ws.shell("printf '[core]\\n\\tlogAllRefUpdates = always\\n' >> /repo/.git/config")
  await run(ws, 'symbolic-ref refs/other refs/heads/main')
  expect(await logLines(ws, 'refs/other')).toHaveLength(1)
  await ws.shell("printf '[core]\\n\\tlogAllRefUpdates = false\\n' >> /repo/.git/config")
  await run(ws, 'symbolic-ref refs/heads/sym refs/heads/main')
  expect(await exists(ws, 'logs/refs/heads/sym')).toBe(false)
})

it('deletes the log with the ref, and answers a cycle as no such ref', async () => {
  const ws = await workspace()
  await ws.shell(
    'printf \'%s refs/heads/sym\\n\' "$(cat /repo/.git/refs/heads/main)" >> /repo/.git/packed-refs',
  )
  await run(ws, 'symbolic-ref refs/heads/sym refs/heads/main')
  expect(await run(ws, 'symbolic-ref -d refs/heads/sym')).toEqual([0, '', ''])
  expect(await exists(ws, 'logs/refs/heads/sym')).toBe(false)
  expect((await run(ws, 'rev-parse -q --verify refs/heads/sym'))[0]).toBe(1)
  await run(ws, 'symbolic-ref CYCLE_A CYCLE_B')
  await run(ws, 'symbolic-ref CYCLE_B CYCLE_A')
  expect(await run(ws, 'symbolic-ref CYCLE_A')).toEqual([128, '', 'fatal: No such ref: CYCLE_A\n'])
})
