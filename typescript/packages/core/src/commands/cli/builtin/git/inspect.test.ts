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

import { spawnSync, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, it } from 'vitest'

import { IOResult } from '../../../../io/types.ts'
import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import { createShellParser, type ShellParser } from '../../../../shell/parse/index.ts'
import { MountMode, PathSpec } from '../../../../types.ts'
import { Workspace } from '../../../../workspace/workspace/workspace.ts'
import { GIT } from './index.ts'
import { ensureDir } from './io.ts'
import type { Dispatch } from './types.ts'

const BUILDER = fileURLToPath(
  new URL('../../../../../../../../integ/fixtures/git/gaps.sh', import.meta.url),
)
const DEC = new TextDecoder()

const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))

let tmp: string
let repoPath: string
let ws: Workspace
let parser: ShellParser

function walk(root: string, base = root): string[] {
  const out: string[] = []
  for (const entry of readdirSync(root)) {
    const full = join(root, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full, base))
    else out.push(relative(base, full).split(sep).join('/'))
  }
  return out
}

async function run(line: string): Promise<[number, string, string]> {
  const result = await ws.shell(`git -C /repo ${line}`)
  return [result.exitCode, DEC.decode(result.stdout), DEC.decode(result.stderr)]
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'mirage-git-'))
  repoPath = join(tmp, 'repo')
  execFileSync('bash', [BUILDER, repoPath], { stdio: 'ignore' })

  const ram = new RAMVFS()
  parser = await createShellParser({ engineWasm, grammarWasm })
  ws = new Workspace({ '/repo': ram }, { mode: MountMode.WRITE, shellParser: parser })
  const dispatch: Dispatch = async (op, path, args = [], kwargs = {}) => [
    await ws.dispatch(op, path.virtual, args, kwargs),
    new IOResult(),
  ]
  for (const rel of walk(repoPath)) {
    const target = `/repo/${rel}`
    await ensureDir(dispatch, PathSpec.fromStrPath(target).parent)
    await ws.dispatch('write', target, [new Uint8Array(readFileSync(join(repoPath, rel)))])
  }
  ws.registerCli('git', GIT)
})

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

const NATIVE_ENV = {
  ...process.env,
  LC_ALL: 'C',
  LANG: 'C',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
}

/** What the real git binary prints for the same line, as the truth to match. */
function native(dir: string, form: string): [number | null, string, string] {
  const done = spawnSync('bash', ['-c', `git -C "$1" ${form}`, 'native-git', dir], {
    env: NATIVE_ENV,
    encoding: 'utf8',
  })
  return [done.status, done.stdout, done.stderr]
}

const forms = JSON.parse(readFileSync(BUILDER.replace('.sh', '.json'), 'utf8')) as string[]
it.each(forms)('matches native Git: %s', async (form) => {
  expect(await run(form)).toEqual(native(repoPath, form))
})

it.each(['ls-files', 'ls-files ..', "ls-files '*.txt'", 'ls-files ../f.c', 'ls-files -s ..'])(
  'lists the index from a subdirectory as native Git: %s',
  async (form) => {
    const result = await ws.shell(`cd /repo/docs && git ${form}`)
    expect([result.exitCode, DEC.decode(result.stdout), DEC.decode(result.stderr)]).toEqual(
      native(join(repoPath, 'docs'), form),
    )
  },
)

it('reads global config through virtual HOME without repository discovery', async () => {
  await ws.shell('mkdir -p /repo/home/.config/git')
  await ws.dispatch('write', '/repo/home/.config/git/config', [
    new TextEncoder().encode('[user]\nname = XDG Author\n'),
  ])
  await ws.dispatch('write', '/repo/home/.gitconfig', [
    new TextEncoder().encode('[user]\nname = Global Author\n'),
  ])
  let result = await ws.shell('HOME=/repo/home git config --global --list --show-origin')
  expect(result.exitCode).toBe(0)
  expect(DEC.decode(result.stdout)).toBe(
    'file:/repo/home/.config/git/config\tuser.name=XDG Author\nfile:/repo/home/.gitconfig\tuser.name=Global Author\n',
  )
  result = await ws.shell('HOME=/repo/home git config --global --get user.name')
  expect(DEC.decode(result.stdout)).toBe('Global Author\n')
  result = await ws.shell('HOME=/repo/missing git config --global --list')
  expect(result.exitCode).toBe(128)
  expect(DEC.decode(result.stderr)).toBe(
    "fatal: unable to read config file '/repo/missing/.gitconfig': No such file or directory\n",
  )
})

