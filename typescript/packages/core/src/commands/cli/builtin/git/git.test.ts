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
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { IOResult } from '../../../../io/types.ts'
import { OpsRegistry } from '../../../../ops/registry.ts'
import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import { createShellParser, type ShellParser } from '../../../../shell/parse/index.ts'
import { MountMode } from '../../../../types.ts'
import { Workspace } from '../../../../workspace/workspace/workspace.ts'
import { GIT } from './index.ts'
import * as gitFsModule from './fs.ts'
import { ensureDir } from './io.ts'
import type { Dispatch } from './types.ts'

const BUILDER = fileURLToPath(
  new URL('../../../../../../../../integ/fixtures/git/build.sh', import.meta.url),
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

/** What the real git binary prints for the same line, as the truth to match. */
function realGit(args: string[]): string {
  return execFileSync('git', ['-C', repoPath, ...args], { encoding: 'utf8' })
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
  const registry = new OpsRegistry()
  registry.registerVfs(ram)
  parser = await createShellParser({ engineWasm, grammarWasm })
  ws = new Workspace(
    { '/repo': ram },
    { mode: MountMode.WRITE, ops: registry, shellParser: parser },
  )
  const dispatch: Dispatch = async (op, path, args = [], kwargs = {}) => [
    await ws.dispatch(op, path.virtual, args, kwargs),
    new IOResult(),
  ]
  for (const rel of walk(repoPath)) {
    const target = `/repo/${rel}`
    await ensureDir(dispatch, target.slice(0, target.lastIndexOf('/')))
    await ws.dispatch('write', target, [new Uint8Array(readFileSync(join(repoPath, rel)))])
  }
  ws.registerCli('git', GIT)
})

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

it.each([
  'remote -v',
  'config --get user.name',
  'show-ref',
  'rev-list --all --count',
  'rev-list HEAD',
  'log -1 --date=iso --format=%ad',
  'log -1 --date=iso-strict --format=%ad',
  'log -1 --format=%aI%n%ai%n%cI%n%ci',
  'log -1 --pretty=raw',
  'log --oneline --decorate -2',
  'log --decorate -1',
  'branch -a -vv',
  'show --name-status --format= HEAD',
  'show --summary --format=%h HEAD~1',
  'diff-tree --no-commit-id --name-only -r HEAD',
  'diff-tree HEAD',
  'diff-tree -r HEAD',
])('read command matches native Git: %s', async (command) => {
  expect(await run(command)).toEqual([0, realGit(command.split(' ')), ''])
})

it.each([
  'rev-list --all --count',
  'log --all --format=%H',
  'show --stat --format=%s HEAD~1',
  'diff HEAD~2 HEAD~1',
])('reads each pack and index once per invocation: %s', async (command) => {
  const reads = new Map<string, number>()
  const original = gitFsModule.gitFs
  const spy = vi.spyOn(gitFsModule, 'gitFs').mockImplementation((dispatch, location) =>
    original((op, path, args, kwargs) => {
      if (op === 'read' && (path.virtual.endsWith('.pack') || path.virtual.endsWith('.idx'))) {
        reads.set(path.virtual, (reads.get(path.virtual) ?? 0) + 1)
      }
      return dispatch(op, path, args, kwargs)
    }, location),
  )
  try {
    for (let invocation = 0; invocation < 2; invocation++) {
      reads.clear()
      expect(await run(command)).toEqual([0, realGit(command.split(' ')), ''])
      expect([...reads.keys()].filter((path) => path.endsWith('.pack'))).toHaveLength(1)
      expect([...reads.keys()].filter((path) => path.endsWith('.idx'))).toHaveLength(1)
      expect([...reads.values()]).toEqual([1, 1])
    }
  } finally {
    spy.mockRestore()
  }
})

