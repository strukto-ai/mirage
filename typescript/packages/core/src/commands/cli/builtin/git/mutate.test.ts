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
import { ensureDir, readNames, readOptional } from './io.ts'
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
  tmp = mkdtempSync(join(tmpdir(), 'mirage-git-mutate-'))
})

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function walkDisk(root: string, base = root): string[] {
  const out: string[] = []
  for (const entry of readdirSync(root)) {
    const full = join(root, entry)
    if (statSync(full).isDirectory()) out.push(...walkDisk(full, base))
    else out.push(relative(base, full).split(sep).join('/'))
  }
  return out
}

/** Every file under a mounted directory, as repository-relative paths. */
async function walkMount(dispatch: Dispatch, root: string, base = root): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readNames(dispatch, root)) {
    const name = entry.replace(/\/+$/, '').split('/').pop() ?? ''
    if (name === '') continue
    const full = `${root}/${name}`
    const data = await readOptional(dispatch, full)
    if (data === null) out.push(...(await walkMount(dispatch, full, base)))
    else out.push(full.slice(base.length + 1))
  }
  return out
}

interface Harness {
  ws: Workspace
  dispatch: Dispatch
  repo: string
  run(line: string): Promise<[number, string, string]>
  /** Copy the mount back to disk so the real binary can read what mirage wrote. */
  drain(): Promise<string>
}

async function harness(): Promise<Harness> {
  const repo = mkdtempSync(join(tmp, 'repo-'))
  roots.push(repo)
  execFileSync('bash', [BUILDER, repo], { stdio: 'ignore' })

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
  for (const rel of walkDisk(repo)) {
    const target = `/repo/${rel}`
    await ensureDir(dispatch, target.slice(0, target.lastIndexOf('/')))
    await ws.dispatch('write', target, [new Uint8Array(readFileSync(join(repo, rel)))])
    await ws.dispatch('setattr', target, [], { mode: statSync(join(repo, rel)).mode })
  }
  ws.registerCli('git', GIT)

  return {
    ws,
    dispatch,
    repo,
    async run(line: string) {
      const result = await ws.execute(`git -C /repo ${line}`)
      return [result.exitCode, DEC.decode(result.stdout), DEC.decode(result.stderr)]
    },
    async drain() {
      // The real binary is the reader of record: a mutation that produced a
      // repository git itself cannot make sense of has not worked, however
      // plausible mirage's own status output looks.
      const out = mkdtempSync(join(tmp, 'drain-'))
      roots.push(out)
      for (const rel of await walkMount(dispatch, '/repo')) {
        const data = await readOptional(dispatch, `/repo/${rel}`)
        if (data === null) continue
        mkdirSync(dirname(join(out, rel)), { recursive: true })
        writeFileSync(join(out, rel), data)
      }
      return out
    },
  }
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
}

/** Write into the mount, which is where the verbs under test read from. */
async function write(h: Harness, path: string, text: string): Promise<void> {
  const target = `/repo/${path}`
  await ensureDir(h.dispatch, target.slice(0, target.lastIndexOf('/')))
  await h.ws.dispatch('write', target, [new TextEncoder().encode(text)])
}

/** Make a branch that holds one file main does not, then leave it. */
async function branchHolding(h: Harness, name: string, path: string, text: string): Promise<void> {
  await h.run(`checkout -b ${name}`)
  await write(h, path, text)
  await h.run('add -A')
  await h.run(`commit -m ${name}`)
  await h.run('checkout main')
}

