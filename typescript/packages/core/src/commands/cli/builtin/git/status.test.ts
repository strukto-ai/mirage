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
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { IOResult } from '../../../../io/types.ts'
import { OpsRegistry } from '../../../../ops/registry.ts'
import { RAMResource } from '../../../../resource/ram/ram.ts'
import { createShellParser, type ShellParser } from '../../../../shell/parse.ts'
import { MountMode } from '../../../../types.ts'
import { Workspace } from '../../../../workspace/workspace.ts'
import { GIT } from './index.ts'
import { ensureDir } from './io.ts'
import type { Dispatch } from './types.ts'

const BUILDER = fileURLToPath(
  new URL('../../../../../../../../integ/fixtures/git/build.sh', import.meta.url),
)
const DEC = new TextDecoder()

const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))

let parser: ShellParser
let tmp: string
const roots: string[] = []

beforeAll(async () => {
  parser = await createShellParser({ engineWasm, grammarWasm })
  tmp = mkdtempSync(join(tmpdir(), 'mirage-git-status-'))
})

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function walk(root: string, base = root): string[] {
  const out: string[] = []
  for (const entry of readdirSync(root)) {
    const full = join(root, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full, base))
    else out.push(relative(base, full).split(sep).join('/'))
  }
  return out
}

/** What the user does to the repository before status is asked. */
type Setup = (repo: string) => void

/**
 * Build the fixture, apply a setup, then mirror the whole tree into RAM.
 *
 * Both sides see the same bytes: the real binary answers off the disk copy and
 * mirage answers off the RAM one, so any difference is mirage's.
 */
async function stage(setup: Setup): Promise<[Workspace, string]> {
  const repo = mkdtempSync(join(tmp, 'repo-'))
  roots.push(repo)
  execFileSync('bash', [BUILDER, repo], { stdio: 'ignore' })
  setup(repo)

  const ram = new RAMResource()
  const registry = new OpsRegistry()
  registry.registerResource(ram)
  const ws = new Workspace(
    { '/repo': ram },
    { mode: MountMode.WRITE, ops: registry, shellParser: parser },
  )
  const dispatch: Dispatch = async (op, path, args = [], kwargs = {}) => [
    await ws.dispatch(op, path.virtual, args, kwargs),
    new IOResult(),
  ]
  for (const rel of walk(repo)) {
    const target = `/repo/${rel}`
    await ensureDir(dispatch, target.slice(0, target.lastIndexOf('/')))
    await ws.dispatch('write', target, [new Uint8Array(readFileSync(join(repo, rel)))])
    // The mode rides along, because git tracks the owner's execute bit and a
    // mirror that dropped it would make a `chmod +x` invisible to the copy under
    // test while the real binary still reports it.
    await ws.dispatch('setattr', target, [], { mode: statSync(join(repo, rel)).mode })
  }
  ws.registerCli('git', GIT)
  return [ws, repo]
}

/** Write a file, creating the directories above it. */
function put(repo: string, path: string, text: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true })
  writeFileSync(join(repo, path), text)
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
}

/** Both answers to the same `git status` spelling, mirage's first. */
async function both(setup: Setup, spelling: string[]): Promise<[string, string]> {
  const [ws, repo] = await stage(setup)
  const result = await ws.execute(`git -C /repo status ${spelling.join(' ')}`)
  return [DEC.decode(result.stdout), git(repo, ['status', ...spelling])]
}

// Every spelling git offers for the same report, so a divergence in one format
// cannot hide behind another.
const SPELLINGS = [[], ['--porcelain'], ['-s'], ['-sb'], ['--porcelain', '-b'], ['-uall']]