describe('git log', () => {
  it('matches the real binary byte for byte', async () => {
    const [code, out] = await run('log')
    expect(code).toBe(0)
    expect(out).toBe(realGit(['log']))
  })

  it('matches --oneline byte for byte', async () => {
    const [, out] = await run('log --oneline')
    expect(out).toBe(realGit(['log', '--oneline']))
  })

  it('honours -n', async () => {
    const [, out] = await run('log --oneline -n 2')
    expect(out).toBe(realGit(['log', '--oneline', '-n', '2']))
  })

  it('honours --reverse', async () => {
    const [, out] = await run('log --oneline --reverse')
    expect(out).toBe(realGit(['log', '--oneline', '--reverse']))
  })

  it('walks from a revision with ancestry suffixes', async () => {
    const [, out] = await run('log --oneline HEAD~2')
    expect(out).toBe(realGit(['log', '--oneline', 'HEAD~2']))
  })

  it.each([
    'log --oneline --max-count=2',
    'log --oneline --max-count 2',
    'log --oneline --grep=delta --grep first',
    'log --oneline --grep=ADD -i --max-count=2 --reverse',
    'log --oneline --all --regexp-ignore-case --grep=^ADD --author=INTEG',
  ])('matches native Git for the message and count limits: %s', async (command) => {
    expect(await run(command)).toEqual([0, realGit(command.split(' ')), ''])
  })

  it('finds the commit that introduced a string with the pickaxe', async () => {
    const [, out] = await run('log --oneline -S delta')
    expect(out).toBe(realGit(['log', '--oneline', '-S', 'delta']))
  })

  it('refuses an unknown revision the way git words it', async () => {
    const [code, , err] = await run('log nosuchref')
    expect(code).toBe(128)
    expect(err.startsWith("fatal: ambiguous argument 'nosuchref':")).toBe(true)
  })

  it('refuses an option this build lacks rather than reading it as a revision', async () => {
    const [code, , err] = await run('log --simplify-by-decoration')
    expect(code).toBe(128)
    expect(err).toBe('fatal: unrecognized argument: --simplify-by-decoration\n')
  })

  it('matches --all byte for byte, topic branch included', async () => {
    const [, out] = await run('log --all --oneline')
    expect(out).toBe(realGit(['log', '--all', '--oneline']))
  })

  it('matches --format placeholder output byte for byte', async () => {
    const template = '%H|%h|%T|%t|%P|%p|%an|%ae|%ad|%at|%cn|%cd|%ct|%s'
    const [, out] = await run(`log --format='${template}'`)
    expect(out).toBe(realGit(['log', `--format=${template}`]))
  })

  it('matches format: separator semantics byte for byte', async () => {
    const [, out] = await run("log --pretty='format:%h %s'")
    expect(out).toBe(realGit(['log', '--pretty=format:%h %s']))
  })

  it('matches %d decorations byte for byte', async () => {
    const [, out] = await run("log --all --format='%h%d'")
    expect(out).toBe(realGit(['log', '--all', '--format=%h%d']))
  })

  it('matches every block preset byte for byte', async () => {
    for (const preset of ['oneline', 'short', 'medium', 'full', 'fuller']) {
      const [, out] = await run(`log --pretty=${preset}`)
      expect(out, preset).toBe(realGit(['log', `--pretty=${preset}`]))
    }
  })

  it('treats a bare --pretty as medium', async () => {
    const [, bare] = await run('log --pretty')
    const [, medium] = await run('log')
    expect(bare).toBe(medium)
  })

  it('prints nothing at all for an empty format', async () => {
    const [code, out] = await run('log --format=')
    expect(code).toBe(0)
    expect(out).toBe('')
  })

  it('keeps unknown placeholders verbatim like git', async () => {
    const [, out] = await run("log -n 1 --format='%q %zz'")
    expect(out).toBe(realGit(['log', '-n', '1', '--format=%q %zz']))
  })

  it('refuses an invalid pretty name the way git words it', async () => {
    const [code, , err] = await run('log --pretty=bogus')
    expect(code).toBe(128)
    expect(err).toBe('fatal: invalid --pretty format: bogus\n')
  })

  it('says unsupported for a real preset this build lacks', async () => {
    const [code, , err] = await run('log --pretty=email')
    expect(code).toBe(128)
    expect(err).toContain('unsupported --pretty format: email')
  })

  it('keeps empty format entries as separators byte for byte', async () => {
    const [, out] = await run('log --pretty=format:')
    expect(out).toBe(realGit(['log', '--pretty=format:']))
  })

  it('terminates empty tformat entries byte for byte', async () => {
    const [, out] = await run("log --format='%d'")
    expect(out).toBe(realGit(['log', '--format=%d']))
  })

  it('emits %xHH as a raw byte, not UTF-8 of the code point', async () => {
    const result = await ws.shell("git -C /repo log -n 1 --format='a%x80b'")
    const real = execFileSync('git', ['-C', repoPath, 'log', '-n', '1', '--format=a%x80b'])
    expect(Array.from(result.stdout)).toEqual(Array.from(real))
  })

  it('refuses a bare --format the way git does', async () => {
    const [code, , err] = await run('log --format')
    expect(code).toBe(128)
    expect(err).toBe('fatal: unrecognized argument: --format\n')
  })
})

