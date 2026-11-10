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
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { SessionProfile } from '../../../../policy/profile.ts'
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

const SEALED: Record<string, SessionProfile> = {
  sealed: { commands: { deny: [{ reason: 'sealed', paths: ['/repo/a.txt'] }] } },
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

async function mounted(profiles: Record<string, SessionProfile> = {}): Promise<Workspace> {
  const workspace = new Workspace({ '/repo': new RAMVFS() }, { mode: MountMode.WRITE, profiles })
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

function history(): void {
  repoPath = mkdtempSync(join(tmp, 'repo-'))
  native(['init', '-q', '-b', 'main'])
  commit('a.txt', 'one\n', 'first')
  commit('b.txt', 'two\n', 'second')
  commit('a.txt', 'one changed\n', 'third')
}

function conflicted(): void {
  history()
  native(['checkout', '-q', '-b', 'side', 'HEAD~1'])
  commit('a.txt', 'one side\n', 'side')
  native(['checkout', '-q', 'main'])
  native(['merge', '-q', 'side'])
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mirage-git-'))
})

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('a merge stopped on a conflict', () => {
  beforeAll(async () => {
    conflicted()
    ws = await mounted()
  })

  it.each([
    'diff-files',
    'diff-files --name-status',
    'diff-files --stat',
    'diff-files --numstat',
    'diff-files -p',
  ])('matches git: %s', async (command) => {
    expect(await run(command)).toEqual(native(command.split(' ')))
  })
})

describe('a merge that resolved a conflict', () => {
  beforeAll(async () => {
    conflicted()
    commit('a.txt', 'resolved\n', 'merge')
    ws = await mounted()
  })

  it.each([
    'diff-tree -c HEAD',
    'diff-tree --cc HEAD',
    'diff-tree -c --full-index HEAD',
    'diff-tree -c --diff-filter=M HEAD',
    'diff-tree -c --diff-filter=A HEAD',
    'diff-tree -c --diff-filter=m HEAD',
    'show --format= --cc --no-prefix HEAD',
    'show --format= --cc --full-index HEAD',
  ])('matches git: %s', async (command) => {
    expect(await run(command)).toEqual(native(command.split(' ')))
  })
})

describe('a conflict whose file is gone', () => {
  beforeAll(async () => {
    conflicted()
    rmSync(join(repoPath, 'a.txt'))
    ws = await mounted(SEALED)
    ws.createSession('sealed', { profile: 'sealed' })
  })

  it('keeps its saved stages behind the rules', async () => {
    const result = await ws.shell('git -C /repo diff-files -p', { sessionId: 'sealed' })
    expect([result.exitCode, DEC.decode(result.stdout), DEC.decode(result.stderr)]).toEqual([
      1,
      '',
      'git diff-files: /repo/a.txt: Permission denied\n',
    ])
  })
})

describe.each([
  ['stopped on a conflict', conflicted],
  ['with a clean index', history],
])('a file holding the bytes of a denied path, %s', (_name, build) => {
  beforeAll(async () => {
    build()
    writeFileSync(join(repoPath, 'b.txt'), 'one changed\n')
    ws = await mounted(SEALED)
    ws.createSession('sealed', { profile: 'sealed' })
  })

  it.each(['diff-files -p -- b.txt', 'diff -- b.txt', 'diff-index -p HEAD -- b.txt'])(
    'still shows: %s',
    async (command) => {
      const result = await ws.shell(`git -C /repo ${command}`, { sessionId: 'sealed' })
      expect([result.exitCode, DEC.decode(result.stderr)]).toEqual([0, ''])
      expect(DEC.decode(result.stdout)).toContain('+one changed\n')
    },
  )
})
