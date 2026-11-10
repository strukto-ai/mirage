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
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'

import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import { MountMode, PathSpec } from '../../../../types.ts'
import { Workspace } from '../../../../workspace/workspace/workspace.ts'
import { GIT } from './index.ts'
import { ensureDir } from './io.ts'

const DEC = new TextDecoder()
const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
}

let tmp: string
let repoPath: string
let ws: Workspace

function walk(root: string, base = root): string[] {
  const out: string[] = []
  for (const entry of readdirSync(root)) {
    const full = join(root, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full, base))
    else out.push(relative(base, full).split(sep).join('/'))
  }
  return out
}

function native(args: readonly string[]): [number, string, string] {
  const done = spawnSync('git', args, { cwd: repoPath, env: ENV, encoding: 'utf8' })
  return [done.status ?? -1, done.stdout, done.stderr]
}

async function run(line: string): Promise<[number, string, string]> {
  const result = await ws.shell(`git -C /repo ${line}`)
  return [result.exitCode, DEC.decode(result.stdout), DEC.decode(result.stderr)]
}

async function mounted(): Promise<Workspace> {
  const workspace = new Workspace({ '/repo': new RAMVFS() }, { mode: MountMode.WRITE })
  for (const rel of walk(repoPath)) {
    const target = `/repo/${rel}`
    await ensureDir(workspace.vfs, PathSpec.fromStrPath(target).parent)
    await workspace.dispatch('write', target, [new Uint8Array(readFileSync(join(repoPath, rel)))])
  }
  workspace.registerCli('git', GIT)
  return workspace
}

function commit(name: string, text: string, message: string): void {
  writeFileSync(join(repoPath, name), text)
  native(['add', name])
  native(['commit', '-q', '-m', message])
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'mirage-git-'))
  repoPath = tmp
  native(['init', '-q', '-b', 'main'])
  commit('a.txt', 'one\n', 'first')
  commit('b.txt', 'two\n', 'second')
  commit('a.txt', 'one changed\n', 'third')
  native(['tag', '-a', '-m', 'one', 'v1', 'HEAD~1'])
  native(['tag', 'light'])
  ws = await mounted()
})

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

it.each([
  [['describe']],
  [['describe', '--tags']],
  [['describe', '--all']],
  [['describe', '--long']],
  [['describe', '--abbrev=0']],
  [['describe', '--match', 'v*']],
  [['describe', '--exclude', 'v*']],
  [['describe', 'HEAD~2']],
  [['describe', '--always', 'HEAD~2']],
  [['describe', '--dirty']],
  [['describe', '--dirty=+wip']],
  [['describe', 'nope']],
])('matches git: %j', async (words) => {
  const line = words.map((word) => `'${word}'`).join(' ')
  expect(await run(line)).toEqual(native(words))
})
