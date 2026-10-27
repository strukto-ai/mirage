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
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, it } from 'vitest'

import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import { MountMode, PathSpec } from '../../../../types.ts'
import { Workspace } from '../../../../workspace/workspace/workspace.ts'
import { GIT } from './index.ts'
import { ensureDir } from './io.ts'

const BUILDER = fileURLToPath(
  new URL('../../../../../../../../integ/fixtures/git/gaps.sh', import.meta.url),
)
const DEC = new TextDecoder()

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

async function run(line: string): Promise<[number, string, string]> {
  const result = await ws.shell(`git -C /repo ${line}`)
  return [result.exitCode, DEC.decode(result.stdout), DEC.decode(result.stderr)]
}

async function mountRepo(path: string): Promise<Workspace> {
  const mounted = new Workspace({ '/repo': new RAMVFS() }, { mode: MountMode.WRITE })
  const dispatch = mounted.vfs
  for (const rel of walk(path)) {
    const target = `/repo/${rel}`
    await ensureDir(dispatch, PathSpec.fromStrPath(target).parent)
    await mounted.dispatch('write', target, [new Uint8Array(readFileSync(join(path, rel)))])
  }
  mounted.registerCli('git', GIT)
  return mounted
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'mirage-git-'))
  repoPath = join(tmp, 'repo')
  execFileSync('bash', [BUILDER, repoPath], { stdio: 'ignore' })

  ws = await mountRepo(repoPath)
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

it.each([
  'user.email changed@example.com',
  "user.name ''",
  '--global user.email changed@example.com',
  'user.name changed old',
])('refuses config writes explicitly: %s', async (form) => {
  const before = await ws.dispatch('read', '/repo/.git/config')
  const [code, out, err] = await run(`config ${form}`)
  expect(code).toBe(1)
  expect(out).toBe('')
  expect(err).toContain('git config is read-only in Mirage')
  expect(await ws.dispatch('read', '/repo/.git/config')).toEqual(before)
})

it('matches native merge-base on criss-cross, unrelated, multi-tip and clock-skewed graphs', async () => {
  const graphPath = join(tmp, 'graphs')
  const builder = BUILDER.replace('gaps.sh', 'merge-base.sh')
  execFileSync('bash', [builder, graphPath], { env: NATIVE_ENV, stdio: 'ignore' })
  const graph = await mountRepo(graphPath)
  const forms = JSON.parse(readFileSync(builder.replace('.sh', '.json'), 'utf8')) as string[]
  for (const form of forms) {
    const result = await graph.shell(`git -C /repo ${form}`)
    expect([result.exitCode, DEC.decode(result.stdout), DEC.decode(result.stderr)], form).toEqual(
      native(graphPath, form),
    )
  }
}, 60_000)

it('lists branches as native git does: markers, tracking, worktrees and widths', async () => {
  const listingPath = join(tmp, 'branches')
  const builder = BUILDER.replace('gaps.sh', 'branch.sh')
  execFileSync('bash', [builder, listingPath], { env: NATIVE_ENV, stdio: 'ignore' })
  const listing = await mountRepo(listingPath)
  const forms = JSON.parse(readFileSync(builder.replace('.sh', '.json'), 'utf8')) as string[]
  for (const form of forms) {
    const result = await listing.shell(`git -C /repo ${form}`)
    expect([result.exitCode, DEC.decode(result.stdout), DEC.decode(result.stderr)], form).toEqual(
      native(listingPath, form),
    )
  }
}, 60_000)

it('takes -h as help only when it is the verb’s one word', async () => {
  for (const verb of ['rev-parse', 'rev-list']) {
    const [code, out] = await run(`${verb} -h`)
    expect(code, verb).toBe(0)
    expect(out.startsWith(`usage: git ${verb}`), verb).toBe(true)
    const [repeatedCode, repeatedOut] = await run(`${verb} HEAD ${verb} -h`)
    expect(repeatedCode, verb).not.toBe(0)
    expect(repeatedOut.includes('usage:'), verb).toBe(false)
  }
})

it('keeps a branch checked out in a main worktree whose git directory is not .git', async () => {
  const root = join(tmp, 'separate')
  const env = {
    ...NATIVE_ENV,
    GIT_AUTHOR_NAME: 'Ada',
    GIT_AUTHOR_EMAIL: 'ada@example.com',
    GIT_COMMITTER_NAME: 'Ada',
    GIT_COMMITTER_EMAIL: 'ada@example.com',
  }
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, env, encoding: 'utf8' })
  mkdirSync(join(root, 'meta'), { recursive: true })
  git(
    tmp,
    'init',
    '-q',
    '-b',
    'main',
    '--separate-git-dir',
    join(root, 'meta/repo'),
    join(root, 'work'),
  )
  const work = join(root, 'work')
  git(work, 'commit', '-q', '--allow-empty', '-m', 'A')
  git(work, 'branch', 'trunk')
  git(work, 'branch', 'gone')
  for (const name of ['main', 'gone']) git(work, 'branch', '-q', '--set-upstream-to=trunk', name)
  git(work, 'worktree', 'add', '-q', '--relative-paths', '-b', 'other', '../wt')
  const tip = git(work, 'rev-parse', '--short', 'gone').trim()
  const mounted = await mountRepo(root)
  const result = await mounted.shell('git -C /repo/wt branch --dry-run --delete-merged trunk')
  expect([result.exitCode, DEC.decode(result.stdout)]).toEqual([
    0,
    `Would delete branch gone (was ${tip}).\n`,
  ])
})