describe('git add', () => {
  it('stages an edit, and the real binary agrees', async () => {
    const h = await harness()
    await write(h, 'letters.txt', 'edited\n')
    expect(await h.run('add -A')).toEqual([0, '', ''])
    expect(git(await h.drain(), ['status', '--porcelain'])).toBe('M  letters.txt\n')
  })

  it('stages a new file', async () => {
    const h = await harness()
    await write(h, 'fresh.txt', 'x\n')
    await h.run('add fresh.txt')
    expect(git(await h.drain(), ['status', '--porcelain'])).toBe('A  fresh.txt\n')
  })

  it('stages a deletion', async () => {
    const h = await harness()
    await h.ws.dispatch('unlink', '/repo/numbers.txt')
    await h.run('add -A')
    expect(git(await h.drain(), ['status', '--porcelain'])).toBe('D  numbers.txt\n')
  })

  it('refuses an ignored path named outright', async () => {
    const h = await harness()
    await write(h, '.gitignore', '*.log\n')
    await write(h, 'debug.log', 'x\n')
    const [code, , err] = await h.run('add debug.log')
    expect(code).toBe(1)
    expect(err.startsWith('The following paths are ignored by one of your .gitignore')).toBe(true)
  })

  it('stages an ignored path under -f', async () => {
    const h = await harness()
    await write(h, '.gitignore', '*.log\n')
    await write(h, 'debug.log', 'x\n')
    expect((await h.run('add -f debug.log'))[0]).toBe(0)
    expect(git(await h.drain(), ['status', '--porcelain'])).toContain('A  debug.log')
  })

  it('says what it did not do with no pathspec', async () => {
    const h = await harness()
    const [code, , err] = await h.run('add')
    expect(code).toBe(0)
    expect(err.startsWith('Nothing specified, nothing added.')).toBe(true)
  })

  it('under -u stages only what the pathspec covers', async () => {
    // Without the pathspec this restages every tracked file, which is how
    // an unrelated edit ends up in the next commit.
    const h = await harness()
    await write(h, 'letters.txt', 'edited\n')
    await write(h, 'docs/readme.md', 'edited\n')
    expect(await h.run('add -u docs')).toEqual([0, '', ''])
    const drained = await h.drain()
    expect(git(drained, ['diff', '--cached', '--name-only'])).toBe('docs/readme.md\n')
  })

  it('under -u stages a removal only under the pathspec', async () => {
    const h = await harness()
    await h.ws.dispatch('unlink', '/repo/letters.txt')
    await h.ws.dispatch('unlink', '/repo/docs/readme.md')
    await h.run('add -u docs')
    const drained = await h.drain()
    expect(git(drained, ['diff', '--cached', '--name-only'])).toBe('docs/readme.md\n')
  })

  it('under -u refuses a pathspec that names nothing', async () => {
    const h = await harness()
    const [code, , err] = await h.run('add -u nosuch')
    expect(code).toBe(128)
    expect(err).toBe("fatal: pathspec 'nosuch' did not match any files\n")
  })

  it('under -u refuses a pathspec that names only an untracked file', async () => {
    // It is there, so the pathspec is not the problem: -u restages what the
    // index holds, and the index has never heard of this one.
    const h = await harness()
    await write(h, 'fresh.txt', 'x\n')
    const [code, , err] = await h.run('add -u fresh.txt')
    expect(code).toBe(128)
    expect(err).toBe("error: pathspec 'fresh.txt' did not match any file(s) known to git\n")
  })

  it('refuses a pathspec that matches nothing', async () => {
    const h = await harness()
    const [code, , err] = await h.run('add nosuch.txt')
    expect(code).toBe(128)
    expect(err).toBe("fatal: pathspec 'nosuch.txt' did not match any files\n")
  })
})