it('peels a tag to what it tags under cat-file <type> <object>', async () => {
  const result = await ws.shell(
    'cd /repo && git tag -a v1 -m release && git cat-file -t v1 && ' +
      'git cat-file commit v1 | git hash-object -t commit --stdin && ' +
      'git cat-file tree v1 | git hash-object -t tree --stdin; git tag -d v1 > /dev/null',
  )
  expect(DEC.decode(result.stdout)).toBe(`tag\n${realGit(['rev-parse', 'HEAD', 'HEAD^{tree}'])}`)
})

describe('git show', () => {
  it('matches the real binary on the header block', async () => {
    const [, out] = await run('show HEAD')
    const expected = realGit(['show', 'HEAD'])
    // Hunk bodies diverge from xdiff (see patch.ts); the header block does not.
    const upto = (text: string): string => text.slice(0, text.indexOf('diff --git'))
    expect(upto(out)).toBe(upto(expected))
  })

  it('names the changed file in its patch', async () => {
    const [, out] = await run('show HEAD')
    expect(out).toContain('diff --git a/numbers.txt b/numbers.txt')
    expect(out).toContain('+two')
  })

  it('matches --stat byte for byte', async () => {
    const [, out] = await run('show --stat HEAD')
    expect(out).toBe(realGit(['show', '--stat', 'HEAD']))
  })

  it('matches --name-only byte for byte', async () => {
    const [, out] = await run('show --name-only HEAD')
    expect(out).toBe(realGit(['show', '--name-only', 'HEAD']))
  })

  it('lets --name-only win over --stat like git', async () => {
    const [, out] = await run('show --stat --name-only HEAD')
    expect(out).toBe(realGit(['show', '--stat', '--name-only', 'HEAD']))
  })

  it('matches -s and --no-patch byte for byte', async () => {
    const [, dashed] = await run('show -s HEAD')
    expect(dashed).toBe(realGit(['show', '-s', 'HEAD']))
    const [, spelled] = await run('show --no-patch HEAD')
    expect(spelled).toBe(dashed)
  })

  it('suppresses the stat table under --no-patch like git', async () => {
    const [, out] = await run('show --stat --no-patch HEAD')
    expect(out).toBe(realGit(['show', '--stat', '--no-patch', 'HEAD']))
  })

  it('matches -s --format one-field output byte for byte', async () => {
    const [, out] = await run('show -s --format=%s HEAD')
    expect(out).toBe(realGit(['show', '-s', '--format=%s', 'HEAD']))
  })

  it('accepts --no-ext-diff without changing the output', async () => {
    const [code, flagged] = await run('show --no-ext-diff -s HEAD')
    const [, plain] = await run('show -s HEAD')
    expect(code).toBe(0)
    expect(flagged).toBe(plain)
  })

  it('refuses an option this build lacks', async () => {
    const [code, , err] = await run('show --word-diff HEAD')
    expect(code).toBe(128)
    expect(err).toBe('fatal: unrecognized argument: --word-diff\n')
  })

  it('prints a format: header with no trailing newline like git', async () => {
    const [, out] = await run("show -s --pretty='format:%h'")
    expect(out).toBe(realGit(['show', '-s', '--pretty=format:%h']))
    expect(out.endsWith('\n')).toBe(false)
  })

  it('terminates an empty tformat expansion byte for byte', async () => {
    const [, out] = await run("show -s --format='%b' HEAD~1")
    expect(out).toBe(realGit(['show', '-s', '--format=%b', 'HEAD~1']))
  })

  it('refuses a bare --format the way git does', async () => {
    const [code, , err] = await run('show --format HEAD')
    expect(code).toBe(128)
    expect(err).toBe('fatal: unrecognized argument: --format\n')
  })
})

describe('git diff', () => {
  it('renders a patch between two revisions', async () => {
    const [code, out] = await run('diff HEAD~1 HEAD')
    expect(code).toBe(0)
    expect(out).toContain('diff --git a/numbers.txt b/numbers.txt')
    expect(out).toContain('+two')
  })

  it('prints nothing with no operand', async () => {
    expect(await run('diff')).toEqual([0, '', ''])
  })
})

