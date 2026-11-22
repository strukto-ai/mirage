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

async function freshConfig(): Promise<[Workspace, () => Promise<string>]> {
  const fresh = await mountRepo(repoPath)
  const read = async (): Promise<string> =>
    DEC.decode((await fresh.shell('cat /repo/.git/config')).stdout)
  return [fresh, read]
}

// git 2.47.3 on debian:stable-slim: a set rewrites the variable's line spelled
// as typed, --add goes after the block's last variable, a new block takes the
// name's case, and unset takes an emptied block with it.
it('writes config lines as git does', async () => {
  const [fresh, read] = await freshConfig()
  const original = await read()
  for (const form of [
    'user.email a@b',
    'user.Email c@d',
    '--add user.email e@f',
    'set user.phone 1',
    'unset user.phone',
    'remote.Origin.url X',
    "core.x ' lead'",
    "set sec.y 'a#b'",
    '--unset core.x',
    '--unset sec.y',
  ]) {
    const result = await fresh.shell(`git -C /repo config ${form}`)
    expect([form, result.exitCode, DEC.decode(result.stderr)]).toEqual([form, 0, ''])
  }
  expect(await read()).toBe(
    `${original}[user]\n\tEmail = c@d\n\temail = e@f\n[remote "Origin"]\n\turl = X\n`,
  )
  await fresh.close()
})

// git 2.47.3 on debian:stable-slim: a variable can share its header's line, a
// backslash continues a value only unescaped and outside a comment, only LF
// ends a line, a byte order mark stays, a carriage return is quoted, and a new
// name is placed in the older [section.sub] block without case but matched
// with it.
it.each([
  ['[user] email = old\n', 'user.email new', '[user]\n\temail = new\n'],
  ['[user] email = old\n\tname = x\n', '--unset user.email', '[user]\n\tname = x\n'],
  ['[core] bare\n[x]\n\ty = 1\n', '--unset core.bare', '[x]\n\ty = 1\n'],
  [
    '[core]\n\tpath = foo\\\\\n\tbare = false\n',
    'core.path bar',
    '[core]\n\tpath = bar\n\tbare = false\n',
  ],
  [
    '[core]\n\tpath = foo ; c\\\n\tbare = false\n',
    'core.path x',
    '[core]\n\tpath = x\n\tbare = false\n',
  ],
  [
    '[core]\n\tpath = foo\\\n bar\n\tbare = false\n',
    'core.path x',
    '[core]\n\tpath = x\n\tbare = false\n',
  ],
  ['[user]\n\tname = "a\rb"\n', 'user.name x', '[user]\n\tname = x\n'],
  ['﻿[user]\n\temail = old\n', '--unset user.email', '﻿\n'],
  ['', "a.b $'x\\r'", '[a]\n\tb = "x\r"\n'],
  ['[user.s]\n\temail = a\n', 'user.S.email x', '[user.s]\n\temail = a\n\temail = x\n'],
  ['[a.b "c"]\n\tx = old\n', 'a.b.c.x new', '[a.b "c"]\n\tx = new\n'],
  ['[a "b.c"]\n\tx = old\n', 'a.b.c.x new', '[a "b.c"]\n\tx = new\n'],
])('reads a config file as git does: %j %s', async (before, form, after) => {
  const fresh = await mountRepo(repoPath)
  await fresh.dispatch('write', '/repo/f', [new TextEncoder().encode(before)])
  const result = await fresh.shell(`git -C /repo config -f f ${form}`)
  expect([result.exitCode, DEC.decode(result.stderr)]).toEqual([0, ''])
  expect((await fresh.shell('cat /repo/f')).stdout).toEqual(new TextEncoder().encode(after))
  await fresh.close()
})