describe('git reset', () => {
  it('unstages an edit but keeps it in the working tree', async () => {
    const h = await harness()
    await write(h, 'letters.txt', 'edited\n')
    await h.run('add -A')
    const [code, out] = await h.run('reset')
    expect(code).toBe(0)
    expect(out).toBe('Unstaged changes after reset:\nM\tletters.txt\n')
    const drained = await h.drain()
    expect(git(drained, ['status', '--porcelain'])).toBe(' M letters.txt\n')
    expect(readFileSync(join(drained, 'letters.txt'), 'utf8')).toBe('edited\n')
  })

  it('says nothing on a clean tree', async () => {
    const h = await harness()
    expect(await h.run('reset')).toEqual([0, '', ''])
  })

  it('turns a staged new file back into an untracked one', async () => {
    const h = await harness()
    await write(h, 'fresh.txt', 'x\n')
    await h.run('add -A')
    await h.run('reset')
    expect(git(await h.drain(), ['status', '--porcelain'])).toBe('?? fresh.txt\n')
  })

  it('unstages only the named path', async () => {
    const h = await harness()
    await write(h, 'letters.txt', 'edited\n')
    await write(h, 'numbers.txt', 'also edited\n')
    await h.run('add -A')
    await h.run('reset letters.txt')
    expect(git(await h.drain(), ['status', '--porcelain'])).toBe(' M letters.txt\nM  numbers.txt\n')
  })

  it('refuses a pathspec that matches nothing', async () => {
    // Selecting nothing used to unstage nothing and exit 0, which reads to a
    // script as "the index was reset".
    const h = await harness()
    const [code, , err] = await h.run('reset nosuch.txt')
    expect(code).toBe(128)
    expect(err).toBe(
      "fatal: ambiguous argument 'nosuch.txt': unknown revision or path not " +
        "in the working tree.\nUse '--' to separate paths from revisions, " +
        "like this:\n'git <command> [<revision>...] -- [<file>...]'\n",
    )
  })

  it('says which feature is missing for a revision operand', async () => {
    // Real git resets the index to the named commit. This build does not, and
    // "unknown revision" would be a lie about a revision it resolves.
    const h = await harness()
    const [code, , err] = await h.run('reset HEAD~1')
    expect(code).toBe(128)
    expect(err).toBe(
      "fatal: cannot reset to 'HEAD~1': this build resets the index from HEAD only\n",
    )
  })
})

describe('git commit', () => {
  it('records the index, and git reads the commit back', async () => {
    const h = await harness()
    await write(h, 'letters.txt', 'edited\n')
    await h.run('add -A')
    const [code, out] = await h.run("commit -m 'a change'")
    expect(code).toBe(0)
    expect(out).toMatch(/^\[main [0-9a-f]{7}] a change\n/)
    const drained = await h.drain()
    expect(git(drained, ['log', '--format=%s', '-1'])).toBe('a change\n')
    expect(git(drained, ['status', '--porcelain'])).toBe('')
  })

  it('reports the diffstat git reports', async () => {
    const h = await harness()
    await write(h, 'fresh.txt', 'one\ntwo\n')
    await h.run('add -A')
    const [, out] = await h.run("commit -m 'add fresh'")
    expect(out).toContain(' 1 file changed, 2 insertions(+)')
    expect(out).toContain(' create mode 100644 fresh.txt')
  })

  it('counts a binary file as changed but zero lines, like git', async () => {
    // Pinned against git 2.37: NUL in the first 8000 bytes makes the blob
    // binary, and binary blobs contribute files but never line counts.
    const h = await harness()
    await h.ws.dispatch('write', '/repo/blob.bin', [new Uint8Array([65, 0, 66, 0, 67])])
    await h.run('add -A')
    const [, out] = await h.run("commit -m 'add binary'")
    expect(out).toContain(' 1 file changed, 0 insertions(+), 0 deletions(-)')
    expect(out).toContain(' create mode 100644 blob.bin')
  })

  it('drops the deletions clause in a mixed text and binary commit', async () => {
    const h = await harness()
    await write(h, 'text.txt', 'x\ny\nz\n')
    await h.ws.dispatch('write', '/repo/blob.bin', [new Uint8Array([68, 0, 69])])
    await h.run('add -A')
    const [, out] = await h.run("commit -m 'mixed'")
    expect(out).toContain(' 2 files changed, 3 insertions(+)\n')
  })

  it('refuses without a message', async () => {
    const h = await harness()
    const [code, , err] = await h.run('commit')
    expect(code).toBe(128)
    expect(err).toBe('fatal: no commit message supplied (mirage has no editor to open; pass -m)\n')
  })

  it('prints the status report when there is nothing to commit', async () => {
    const h = await harness()
    const [code, out] = await h.run("commit -m 'nothing'")
    expect(code).toBe(1)
    expect(out).toBe('On branch main\nnothing to commit, working tree clean\n')
  })

  it('honours --author', async () => {
    const h = await harness()
    await write(h, 'fresh.txt', 'x\n')
    await h.run('add -A')
    await h.run("commit -m 'authored' --author 'Someone <someone@example.com>'")
    expect(git(await h.drain(), ['log', '--format=%an <%ae>', '-1'])).toBe(
      'Someone <someone@example.com>\n',
    )
  })

  it('commits a nested path so the tree nests', async () => {
    const h = await harness()
    await write(h, 'deep/inner/leaf.txt', 'x\n')
    await h.run('add -A')
    await h.run("commit -m 'nested'")
    const drained = await h.drain()
    expect(git(drained, ['ls-tree', '-r', '--name-only', 'HEAD'])).toContain('deep/inner/leaf.txt')
    expect(git(drained, ['status', '--porcelain'])).toBe('')
  })
})