// Each row is a repository state and what the user did to reach it. The real
// binary is the truth for every one of them.
const STATES: [string, Setup][] = [
  ['a clean tree', () => undefined],
  [
    'an unstaged edit',
    (r) => {
      put(r, 'letters.txt', 'edited\n')
    },
  ],
  [
    'a staged edit',
    (r) => {
      put(r, 'letters.txt', 'edited\n')
      git(r, ['add', '-A'])
    },
  ],
  [
    'a staged edit and another on top',
    (r) => {
      put(r, 'letters.txt', 'edited\n')
      git(r, ['add', '-A'])
      put(r, 'letters.txt', 'edited again\n')
    },
  ],
  [
    'an untracked file',
    (r) => {
      put(r, 'fresh.txt', 'x\n')
    },
  ],
  [
    'an untracked directory',
    (r) => {
      put(r, 'newdir/inner.txt', 'x\n')
    },
  ],
  [
    'an untracked directory holding only ignored files',
    (r) => {
      put(r, '.gitignore', '*.log\n')
      put(r, 'logs/a.log', 'x\n')
    },
  ],
  [
    'a deleted tracked file',
    (r) => {
      rmSync(join(r, 'numbers.txt'))
    },
  ],
  [
    'a staged deletion',
    (r) => {
      rmSync(join(r, 'numbers.txt'))
      git(r, ['add', '-A'])
    },
  ],
  [
    'a staged new file',
    (r) => {
      put(r, 'fresh.txt', 'x\n')
      git(r, ['add', '-A'])
    },
  ],
  [
    'an ignored file',
    (r) => {
      put(r, '.gitignore', '*.log\n')
      put(r, 'debug.log', 'x\n')
      git(r, ['add', '.gitignore'])
    },
  ],
  [
    'a negated ignore rule',
    (r) => {
      put(r, '.gitignore', '*.log\n!keep.log\n')
      put(r, 'debug.log', 'x\n')
      put(r, 'keep.log', 'x\n')
      git(r, ['add', '.gitignore'])
    },
  ],
  [
    'a nested gitignore',
    (r) => {
      put(r, 'sub/.gitignore', '*.tmp\n')
      put(r, 'sub/a.tmp', 'x\n')
      put(r, 'sub/b.txt', 'x\n')
    },
  ],
  [
    'a tracked file inside an ignored directory',
    (r) => {
      put(r, '.gitignore', 'build/\n')
      put(r, 'build/kept.txt', 'x\n')
      git(r, ['add', '-f', 'build/kept.txt', '.gitignore'])
      git(r, ['commit', '-q', '-m', 'track inside ignored'])
      put(r, 'build/kept.txt', 'edited\n')
    },
  ],
  [
    'an exact rename',
    (r) => {
      git(r, ['mv', 'numbers.txt', 'digits.txt'])
    },
  ],
  [
    'a rename that also edited the file',
    (r) => {
      git(r, ['mv', 'letters.txt', 'chars.txt'])
      put(r, 'chars.txt', 'alpha\nbeta\ngamma\ndelta\nepsilon\n')
      git(r, ['add', '-A'])
    },
  ],
  [
    'a same-size edit',
    (r) => {
      put(r, 'numbers.txt', 'ONE\nTWO\n')
    },
  ],
  [
    'a path with a space',
    (r) => {
      put(r, 'two words.txt', 'x\n')
    },
  ],
  [
    'a path with a quote',
    (r) => {
      put(r, 'quo"te.txt', 'x\n')
    },
  ],
  [
    'a non-ASCII path',
    (r) => {
      put(r, 'ünïcødé.txt', 'x\n')
    },
  ],
  [
    'a detached HEAD',
    (r) => {
      git(r, ['checkout', '-q', 'HEAD~1'])
    },
  ],
  [
    'a mode change',
    (r) => {
      execFileSync('chmod', ['+x', join(r, 'numbers.txt')])
    },
  ],
]

describe('git status against the real binary', () => {
  const rows = STATES.flatMap(([name, setup]) =>
    SPELLINGS.map(
      (spelling) => [`${name} / git status ${spelling.join(' ')}`, setup, spelling] as const,
    ),
  )
  it.each(rows)('matches on %s', async (_name, setup, spelling) => {
    const [mine, theirs] = await both(setup, [...spelling])
    expect(mine).toBe(theirs)
  })
})