it.each([
  [
    '[user ]\n',
    '-f f user.email x',
    3,
    "error: invalid section name 'user'\nerror: invalid config file f\n",
  ],
  [
    '[user]\n\n\temail = "x\n',
    '-f f --unset user.email',
    128,
    'fatal: bad config line 3 in file f\n',
  ],
  ['[user]\n\tname = a\\q\n', '-f f user.email x', 128, 'fatal: bad config line 2 in file f\n'],
  ['[user]\n\tname = "a\\', '-f f user.email x', 128, 'fatal: bad config line 3 in file f\n'],
  [
    '',
    '-f missing/f a.b c',
    255,
    'error: could not lock config file missing/f: No such file or directory\n',
  ],
])('refuses to write a config file as git does: %j %s', async (before, form, code, err) => {
  const fresh = await mountRepo(repoPath)
  await fresh.dispatch('write', '/repo/f', [new TextEncoder().encode(before)])
  const result = await fresh.shell(`git -C /repo config ${form}`)
  expect([result.exitCode, DEC.decode(result.stderr)]).toEqual([code, err])
  expect(DEC.decode((await fresh.shell('cat /repo/f')).stdout)).toBe(before)
  expect((await fresh.shell('ls /repo/f.lock')).exitCode).toBe(2)
  expect((await fresh.shell('ls /repo/missing')).exitCode).toBe(2)
  await fresh.close()
})

it('keeps a raw byte from config set to get', async () => {
  const fresh = await mountRepo(repoPath)
  const result = await fresh.shell(
    "git -C /repo config -f f user.name $'a\\xffb'; git -C /repo config -f f --get user.name",
  )
  expect([result.exitCode, [...result.stdout]]).toEqual([0, [0x61, 0xff, 0x62, 0x0a]])
  await fresh.close()
})

// git 2.47.3: a lock already there is another writer's.
it('waits for no config lock', async () => {
  const [fresh, read] = await freshConfig()
  await fresh.dispatch('write', '/repo/.git/config.lock', [new Uint8Array()])
  const before = await read()
  const result = await fresh.shell('cd /repo && git config a.b c')
  expect([result.exitCode, DEC.decode(result.stderr)]).toEqual([
    255,
    'error: could not lock config file .git/config: File exists\n',
  ])
  expect(await read()).toBe(before)
  expect((await fresh.shell('ls /repo/.git/config.lock')).exitCode).toBe(0)
  await fresh.close()
})

it.each([
  [
    'user.email x',
    5,
    'warning: user.email has multiple values\n' +
      'error: cannot overwrite multiple values with a single value\n' +
      '       Use a regexp, --add or --replace-all to change user.email.\n',
  ],
  ['--unset user.email', 5, 'warning: user.email has multiple values\n'],
  ['--unset nope.key', 5, ''],
  ['foo bar', 2, 'error: key does not contain a section: foo\n'],
  ['a. c', 2, 'error: key does not contain variable name: a.\n'],
  ['a.1b c', 1, 'error: invalid key: a.1b\n'],
  ['--add --unset a.b c', 129, "error: options '--unset' and '--add' cannot be used together\n"],
  ['--unset --value=x user.email', 129, "error: unknown option `value=x'\nusage: "],
  ['--fixed-value user.email x', 129, "error: --fixed-value only applies with 'value-pattern'\n"],
  [
    'set --fixed-value user.email x',
    128,
    'fatal: --fixed-value only applies with --value=<pattern>\n',
  ],
  ["$'a.b\\nc.d' x", 1, 'error: invalid key (newline): a.b\nc.d\n'],
  ['--default=fb user.name Ada', 129, 'error: --default is only applicable to --get\n'],
  ['set --default=fb user.name Ada', 129, "error: unknown option `default=fb'\nusage: "],
  ['--file - a.b c', 128, 'fatal: writing to stdin is not supported\n'],
])('refuses config write %s as git does', async (form, code, err) => {
  const [fresh, read] = await freshConfig()
  for (const line of ['user.email a@b', '--add user.email c@d'])
    await fresh.shell(`git -C /repo config ${line}`)
  const before = await read()
  const result = await fresh.shell(`git -C /repo config ${form}`)
  expect(result.exitCode).toBe(code)
  expect(DEC.decode(result.stderr).startsWith(err)).toBe(true)
  expect(await read()).toBe(before)
  await fresh.close()
})