it('reports the virtual worktree root from a subdirectory', async () => {
  const result = await ws.shell('cd /repo/docs && git rev-parse --show-toplevel')
  expect(result.exitCode).toBe(0)
  expect(DEC.decode(result.stdout)).toBe('/repo\n')
})

it('prints the worktree root in line order among revisions', async () => {
  const head = DEC.decode((await ws.shell('git -C /repo rev-parse HEAD')).stdout)
  const result = await ws.shell('git -C /repo rev-parse HEAD --show-toplevel HEAD')
  expect(DEC.decode(result.stdout)).toBe(`${head}/repo\n${head}`)
})

it('matches native Git binary text patches, pickaxe and binary statistics', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mirage-git-text-'))
  const binaryWs = new Workspace(
    { '/repo': new RAMVFS() },
    { mode: MountMode.WRITE, shellParser: parser },
  )
  binaryWs.registerCli('git', GIT)
  const nativeGit = (args: string[], input?: string): string =>
    execFileSync(
      'git',
      ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args],
      { encoding: 'utf8', stdio: 'pipe', env: NATIVE_ENV, input },
    )
  try {
    nativeGit(['init', '-q', '-b', 'main'])
    for (const [content, message] of [
      [Buffer.from('old\0\xff\n', 'latin1'), 'binary one'],
      [Buffer.from('new\0\xfe\nneedle\n', 'latin1'), 'binary two'],
    ] as const) {
      writeFileSync(join(root, 'binary.dat'), content)
      nativeGit(['add', 'binary.dat'])
      nativeGit(['commit', '-qm', message])
    }
    writeFileSync(join(root, 'binary.dat'), Buffer.from('new\0\xfe\nneedle\nmerged\n', 'latin1'))
    nativeGit(['add', 'binary.dat'])
    const tree = nativeGit(['write-tree']).trim()
    const merge = nativeGit(
      ['commit-tree', tree, '-p', 'HEAD', '-p', 'HEAD~1'],
      'binary merge\n',
    ).trim()
    nativeGit(['update-ref', 'refs/heads/binary-merge', merge])
    nativeGit(['reset', '--hard', 'HEAD'])
    writeFileSync(join(root, 'binary.dat'), Buffer.from('new\0\xfe\nneedle\nsaved\n', 'latin1'))
    nativeGit(['stash', 'push', '-qm', 'binary stash'])
    const dispatch: Dispatch = async (op, path, args = [], kwargs = {}) => [
      await binaryWs.dispatch(op, path.virtual, args, kwargs),
      new IOResult(),
    ]
    for (const rel of walk(root)) {
      const target = `/repo/${rel}`
      await ensureDir(dispatch, PathSpec.fromStrPath(target).parent)
      await binaryWs.dispatch('write', target, [new Uint8Array(readFileSync(join(root, rel)))])
    }
    expect(nativeGit(['log', '-2', '--format=%s', '-G', 'needle'])).toBe('')
    expect(nativeGit(['log', '-2', '--format=%s', '-G', 'needle', '--text'])).toBe('binary two\n')
    for (const command of [
      'log -2 --format=%s -G needle',
      'log -2 --format=%s -G needle --text',
      'log -2 --format=%s -G needle -a',
      'log -2 --format=%s -S needle --text',
      'log -1 --format= -p --text',
      'log -1 --format= --numstat --text',
      'show --format= --text HEAD',
      'show --format= --stat -p --text HEAD',
      'diff HEAD~1 HEAD --text',
      'diff-tree --no-commit-id -r -p --text HEAD',
      'show --format= --cc --text binary-merge',
      'show --format= -c -a binary-merge',
      'show --format= -m --text binary-merge',
      'stash show -p --text',
    ]) {
      const actual = await binaryWs.shell(`git -C /repo ${command}`)
      const expected = spawnSync('bash', ['-c', `git ${command}`], { cwd: root, env: NATIVE_ENV })
      expect(
        [actual.exitCode, Buffer.from(actual.stdout), Buffer.from(actual.stderr)],
        command,
      ).toEqual([expected.status, expected.stdout, expected.stderr])
    }
  } finally {
    await binaryWs.close()
    rmSync(root, { recursive: true, force: true })
  }
})