describe('git branch', () => {
  it('matches the real binary byte for byte', async () => {
    const [code, out] = await run('branch')
    expect(code).toBe(0)
    expect(out).toBe(realGit(['branch']))
  })

  it('creates a branch', async () => {
    expect(await run('branch shiny')).toEqual([0, '', ''])
    const [, out] = await run('branch')
    expect(out.split('\n')).toContain('  shiny')
  })

  it('refuses to create one that exists', async () => {
    await run('branch dupe')
    const [code, , err] = await run('branch dupe')
    expect(code).toBe(128)
    expect(err).toBe("fatal: a branch named 'dupe' already exists\n")
  })

  it('deletes a branch and says what it was', async () => {
    await run('branch doomed')
    const [code, out] = await run('branch -d doomed')
    expect(code).toBe(0)
    expect(out.startsWith('Deleted branch doomed (was ')).toBe(true)
  })

  it('refuses to delete the checked-out branch', async () => {
    const [code, , err] = await run('branch -d main')
    expect(code).toBe(1)
    expect(err).toBe("error: cannot delete branch 'main' used by worktree at '/repo'\n")
  })

  it('refuses an unknown branch', async () => {
    const [code, , err] = await run('branch -d nosuch')
    expect(code).toBe(1)
    expect(err).toBe("error: branch 'nosuch' not found\n")
  })
})

describe('the git root', () => {
  it('refuses an unknown verb', async () => {
    const result = await ws.shell('git nosuchverb')
    expect(result.exitCode).toBe(1)
    expect(DEC.decode(result.stderr)).toBe(
      "git: 'nosuchverb' is not a git command. See 'git --help'.\n",
    )
  })

  it('reports a directory that is not a repository', async () => {
    const result = await ws.shell('git -C / log')
    expect(result.exitCode).toBe(128)
    expect(DEC.decode(result.stderr)).toBe(
      'fatal: not a git repository (or any of the parent directories): .git\n',
    )
  })

  // git tells the two apart: a directory it could not enter is not the same
  // complaint as a directory holding no repository.
  it('reports a directory that is not there as a chdir failure', async () => {
    const result = await ws.shell('git -C /repo/nowhere log')
    expect(result.exitCode).toBe(128)
    expect(DEC.decode(result.stderr)).toBe(
      "fatal: cannot change to '/repo/nowhere': No such file or directory\n",
    )
  })

  // A file is a path git cannot enter, and saying so matters more than it
  // looks: discovery walks upwards, so tolerating it would run in the
  // repository above and let a write verb mutate one nobody named.
  it('reports a file operand as a chdir failure too', async () => {
    const result = await ws.shell('git -C /repo/letters.txt log')
    expect(result.exitCode).toBe(128)
    expect(DEC.decode(result.stderr)).toBe(
      "fatal: cannot change to '/repo/letters.txt': Not a directory\n",
    )
  })
})

it('matches native remote URLs and tracking branches', async () => {
  const original = readFileSync(join(repoPath, '.git/config'))
  try {
    realGit(['remote', 'add', 'origin', 'https://example.com/org/repo.git'])
    realGit(['remote', 'set-url', '--push', 'origin', 'ssh://git@example.com/org/repo.git'])
    realGit(['update-ref', 'refs/remotes/origin/main', 'HEAD~1'])
    realGit(['branch', '--set-upstream-to=origin/main', 'main'])
    const ram = new RAMVFS()
    const registry = new OpsRegistry()
    registry.registerVfs(ram)
    const remoteWs = new Workspace(
      { '/repo': ram },
      { mode: MountMode.WRITE, ops: registry, shellParser: parser },
    )
    const dispatch: Dispatch = async (op, path, args = [], kwargs = {}) => [
      await remoteWs.dispatch(op, path.virtual, args, kwargs),
      new IOResult(),
    ]
    for (const rel of walk(repoPath)) {
      const target = `/repo/${rel}`
      await ensureDir(dispatch, target.slice(0, target.lastIndexOf('/')))
      await remoteWs.dispatch('write', target, [new Uint8Array(readFileSync(join(repoPath, rel)))])
    }
    remoteWs.registerCli('git', GIT)
    for (const command of [
      'remote',
      'remote -v',
      'config --get remote.origin.url',
      'branch -a -vv',
      'branch -v',
    ]) {
      const result = await remoteWs.shell(`git -C /repo ${command}`)
      expect([result.exitCode, DEC.decode(result.stdout), DEC.decode(result.stderr)]).toEqual([
        0,
        realGit(command.split(' ')),
        '',
      ])
    }
  } finally {
    writeFileSync(join(repoPath, '.git/config'), original)
    realGit(['update-ref', '-d', 'refs/remotes/origin/main'])
  }
})