it.each([
  'user.name changed old',
  '--unset user.name old',
  '--bool core.bare yes',
  'rename-section core other',
  '--worktree x.y z',
])('refuses config writes mirage lacks: %s', async (form) => {
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

const AUTHOR_ENV = {
  ...NATIVE_ENV,
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
}

function nativeIn(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: AUTHOR_ENV, encoding: 'utf8' })
}

it('keeps a branch checked out in a main worktree whose git directory is not .git', async () => {
  const root = join(tmp, 'separate')
  const work = join(root, 'work')
  mkdirSync(join(root, 'meta'), { recursive: true })
  nativeIn(tmp, 'init', '-q', '-b', 'main', '--separate-git-dir', join(root, 'meta/repo'), work)
  nativeIn(work, 'commit', '-q', '--allow-empty', '-m', 'A')
  nativeIn(work, 'branch', 'trunk')
  nativeIn(work, 'branch', 'gone')
  for (const name of ['main', 'gone'])
    nativeIn(work, 'branch', '-q', '--set-upstream-to=trunk', name)
  nativeIn(work, 'worktree', 'add', '-q', '--relative-paths', '-b', 'o', '../wt')
  const tip = nativeIn(work, 'rev-parse', '--short', 'gone').trim()
  const result = await (
    await mountRepo(root)
  ).shell('git -C /repo/wt branch --dry-run --delete-merged trunk')
  expect([result.exitCode, DEC.decode(result.stdout)]).toEqual([
    0,
    `Would delete branch gone (was ${tip}).\n`,
  ])
})

it("takes a bare repository's HEAD as no checkout", async () => {
  const root = join(tmp, 'bare')
  const source = join(root, 'source')
  const bare = join(root, 'repo.git')
  mkdirSync(root, { recursive: true })
  nativeIn(root, 'init', '-q', '-b', 'main', source)
  nativeIn(source, 'commit', '-q', '--allow-empty', '-m', 'A')
  nativeIn(root, 'clone', '-q', '--bare', source, bare)
  nativeIn(bare, 'branch', 'trunk')
  nativeIn(bare, 'branch', '-q', '--set-upstream-to=trunk', 'main')
  nativeIn(bare, 'worktree', 'add', '-q', '--relative-paths', '-b', 'o', '../wt')
  const tip = nativeIn(bare, 'rev-parse', '--short', 'main').trim()
  const result = await (
    await mountRepo(root)
  ).shell('git -C /repo/wt branch --dry-run --delete-merged trunk')
  expect([result.exitCode, DEC.decode(result.stdout)]).toEqual([
    0,
    `Would delete branch main (was ${tip}).\n`,
  ])
})

it.each([
  ['repo.git', 'rev-parse --is-bare-repository --is-inside-work-tree --is-inside-git-dir'],
  ['repo.git', 'log --format=%s'],
  ['repo.git/refs', 'rev-parse --is-bare-repository'],
  ['repo.git', 'status'],
])('finds a bare repository from %s as git does: %s', async (dir, line) => {
  const root = join(tmp, 'bare-found')
  if (!statSync(root, { throwIfNoEntry: false })) {
    const source = join(root, 'source')
    mkdirSync(root, { recursive: true })
    nativeIn(root, 'init', '-q', '-b', 'main', source)
    nativeIn(source, 'commit', '-q', '--allow-empty', '-m', 'A')
    nativeIn(root, 'clone', '-q', '--bare', source, join(root, 'repo.git'))
    nativeIn(join(root, 'repo.git'), 'branch', 'trunk')
    rmSync(source, { recursive: true, force: true })
  }
  const native = spawnSync('git', line.split(' '), {
    cwd: join(root, dir),
    env: AUTHOR_ENV,
    encoding: 'utf8',
  })
  const result = await (await mountRepo(root)).shell(`git -C /repo/${dir} ${line}`)
  expect([result.exitCode, DEC.decode(result.stdout), DEC.decode(result.stderr)]).toEqual([
    native.status,
    native.stdout,
    native.stderr,
  ])
})