describe('git checkout', () => {
  it('switches branches and moves the working tree', async () => {
    const h = await harness()
    const [code, , err] = await h.run('checkout topic')
    expect(code).toBe(0)
    expect(err).toBe("Switched to branch 'topic'\n")
    const drained = await h.drain()
    expect(git(drained, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('topic\n')
    expect(git(drained, ['status', '--porcelain'])).toBe('')
  })

  it('says so when already there', async () => {
    const h = await harness()
    expect((await h.run('checkout main'))[2]).toBe("Already on 'main'\n")
  })

  it('creates and switches in one step', async () => {
    const h = await harness()
    const [code, , err] = await h.run('checkout -b shiny')
    expect(code).toBe(0)
    expect(err).toBe("Switched to a new branch 'shiny'\n")
    expect(git(await h.drain(), ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('shiny\n')
  })

  it('refuses to create one that exists', async () => {
    const h = await harness()
    const [code, , err] = await h.run('checkout -b topic')
    expect(code).toBe(128)
    expect(err).toBe("fatal: a branch named 'topic' already exists\n")
  })

  it('refuses an unknown target', async () => {
    const h = await harness()
    const [code, , err] = await h.run('checkout nosuchthing')
    expect(code).toBe(1)
    expect(err).toBe("error: pathspec 'nosuchthing' did not match any file(s) known to git\n")
  })

  it('creates at a start point when one is given', async () => {
    // The operand is the whole point of the form: without it every commit
    // after the switch lands on the wrong history.
    const h = await harness()
    const older = git(h.repo, ['rev-parse', 'HEAD~1']).trim()
    const [code, , err] = await h.run('checkout -b older HEAD~1')
    expect(code).toBe(0)
    expect(err).toBe("Switched to a new branch 'older'\n")
    expect(git(await h.drain(), ['rev-parse', 'older']).trim()).toBe(older)
  })

  it('creates at HEAD when no start point is given', async () => {
    const h = await harness()
    const head = git(h.repo, ['rev-parse', 'HEAD']).trim()
    expect((await h.run('checkout -b shiny'))[0]).toBe(0)
    expect(git(await h.drain(), ['rev-parse', 'shiny']).trim()).toBe(head)
  })

  it('refuses a start point that is not a commit', async () => {
    const h = await harness()
    const [code, , err] = await h.run('checkout -b shiny nosuchrev')
    expect(code).toBe(128)
    expect(err).toBe(
      "fatal: 'nosuchrev' is not a commit and a branch 'shiny' cannot be created from it\n",
    )
  })

  it('refuses a switch that would overwrite an edit', async () => {
    const h = await harness()
    // topic is HEAD~1, where numbers.txt reads differently.
    await write(h, 'numbers.txt', 'precious\n')
    const [code, , err] = await h.run('checkout topic')
    expect(code).toBe(1)
    expect(err).toContain('would be overwritten by checkout')
    expect(err).toContain('\tnumbers.txt')
    const drained = await h.drain()
    // The point of the refusal: the edit is still there.
    expect(readFileSync(join(drained, 'numbers.txt'), 'utf8')).toBe('precious\n')
    expect(git(drained, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main\n')
  })

  it('carries an edit to a file both branches agree on', async () => {
    const h = await harness()
    await write(h, 'letters.txt', 'carried\n')
    const [code, out] = await h.run('checkout topic')
    expect(code).toBe(0)
    expect(out).toBe('M\tletters.txt\n')
    expect(readFileSync(join(await h.drain(), 'letters.txt'), 'utf8')).toBe('carried\n')
  })

  it('detaches HEAD onto a commit', async () => {
    const h = await harness()
    const older = git(h.repo, ['rev-parse', 'HEAD~1']).trim()
    const [code, , err] = await h.run(`checkout ${older.slice(0, 7)}`)
    expect(code).toBe(0)
    expect(err).toContain('detached HEAD')
    const drained = await h.drain()
    expect(git(drained, ['rev-parse', 'HEAD']).trim()).toBe(older)
    // The reflog is what makes `git branch` say where it detached from rather
    // than "(no branch)".
    expect(git(drained, ['branch'])).toContain('detached at')
  })

  it('leaves an untracked file alone', async () => {
    const h = await harness()
    await write(h, 'mine.txt', 'untracked\n')
    expect((await h.run('checkout topic'))[0]).toBe(0)
    expect(readFileSync(join(await h.drain(), 'mine.txt'), 'utf8')).toBe('untracked\n')
  })

  it('refuses a switch that would overwrite an untracked file', async () => {
    // The dangerous one: the file is in no index and no tree, so the tracked
    // comparison cannot see it, and writing the branch's blob over it
    // destroys the only copy there is.
    const h = await harness()
    await branchHolding(h, 'side', 'fresh.txt', 'branch\n')
    await write(h, 'fresh.txt', 'mine\n')
    const [code, , err] = await h.run('checkout side')
    expect(code).toBe(1)
    expect(err).toBe(
      'error: The following untracked working tree files would be overwritten ' +
        'by checkout:\n\tfresh.txt\nPlease move or remove them before you ' +
        'switch branches.\nAborting\n',
    )
    const drained = await h.drain()
    expect(readFileSync(join(drained, 'fresh.txt'), 'utf8')).toBe('mine\n')
    expect(git(drained, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main\n')
  })

  it('names the untracked file inside a wholly untracked directory', async () => {
    // Status collapses such a directory to one `dir/` row, and a collision
    // has to be decided per file. git names the file.
    const h = await harness()
    await branchHolding(h, 'side', 'nd/file.txt', 'branch\n')
    await write(h, 'nd/file.txt', 'mine\n')
    await write(h, 'nd/other.txt', 'also\n')
    const [code, , err] = await h.run('checkout side')
    expect(code).toBe(1)
    expect(err).toContain('\tnd/file.txt')
    expect(readFileSync(join(await h.drain(), 'nd/file.txt'), 'utf8')).toBe('mine\n')
  })

  it('overwrites an ignored file without a word', async () => {
    // git's own split: an ignored file is not work the caller is keeping.
    const h = await harness()
    await h.run('checkout -b side')
    await write(h, 'ig.txt', 'branch\n')
    await h.run('add -f ig.txt')
    await h.run('commit -m ignored')
    await h.run('checkout main')
    await write(h, '.gitignore', 'ig.txt\n')
    await write(h, 'ig.txt', 'mine\n')
    expect((await h.run('checkout side'))[0]).toBe(0)
    expect(readFileSync(join(await h.drain(), 'ig.txt'), 'utf8')).toBe('branch\n')
  })

  it('reports both kinds of conflict before one abort', async () => {
    const h = await harness()
    await h.run('checkout -b side')
    await write(h, 'letters.txt', 'onthebranch\n')
    await write(h, 'fresh.txt', 'branch\n')
    await h.run('add -A')
    await h.run('commit -m both')
    await h.run('checkout main')
    await write(h, 'letters.txt', 'precious\n')
    await write(h, 'fresh.txt', 'mine\n')
    const [code, , err] = await h.run('checkout side')
    expect(code).toBe(1)
    expect(err).toBe(
      'error: Your local changes to the following files would be overwritten ' +
        'by checkout:\n\tletters.txt\nPlease commit your changes or stash them ' +
        'before you switch branches.\n' +
        'error: The following untracked working tree files would be overwritten ' +
        'by checkout:\n\tfresh.txt\nPlease move or remove them before you ' +
        'switch branches.\nAborting\n',
    )
  })
})

describe('git branch -d', () => {
  it('refuses a branch HEAD does not contain', async () => {
    // The branch name is the only thing pointing at that commit, so -d
    // would be the command that loses it.
    const h = await harness()
    await branchHolding(h, 'side', 'fresh.txt', 'branch\n')
    const [code, out, err] = await h.run('branch -d side')
    expect(code).toBe(1)
    expect(out).toBe('')
    expect(err).toBe(
      "error: the branch 'side' is not fully merged\nhint: If you are sure " +
        "you want to delete it, run 'git branch -D side'\n",
    )
    expect(git(await h.drain(), ['branch'])).toContain('side')
  })

  it('deletes it under -D', async () => {
    const h = await harness()
    await branchHolding(h, 'side', 'fresh.txt', 'branch\n')
    const [code, out] = await h.run('branch -D side')
    expect(code).toBe(0)
    expect(out.startsWith('Deleted branch side (was ')).toBe(true)
    expect(git(await h.drain(), ['branch'])).not.toContain('side')
  })

  it('allows a branch behind HEAD', async () => {
    // Merged does not mean equal: an ancestor of HEAD is contained in it,
    // so nothing is lost by dropping the name. `topic` is HEAD~1.
    const h = await harness()
    const [code, out] = await h.run('branch -d topic')
    expect(code).toBe(0)
    expect(out.startsWith('Deleted branch topic (was ')).toBe(true)
  })
})

describe('a full round trip', () => {
  it('edits, stages, commits and switches, with git agreeing at the end', async () => {
    const h = await harness()
    await write(h, 'letters.txt', 'alpha\nbeta\ngamma\ndelta\nepsilon\n')
    await write(h, 'notes/todo.md', '- one\n')
    await h.run('add -A')
    await h.run("commit -m 'work in progress'")
    await h.run('checkout -b feature')
    await write(h, 'notes/todo.md', '- one\n- two\n')
    await h.run('add -A')
    await h.run("commit -m 'more notes'")
    const drained = await h.drain()
    expect(git(drained, ['log', '--format=%s'])).toBe(
      [
        'more notes',
        'work in progress',
        'add two',
        'add docs',
        'add delta',
        'first commit',
        '',
      ].join('\n'),
    )
    expect(git(drained, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('feature\n')
    expect(git(drained, ['status', '--porcelain'])).toBe('')
    expect(git(drained, ['fsck', '--no-progress'])).toBe('')
  })
})

describe('the fixture repository', () => {
  it('is left byte-identical when nothing is asked of it', async () => {
    // A read-only verb must not rewrite anything: an index touched on the way
    // past would make every later comparison meaningless.
    const h = await harness()
    await h.run('status')
    await h.run('log --oneline')
    const drained = await h.drain()
    for (const rel of walkDisk(h.repo)) {
      expect([rel, readFileSync(join(drained, rel))]).toEqual([
        rel,
        readFileSync(join(h.repo, rel)),
      ])
    }
  })
})
