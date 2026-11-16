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
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import { MountMode, PathSpec } from '../../../../types.ts'
import { Workspace } from '../../../../workspace/workspace/workspace.ts'
import { GIT } from './index.ts'
import { addShallow, openRepo } from './repo.ts'

const DEC = new TextDecoder()

function native(root: string, args: string[]): string {
  return execFileSync(
    'git',
    ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args],
    { encoding: 'utf8', stdio: 'pipe' },
  )
}

async function load(ws: Workspace, root: string, relative = ''): Promise<void> {
  for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      await ws.shell(`mkdir -p /repo/${name}`)
      await load(ws, root, name)
    } else await ws.dispatch('write', `/repo/${name}`, [readFileSync(join(root, name))])
  }
}

it('reads a shallow commit parentless and keeps its raw parent line', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mirage-shallow-'))
  const ws = new Workspace({ '/repo': new RAMVFS() }, { mode: MountMode.WRITE })
  ws.registerCli('git', GIT)
  try {
    native(root, ['init', '-q', '-b', 'main'])
    for (const subject of ['first', 'second', 'third'])
      native(root, ['commit', '-q', '--allow-empty', '-m', subject])
    const second = native(root, ['rev-parse', 'HEAD~1']).trim()
    await load(ws, root)
    await ws.dispatch('write', '/repo/.git/shallow', [new TextEncoder().encode(`${second}\n`)])
    const log = await ws.shell('git -C /repo log --format=%s/%P/%D')
    expect(log.exitCode).toBe(0)
    const rows = DEC.decode(log.stdout).trimEnd().split('\n')
    expect(rows).toHaveLength(2)
    expect(rows[1]).toBe('second//grafted')
    const raw = await ws.shell(`git -C /repo cat-file -p ${second}`)
    expect(DEC.decode(raw.stdout)).toContain('\nparent ')
  } finally {
    await ws.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it('keeps every cut when two shallow updates run side by side', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mirage-shallow-'))
  const ws = new Workspace({ '/repo': new RAMVFS() }, { mode: MountMode.WRITE })
  try {
    native(root, ['init', '-q', '-b', 'main'])
    native(root, ['commit', '-q', '--allow-empty', '-m', 'first'])
    await load(ws, root)
    const top = PathSpec.fromStrPath('/repo')
    const gitdir = top.join('.git')
    const repo = await openRepo(ws.vfs, {
      gitdir,
      commondir: gitdir,
      worktree: top,
      mountRoot: top,
    })
    const [first, second] = ['1'.repeat(40), '2'.repeat(40)]
    await Promise.all([addShallow(repo, [first]), addShallow(repo, [second])])
    const shallow = await ws.dispatch('read', '/repo/.git/shallow')
    expect(DEC.decode(shallow as Uint8Array)).toBe(`${first}\n${second}\n`)
  } finally {
    await ws.close()
    rmSync(root, { recursive: true, force: true })
  }
})
