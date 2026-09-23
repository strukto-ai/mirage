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

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { OpsRegistry } from '../ops/registry.ts'
import { RAMVFS } from '../vfs/ram/ram.ts'
import { createShellParser, type ShellParser } from '../shell/parse/index.ts'
import { rstripSlash } from '../utils/slash.ts'
import { FileStat, FileType, MountMode } from '../types.ts'
import type { Action, OpsContext } from '../policy/index.ts'
import { applyStateDict, toStateDict } from './snapshot/state.ts'
import { Workspace } from './workspace/workspace.ts'

const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))

let parser: ShellParser
let tempDir: string

beforeAll(async () => {
  parser = await createShellParser({ engineWasm, grammarWasm })
  tempDir = mkdtempSync(join(tmpdir(), 'mirage-symlinks-'))
})

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

function buildWorkspace(): Workspace {
  const ram = new RAMVFS()
  const ops = new OpsRegistry()
  ops.registerVfs(ram)
  return new Workspace({ '/data': ram }, { mode: MountMode.WRITE, ops, shellParser: parser })
}

const dec = (b: Uint8Array | null): string => (b === null ? '' : new TextDecoder().decode(b))

describe('symlinks (namespace-backed)', () => {
  it.each([
    ['stat -c %F', '/data/virtual'],
    ['stat -c %F', '/data/virtual/deep'],
    ['stat -L -c %F', '/data/virtual'],
    ['stat -L -c %F', '/data/virtual/deep'],
    ['file -b', '/data/virtual'],
    ['file -b', '/data/virtual/deep'],
  ])('%s reports link-only namespace directory %s', async (command, path) => {
    const ws = buildWorkspace()
    await ws.namespace.symlink('/data/virtual/deep/link', '/data/target', 0)
    const result = await ws.shell(`${command} ${path}`)
    expect(result.exitCode).toBe(0)
    expect(dec(result.stdout)).toBe('directory\n')
    await ws.close()
  })

  it('ln -s then readlink returns the target verbatim', async () => {
    const ws = buildWorkspace()
    await ws.shell('echo hi > /data/a.txt')
    const r1 = await ws.shell('ln -s /data/a.txt /data/link.txt')
    expect(r1.exitCode).toBe(0)
    const r2 = await ws.shell('readlink /data/link.txt')
    expect(dec(r2.stdout)).toBe('/data/a.txt\n')
    await ws.close()
  })

  it('keeps a relative target verbatim', async () => {
    const ws = buildWorkspace()
    await ws.shell('echo hi > /data/a.txt')
    await ws.shell('ln -s a.txt /data/link.txt')
    const r = await ws.shell('readlink /data/link.txt')
    expect(dec(r.stdout)).toBe('a.txt\n')
    await ws.close()
  })

  it('ln -s -f overwrites an existing link', async () => {
    const ws = buildWorkspace()
    await ws.shell('echo a > /data/a.txt')
    await ws.shell('echo b > /data/b.txt')
    await ws.shell('ln -s /data/a.txt /data/link.txt')
    await ws.shell('ln -s -f /data/b.txt /data/link.txt')
    const r = await ws.shell('readlink /data/link.txt')
    expect(dec(r.stdout)).toBe('/data/b.txt\n')
    await ws.close()
  })

  it('ln -s refuses a name a file already holds', async () => {
    // GNU refuses an occupied destination; the node table alone cannot
    // see one. ln checked only its own table, so the link node landed on
    // top of a live file: the bytes stayed in the backend, unreachable,
    // and the name read as a dangling link.
    const ws = buildWorkspace()
    await ws.shell('echo hi > /data/a.txt')
    const r = await ws.shell('ln -s /data/other /data/a.txt')
    expect(r.exitCode).toBe(1)
    expect(dec(r.stderr)).toBe("ln: failed to create symbolic link '/data/a.txt': File exists\n")
    expect(dec((await ws.shell('cat /data/a.txt')).stdout)).toBe('hi\n')
    await ws.close()
  })

  it('ln into a synthesized tree is not an occupied name', async () => {
    // A directory an API tree invents is not evidence the name is taken.
    // Those trees answer for a path nobody created: a postgres schema
    // directory lists tables/ and views/ before anything asks whether
    // the schema is there, and a grouping mount stats every path under a
    // live collection as a directory. Refusing on either reading denied
    // the ordinary case of adding a link inside a mounted tree.
    const ram = new RAMVFS()
    const ops = new OpsRegistry()
    ops.registerVfs(ram)
    const real = ops.call.bind(ops)
    ops.call = async (name, kind, accessor, path, args, kwargs) => {
      if (name === 'stat') {
        return new FileStat({
          name: rstripSlash(path.virtual).split('/').pop() ?? '/',
          type: FileType.DIRECTORY,
        })
      }
      if (name === 'readdir') return ['tables', 'views']
      return real(name, kind, accessor, path, args, kwargs)
    }
    const ws = new Workspace({ '/data': ram }, { mode: MountMode.WRITE, ops, shellParser: parser })
    const r = await ws.shell('ln -s /data/x /data/meta_link')
    expect(r.exitCode).toBe(0)
    expect(dec(r.stderr)).toBe('')
    ops.call = real
    expect(dec((await ws.shell('readlink /data/meta_link')).stdout)).toBe('/data/x\n')
    await ws.close()
  })

  it('ln -sf replaces a regular file', async () => {
    // GNU -f removes the destination and then links, so it replaces a
    // regular file and not only a link (pinned against coreutils 9.7).
    const ws = buildWorkspace()
    await ws.shell('echo hi > /data/a.txt')
    await ws.shell('echo t > /data/t.txt')
    const r = await ws.shell('ln -sf /data/t.txt /data/a.txt')
    expect(r.exitCode).toBe(0)
    expect(dec((await ws.shell('readlink /data/a.txt')).stdout)).toBe('/data/t.txt\n')
    expect(dec((await ws.shell('cat /data/a.txt')).stdout)).toBe('t\n')
    await ws.close()
  })

  it('mv of a link passes the admission gate', async () => {
    // The link rename is the door's, so a policy that denies it wins. mv
    // used to move the node itself, which made it the one write in the
    // shell no admission policy could see.
    const ram = new RAMVFS()
    const ops = new OpsRegistry()
    ops.registerVfs(ram)
    const ws = new Workspace(
      { '/data': ram },
      {
        mode: MountMode.WRITE,
        ops,
        shellParser: parser,
        policies: [
          {
            preOps: (ctx: OpsContext): Action | null =>
              ctx.op === 'rename' ? { kind: 'deny', reason: 'frozen' } : null,
          },
        ],
      },
    )
    await ws.shell('echo hi > /data/a.txt')
    await ws.shell('ln -s /data/a.txt /data/lk')
    const r = await ws.shell('mv /data/lk /data/lk2')
    expect(r.exitCode).toBe(1)
    expect(dec(r.stderr)).toBe("mv: cannot move '/data/lk' to '/data/lk2': Permission denied\n")
    expect(dec((await ws.shell('readlink /data/lk')).stdout)).toBe('/data/a.txt\n')
    await ws.close()
  })

  it('ln -s without -f refuses an existing link', async () => {
    const ws = buildWorkspace()
    await ws.shell('echo a > /data/a.txt')
    await ws.shell('ln -s /data/a.txt /data/link.txt')
    const r = await ws.shell('ln -s /data/a.txt /data/link.txt')
    expect(r.exitCode).toBe(1)
    expect(dec(r.stderr)).toContain('File exists')
    await ws.close()
  })

  it('ln -sr stores the target relative to the link directory', async () => {
    const ws = buildWorkspace()
    await ws.shell('mkdir -p /data/a /data/b')
    await ws.shell('echo hi > /data/a/f.txt')
    const r1 = await ws.shell('ln -sr /data/a/f.txt /data/b/link')
    expect(r1.exitCode).toBe(0)
    expect(dec((await ws.shell('readlink /data/b/link')).stdout)).toBe('../a/f.txt\n')
    // the relative link resolves back to the file
    expect(dec((await ws.shell('cat /data/b/link')).stdout)).toBe('hi\n')
    await ws.close()
  })

  it('ln -srv reports the relative link', async () => {
    const ws = buildWorkspace()
    await ws.shell('mkdir -p /data/a /data/b')
    await ws.shell('echo hi > /data/a/f.txt')
    const r = await ws.shell('ln -srv /data/a/f.txt /data/b/link')
    expect(dec(r.stdout)).toBe("'/data/b/link' -> '../a/f.txt'\n")
    await ws.close()
  })

  it('ln -sn and -sT are accepted no-ops that still create the link', async () => {
    const ws = buildWorkspace()
    await ws.shell('echo hi > /data/a.txt')
    expect((await ws.shell('ln -sn /data/a.txt /data/l1')).exitCode).toBe(0)
    expect((await ws.shell('ln -sT /data/a.txt /data/l2')).exitCode).toBe(0)
    expect(dec((await ws.shell('readlink /data/l1')).stdout)).toBe('/data/a.txt\n')
    await ws.close()
  })

  // GNU bash 5.2: `cd /data/slink && pwd` prints the link, not the
  // target. The logical name is what the shell reports and what the next
  // `cd ..` acts on; `pwd -P` is how you ask for the target.
  it('cd through a symlink keeps the name it was given', async () => {
    const ws = buildWorkspace()
    await ws.shell('mkdir -p /data/real')
    await ws.shell('ln -s /data/real /data/slink')
    expect(dec((await ws.shell('cd /data/slink && pwd')).stdout)).toBe('/data/slink\n')
    expect(dec((await ws.shell('cd /data/slink && pwd -P')).stdout)).toBe('/data/real\n')
    await ws.close()
  })

  // Every row pinned in GNU bash 5.2 (debian:stable-slim) against the
  // same fixture: /data/deep/real/sub, /data/lk -> /data/deep/real. The
  // shell keeps two names for the cwd -- the logical one you typed and
  // the physical one it resolves to -- and each row says which one a
  // given surface reports. Mirrors LOGICAL_CWD_ROWS in the Python
  // tests/workspace/test_symlinks.py.
  const logicalCwdRows: [string, string][] = [
    ['cd /data/lk && pwd', '/data/lk\n'],
    ['cd /data/lk && pwd -L', '/data/lk\n'],
    ['cd /data/lk && pwd -P', '/data/deep/real\n'],
    ['cd /data/lk && echo "$PWD"', '/data/lk\n'],
    // Last flag wins, exactly as `cd -L -P` does.
    ['cd /data/lk && pwd -L -P', '/data/deep/real\n'],
    ['cd /data/lk && pwd -P -L', '/data/lk\n'],
    // A relative operand joins the logical name under -L, the physical
    // one under -P. This is the row where the two disagree about which
    // directory you end up in, not just how it is spelled.
    ['cd /data/lk && cd .. && pwd', '/data\n'],
    ['cd /data/lk && cd -P .. && pwd', '/data/deep\n'],
    ['cd /data/lk && cd sub && pwd', '/data/lk/sub\n'],
    ['cd /data/lk && cd -P sub && pwd', '/data/deep/real/sub\n'],
    // -P collapses the pair, so it re-spells the cwd without moving.
    ['cd /data/lk && cd -P . && pwd', '/data/deep/real\n'],
    ['cd -P /data/lk && pwd', '/data/deep/real\n'],
    // $OLDPWD stores the logical name, so `cd -` returns to that spelling.
    ['cd /data/lk && cd /data && echo "$OLDPWD"', '/data/lk\n'],
    ['cd /data/lk && cd /data && cd -', '/data/lk\n'],
    // Everything that is not a shell builtin stays physical, the way a
    // real child process does: bash's own `ls ..` lists /data/deep here.
    ['cd /data/lk && ls ..', 'real\n'],
    // -P announces the path as selected and lands on the target: the
    // printed name and the resulting cwd deliberately disagree.
    ['cd /data/lk && cd /data && cd -P -', '/data/lk\n'],
    ['cd /data/lk && cd /data && cd -P - && pwd', '/data/lk\n/data/deep/real\n'],
    // `set -P` is the session-wide -P, and GNU applies it to `cd` and
    // `pwd` alike. With no logical name ever recorded, `pwd -L` has
    // nothing else to report.
    ['set -P; cd /data/lk; pwd', '/data/deep/real\n'],
    ['set -P; cd /data/lk; pwd -L', '/data/deep/real\n'],
    ['set -P; cd /data/lk; echo "$PWD"', '/data/deep/real\n'],
    ['set -o physical; cd /data/lk; pwd', '/data/deep/real\n'],
    ['set -P; set +P; cd /data/lk; pwd', '/data/lk\n'],
    // A relative operand follows the session mode too.
    ['set -P; cd /data/lk; cd ..; pwd', '/data/deep\n'],
  ]

  it.each(logicalCwdRows)('logical vs physical cwd: %s', async (command, expected) => {
    const ws = buildWorkspace()
    await ws.shell('mkdir -p /data/deep/real/sub')
    await ws.shell('ln -s /data/deep/real /data/lk')
    const r = await ws.shell(command)
    expect(dec(r.stderr)).toBe('')
    expect(dec(r.stdout)).toBe(expected)
    await ws.close()
  })

  // GNU prints the name it selected through $CDPATH even under -P, where
  // the directory it lands on is the link's target.
  it('a $CDPATH hit announces the spelling, not the target', async () => {
    const ws = buildWorkspace()
    await ws.shell('mkdir -p /data/c/t')
    await ws.shell('ln -s /data/c/t /data/c/lnk')
    const r = await ws.shell('export CDPATH=/data/c; cd -P lnk; pwd')
    expect(dec(r.stdout)).toBe('/data/c/lnk\n/data/c/t\n')
    await ws.close()
  })

  it('set -o rejects a name bash does not have', async () => {
    const ws = buildWorkspace()
    const r = await ws.shell('set -o bogusname')
    expect(r.exitCode).toBe(2)
    expect(dec(r.stderr)).toBe('set: bogusname: invalid option name\n')
    await ws.close()
  })

  // GNU applies left to right and stops at the bad name, so an option
  // named before it stays on and one named after it never lands.
  it('set -o keeps what it applied before the bad name', async () => {
    const ws = buildWorkspace()
    const r = await ws.shell('set -o pipefail -o bogus -o noclobber')
    expect(r.exitCode).toBe(2)
    const session = ws.getSession(ws.defaultSessionId)
    expect(session.shellOptions.pipefail).toBe(true)
    expect(session.shellOptions.noclobber).toBeUndefined()
    await ws.close()
  })

  it('pwd rejects an unknown option', async () => {
    const ws = buildWorkspace()
    const r = await ws.shell('pwd -x')
    expect(r.exitCode).toBe(2)
    expect(dec(r.stderr)).toBe('pwd: -x: invalid option\npwd: usage: pwd [-LP]\n')
    await ws.close()
  })

  it('pwd ignores operands', async () => {
    const ws = buildWorkspace()
    const r = await ws.shell('cd /data && pwd extra')
    expect(r.exitCode).toBe(0)
    expect(dec(r.stdout)).toBe('/data\n')
    await ws.close()
  })

  // bash never re-checks the logical name: removing the link it was
  // spelled through leaves `pwd` printing it, and only `pwd -P` tells you
  // where you actually are.
  it('the logical cwd is not revalidated', async () => {
    const ws = buildWorkspace()
    await ws.shell('mkdir -p /data/deep/real')
    await ws.shell('ln -s /data/deep/real /data/lk')
    const r = await ws.shell('cd /data/lk && rm /data/lk && pwd && pwd -P')
    expect(dec(r.stdout)).toBe('/data/lk\n/data/deep/real\n')
    await ws.close()
  })

  it('cd through a symlink loop is ELOOP', async () => {
    const ws = buildWorkspace()
    await ws.shell('ln -s /data/b /data/a')
    await ws.shell('ln -s /data/a /data/b')
    const r = await ws.shell('cd /data/a')
    expect(r.exitCode).toBe(1)
    expect(dec(r.stderr)).toContain('Too many levels of symbolic links')
    await ws.close()
  })

  it('symlinks survive a snapshot round-trip', async () => {
    const ws = buildWorkspace()
    await ws.shell('echo hi > /data/a.txt')
    await ws.shell('ln -s /data/a.txt /data/link.txt')
    const state = await toStateDict(ws)
    const ws2 = buildWorkspace()
    await applyStateDict(ws2, state)
    const r = await ws2.shell('readlink /data/link.txt')
    expect(dec(r.stdout)).toBe('/data/a.txt\n')
    await ws.close()
    await ws2.close()
  })

  it('cat follows a link', async () => {
    const ws = buildWorkspace()
    await ws.shell('echo hi > /data/a.txt')
    await ws.shell('ln -s /data/a.txt /data/link.txt')
    const r = await ws.shell('cat /data/link.txt')
    expect(r.exitCode).toBe(0)
    expect(dec(r.stdout)).toBe('hi\n')
    await ws.close()
  })

  it('read follows a mid-path directory link', async () => {
    const ws = buildWorkspace()
    await ws.shell('mkdir -p /data/real && echo hi > /data/real/f.txt')
    await ws.shell('ln -s /data/real /data/dirlink')
    const r = await ws.shell('cat /data/dirlink/f.txt')
    expect(dec(r.stdout)).toBe('hi\n')
    await ws.close()
  })

  it('read follows a relative target', async () => {
    const ws = buildWorkspace()
    await ws.shell('mkdir -p /data/sub && echo hi > /data/sub/a.txt')
    await ws.shell('ln -s a.txt /data/sub/link.txt')
    const r = await ws.shell('cat /data/sub/link.txt')
    expect(dec(r.stdout)).toBe('hi\n')
    await ws.close()
  })

  it('write through a link updates the target', async () => {
    const ws = buildWorkspace()
    await ws.shell('echo old > /data/a.txt')
    await ws.shell('ln -s /data/a.txt /data/link.txt')
    await ws.shell('echo new > /data/link.txt')
    const r = await ws.shell('cat /data/a.txt')
    expect(dec(r.stdout)).toBe('new\n')
    await ws.close()
  })

  it('cat of a dangling link errors with the typed name', async () => {
    const ws = buildWorkspace()
    await ws.shell('ln -s /data/missing /data/dangle')
    const r = await ws.shell('cat /data/dangle')
    expect(r.exitCode).toBe(1)
    expect(dec(r.stderr)).toContain('/data/dangle')
    await ws.close()
  })

  it('cat of a link loop is ELOOP with the operand named', async () => {
    const ws = buildWorkspace()
    await ws.shell('ln -s /data/b /data/a')
    await ws.shell('ln -s /data/a /data/b')
    const r = await ws.shell('cat /data/a')
    expect(r.exitCode).toBe(1)
    expect(dec(r.stderr)).toContain('cat: /data/a: Too many levels of symbolic links')
    await ws.close()
  })

  it('ls lists links, -F marks them, -l shows the arrow', async () => {
    const ws = buildWorkspace()
    await ws.shell('echo hi > /data/a.txt')
    await ws.shell('ln -s /data/a.txt /data/link.txt')
    let r = await ws.shell('ls /data')
    expect(dec(r.stdout)).toContain('link.txt')
    r = await ws.shell('ls -F /data')
    expect(dec(r.stdout)).toContain('link.txt@')
    r = await ws.shell('ls -l /data')
    expect(dec(r.stdout)).toContain('link.txt -> /data/a.txt')
    await ws.close()
  })

  it('ls through a directory link lists the target', async () => {
    const ws = buildWorkspace()
    await ws.shell('mkdir -p /data/real && echo hi > /data/real/f.txt')
    await ws.shell('ln -s /data/real /data/dirlink')
    const r = await ws.shell('ls /data/dirlink')
    expect(dec(r.stdout)).toBe('f.txt\n')
    await ws.close()
  })

  it('rm removes the link, not the target', async () => {
    const ws = buildWorkspace()
    await ws.shell('echo hi > /data/a.txt')
    await ws.shell('ln -s /data/a.txt /data/link.txt')
    let r = await ws.shell('rm /data/link.txt')
    expect(r.exitCode).toBe(0)
    r = await ws.shell('readlink /data/link.txt')
    expect(r.exitCode).toBe(1)
    r = await ws.shell('cat /data/a.txt')
    expect(dec(r.stdout)).toBe('hi\n')
    await ws.close()
  })

  it('rm removes a dangling link', async () => {
    const ws = buildWorkspace()
    await ws.shell('ln -s /data/missing /data/dangle')
    const r = await ws.shell('rm /data/dangle')
    expect(r.exitCode).toBe(0)
    await ws.close()
  })

  it('rm handles mixed link and file operands', async () => {
    const ws = buildWorkspace()
    await ws.shell('echo hi > /data/a.txt && echo x > /data/b.txt')
    await ws.shell('ln -s /data/a.txt /data/link.txt')
    const r = await ws.shell('rm /data/link.txt /data/b.txt')
    expect(r.exitCode).toBe(0)
    const ls = await ws.shell('ls /data')
    expect(dec(ls.stdout)).toBe('a.txt\n')
    await ws.close()
  })

  it('rm of the target leaves the link dangling', async () => {
    const ws = buildWorkspace()
    await ws.shell('echo hi > /data/a.txt')
    await ws.shell('ln -s /data/a.txt /data/link.txt')
    await ws.shell('rm /data/a.txt')
    let r = await ws.shell('readlink /data/link.txt')
    expect(dec(r.stdout)).toBe('/data/a.txt\n')
    r = await ws.shell('cat /data/link.txt')
    expect(r.exitCode).toBe(1)
    await ws.close()
  })

  it('rm -r purges links under the removed dir', async () => {
    const ws = buildWorkspace()
    await ws.shell('mkdir -p /data/sub && echo hi > /data/sub/f.txt')
    await ws.shell('ln -s /data/sub/f.txt /data/sub/inner')
    let r = await ws.shell('rm -r /data/sub')
    expect(r.exitCode).toBe(0)
    r = await ws.shell('readlink /data/sub/inner')
    expect(r.exitCode).toBe(1)
    await ws.close()
  })

  it('mv renames the link entry', async () => {
    const ws = buildWorkspace()
    await ws.shell('echo hi > /data/a.txt')
    await ws.shell('ln -s /data/a.txt /data/link.txt')
    let r = await ws.shell('mv /data/link.txt /data/renamed.txt')
    expect(r.exitCode).toBe(0)
    r = await ws.shell('readlink /data/renamed.txt')
    expect(dec(r.stdout)).toBe('/data/a.txt\n')
    r = await ws.shell('readlink /data/link.txt')
    expect(r.exitCode).toBe(1)
    await ws.close()
  })

  it('mv moves a link into an existing directory', async () => {
    const ws = buildWorkspace()
    await ws.shell('mkdir -p /data/dir && echo hi > /data/a.txt')
    await ws.shell('ln -s /data/a.txt /data/link.txt')
    let r = await ws.shell('mv /data/link.txt /data/dir')
    expect(r.exitCode).toBe(0)
    r = await ws.shell('readlink /data/dir/link.txt')
    expect(dec(r.stdout)).toBe('/data/a.txt\n')
    await ws.close()
  })

  it('mv of a file onto a link replaces the entry', async () => {
    const ws = buildWorkspace()
    await ws.shell('echo a > /data/a.txt && echo b > /data/b.txt')
    await ws.shell('ln -s /data/a.txt /data/link.txt')
    let r = await ws.shell('mv /data/b.txt /data/link.txt')
    expect(r.exitCode).toBe(0)
    r = await ws.shell('readlink /data/link.txt')
    expect(r.exitCode).toBe(1)
    r = await ws.shell('cat /data/link.txt')
    expect(dec(r.stdout)).toBe('b\n')
    r = await ws.shell('cat /data/a.txt')
    expect(dec(r.stdout)).toBe('a\n')
    await ws.close()
  })

  it('cp follows the source link', async () => {
    const ws = buildWorkspace()
    await ws.shell('echo hi > /data/a.txt')
    await ws.shell('ln -s /data/a.txt /data/link.txt')
    let r = await ws.shell('cp /data/link.txt /data/copy.txt')
    expect(r.exitCode).toBe(0)
    r = await ws.shell('cat /data/copy.txt')
    expect(dec(r.stdout)).toBe('hi\n')
    await ws.close()
  })

  it('grep follows a link', async () => {
    const ws = buildWorkspace()
    await ws.shell("printf 'alpha\\nbeta\\n' > /data/a.txt")
    await ws.shell('ln -s /data/a.txt /data/link.txt')
    const r = await ws.shell('grep beta /data/link.txt')
    expect(r.exitCode).toBe(0)
    expect(dec(r.stdout)).toContain('beta')
    await ws.close()
  })
  async function seeded(): Promise<Workspace> {
    const ws = buildWorkspace()
    await ws.shell('mkdir -p /data/dir')
    await ws.shell('echo hello > /data/dir/real.txt')
    await ws.shell('ln -s /data/dir/real.txt /data/link.txt')
    await ws.shell('ln -s /data/dir /data/dlink')
    return ws
  }

  async function dangling(): Promise<Workspace> {
    const ws = await seeded()
    await ws.shell('ln -s /data/nope /data/dangle')
    return ws
  }

  it('ls -l reports a link operand without following it', async () => {
    const ws = await seeded()
    const r = await ws.shell('ls -l /data/link.txt')
    expect(r.exitCode).toBe(0)
    const line = dec(r.stdout).trim()
    expect(line.startsWith('lrwxrwxrwx')).toBe(true)
    expect(line.endsWith('/data/link.txt -> /data/dir/real.txt')).toBe(true)
    await ws.close()
  })

  it('ls -l on a dangling link succeeds', async () => {
    const ws = await dangling()
    const r = await ws.shell('ls -l /data/dangle')
    expect(r.exitCode).toBe(0)
    expect(dec(r.stdout).trim().endsWith('/data/dangle -> /data/nope')).toBe(true)
    await ws.close()
  })

  it('ls -l on a directory link shows the link, bare ls dereferences', async () => {
    const ws = await seeded()
    const long = await ws.shell('ls -l /data/dlink')
    expect(dec(long.stdout).trim().endsWith('/data/dlink -> /data/dir')).toBe(true)
    const bare = await ws.shell('ls /data/dlink')
    expect(dec(bare.stdout)).toBe('real.txt\n')
    await ws.close()
  })

  it('ls -R lists links and does not descend them', async () => {
    const ws = await dangling()
    const out = dec((await ws.shell('ls -R /data')).stdout)
    expect(out.split('\n').slice(0, 5)).toEqual(['/data:', 'dangle', 'dir', 'dlink', 'link.txt'])
    expect(out).toContain('/data/dir:')
    expect(out).not.toContain('/data/dlink:')
    await ws.close()
  })

  it('ls -F marks links with an at sign', async () => {
    const ws = await seeded()
    const out = dec((await ws.shell('ls -F /data')).stdout)
    expect(out).toContain('dlink@')
    expect(out).toContain('link.txt@')
    await ws.close()
  })

  it('find reports links and -type l selects them', async () => {
    const ws = await dangling()
    expect(dec((await ws.shell('find /data -type l')).stdout)).toBe(
      '/data/dangle\n/data/dlink\n/data/link.txt\n',
    )
    expect(dec((await ws.shell('find /data -type f')).stdout)).toBe('/data/dir/real.txt\n')
    await ws.close()
  })

  it('readlink -e fails on a dangling link while -f prints it', async () => {
    const ws = await dangling()
    const e = await ws.shell('readlink -e /data/dangle')
    expect(e.exitCode).toBe(1)
    expect(dec(e.stdout)).toBe('')
    const f = await ws.shell('readlink -f /data/dangle')
    expect(f.exitCode).toBe(0)
    expect(dec(f.stdout)).toBe('/data/nope\n')
    await ws.close()
  })

  it('file describes a link and calls a dangling one broken', async () => {
    const ws = await dangling()
    expect(dec((await ws.shell('file /data/link.txt')).stdout)).toBe(
      '/data/link.txt: symbolic link to /data/dir/real.txt\n',
    )
    expect(dec((await ws.shell('file /data/dangle')).stdout)).toBe(
      '/data/dangle: broken symbolic link to /data/nope\n',
    )
    await ws.close()
  })

  it('du -a accounts for links and does not follow a link operand', async () => {
    const ws = await dangling()
    const listed = dec((await ws.shell('du -a /data')).stdout)
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => l.split('\t')[1])
    expect(listed).toContain('/data/dangle')
    expect(listed).toContain('/data/dlink')
    expect(listed).toContain('/data/link.txt')
    // GNU du reports the link itself without -L; mirage sizes it by the
    // target length because du counts bytes, not blocks.
    const one = dec((await ws.shell('du /data/link.txt')).stdout)
      .trim()
      .split('\t')
    expect(one[1]).toBe('/data/link.txt')
    expect(Number(one[0])).toBe('/data/dir/real.txt'.length)
    await ws.close()
  })

  it('stat lstats a link and -L dereferences', async () => {
    const ws = await seeded()
    expect(dec((await ws.shell('stat /data/link.txt')).stdout)).toContain('type=symlink')
    expect(dec((await ws.shell('stat -L /data/link.txt')).stdout)).toContain('type=text')
    await ws.close()
  })

  // GNU renders %N as `'name' -> 'target'` for a link, and as the bare
  // quoted name otherwise.
  it('stat %N renders the link arrow', async () => {
    const ws = await seeded()
    expect(dec((await ws.shell("stat -c '%N' /data/link.txt")).stdout)).toBe(
      "'/data/link.txt' -> '/data/dir/real.txt'\n",
    )
    expect(dec((await ws.shell("stat -c '%N' /data/dir/real.txt")).stdout)).toBe(
      "'/data/dir/real.txt'\n",
    )
    // %n is the bare name even for a link.
    expect(dec((await ws.shell("stat -c '%n' /data/link.txt")).stdout)).toBe('/data/link.txt\n')
    // -L reports the target, which is not a link, so no arrow.
    expect(dec((await ws.shell("stat -L -c '%N' /data/link.txt")).stdout)).toBe(
      "'/data/link.txt'\n",
    )
    await ws.close()
  })

  it('stat %N renders the arrow for a dangling link', async () => {
    const ws = await dangling()
    expect(dec((await ws.shell("stat -c '%N' /data/dangle")).stdout)).toBe(
      "'/data/dangle' -> '/data/nope'\n",
    )
    await ws.close()
  })

  it('stat %N quotes each side on its own', async () => {
    const ws = buildWorkspace()
    await ws.shell('echo hi > "/data/it\'s"')
    await ws.shell('ln -s "/data/it\'s" /data/plain')
    expect(dec((await ws.shell("stat -c '%N' /data/plain")).stdout)).toBe(
      "'/data/plain' -> \"/data/it's\"\n",
    )
    await ws.close()
  })

  // A target with an apostrophe next to a live character goes back to single
  // quotes, so replaying the line cannot expand $c.
  it('stat %N single-quotes a target holding shell metacharacters', async () => {
    const ws = buildWorkspace()
    await ws.shell('ln -s "/data/a\'b\\$c" /data/meta')
    expect(dec((await ws.shell("stat -c '%N' /data/meta")).stdout)).toBe(
      "'/data/meta' -> '/data/a'\\''b$c'\n",
    )
    await ws.close()
  })

  // GNU quotes %N only when the directive carries no modifier, and a width
  // or precision applies to the name and the target separately.
  it('stat %N modifiers drop the quotes and pad each side', async () => {
    const ws = await seeded()
    expect(dec((await ws.shell("stat -c '[%20N]' /data/link.txt")).stdout)).toBe(
      '[      /data/link.txt ->   /data/dir/real.txt]\n',
    )
    expect(dec((await ws.shell("stat -c '[%-20N]' /data/link.txt")).stdout)).toBe(
      '[/data/link.txt       -> /data/dir/real.txt  ]\n',
    )
    expect(dec((await ws.shell("stat -c '[%.6N]' /data/link.txt")).stdout)).toBe(
      '[/data/ -> /data/]\n',
    )
    expect(dec((await ws.shell("stat -c '[%20N]' /data/dir/real.txt")).stdout)).toBe(
      '[  /data/dir/real.txt]\n',
    )
    await ws.close()
  })
  it('find -L classifies a link by its target', async () => {
    const ws = buildWorkspace()
    for (const c of [
      'mkdir -p /data/d/sub',
      'echo hello > /data/d/real.txt',
      'echo inner > /data/d/sub/inner.txt',
      'ln -s /data/d/real.txt /data/d/flink',
      'ln -s /data/d/sub /data/d/dlink',
      'ln -s /data/nowhere /data/d/dangle',
    ]) {
      await ws.shell(c)
    }
    const f = await ws.shell('find -L /data/d -type f')
    expect(dec(f.stdout).trimEnd().split('\n')).toEqual([
      '/data/d/flink',
      '/data/d/real.txt',
      '/data/d/sub/inner.txt',
    ])
    const d = await ws.shell('find -L /data/d -type d')
    expect(dec(d.stdout).trimEnd().split('\n')).toEqual(['/data/d', '/data/d/dlink', '/data/d/sub'])
    // Only a dangling link stays type l under -L.
    const l = await ws.shell('find -L /data/d -type l')
    expect(dec(l.stdout).trimEnd().split('\n')).toEqual(['/data/d/dangle'])
    await ws.close()
  })

  it('find without -L reports every link as l', async () => {
    const ws = buildWorkspace()
    for (const c of [
      'mkdir -p /data/d/sub',
      'echo hello > /data/d/real.txt',
      'ln -s /data/d/real.txt /data/d/flink',
      'ln -s /data/d/sub /data/d/dlink',
    ]) {
      await ws.shell(c)
    }
    const l = await ws.shell('find /data/d -type l')
    expect(dec(l.stdout).trimEnd().split('\n')).toEqual(['/data/d/dlink', '/data/d/flink'])
    const f = await ws.shell('find /data/d -type f')
    expect(dec(f.stdout).trimEnd().split('\n')).toEqual(['/data/d/real.txt'])
    await ws.close()
  })
})

// POSIX pathname resolution: `x/` is `x/.`, so a trailing slash resolves
// the final symlink even for a command that otherwise lstats its operand,
// and then requires what it found to be a directory. Every expectation
// below is GNU coreutils 9.4 / tar 1.35 on debian:stable-slim, probed per
// case from a fresh tree:
//
//   base/dlink  -> base/sub   (emptydir/, f2 = 7 bytes, l2 -> 14-byte target)
//   base/flink  -> base/reg   (a 6-byte regular file)
//   base/dangle -> base/nope  (nothing)
describe('trailing slash (POSIX pathname resolution)', () => {
  async function slashWorkspace(): Promise<Workspace> {
    const ws = buildWorkspace()
    for (const c of [
      'mkdir -p /data/base/sub/emptydir',
      "printf 'abcdef\\n' > /data/base/sub/f2",
      "printf 'hello\\n' > /data/base/reg",
      'ln -s 12345678901234 /data/base/sub/l2',
      'ln -s sub /data/base/dlink',
      'ln -s reg /data/base/flink',
      'ln -s nope /data/base/dangle',
    ]) {
      await ws.shell(c)
    }
    return ws
  }

  it('resolves the link prefix for a no-follow command', async () => {
    const ws = await slashWorkspace()
    expect(dec((await ws.shell("stat -c '%F' /data/base/dlink/f2")).stdout)).toBe('regular file\n')
    expect(dec((await ws.shell('du /data/base/dlink/f2')).stdout)).toBe('7\t/data/base/dlink/f2\n')
    expect(dec((await ws.shell('find /data/base/dlink/f2')).stdout)).toBe('/data/base/dlink/f2\n')
    expect(dec((await ws.shell('readlink /data/base/dlink/l2')).stdout)).toBe('12345678901234\n')
    const r = await ws.shell('rmdir /data/base/dlink/f2')
    expect(r.exitCode).toBe(1)
    expect(dec(r.stderr)).toBe("rmdir: failed to remove '/data/base/dlink/f2': Not a directory\n")
    await ws.close()
  })

  it('resolves a directory link', async () => {
    const ws = await slashWorkspace()
    expect(dec((await ws.shell("stat -c '%F' /data/base/dlink")).stdout)).toBe('symbolic link\n')
    expect(dec((await ws.shell("stat -c '%F' /data/base/dlink/")).stdout)).toBe('directory\n')
    // The link's own target-string length, then the target's contents.
    expect(dec((await ws.shell('du /data/base/dlink')).stdout)).toBe('3\t/data/base/dlink\n')
    expect(dec((await ws.shell('du /data/base/dlink/')).stdout)).toBe('21\t/data/base/dlink/\n')
    expect(dec((await ws.shell('file /data/base/dlink/')).stdout)).toBe(
      '/data/base/dlink/: directory\n',
    )
    expect(
      dec((await ws.shell('ls /data/base/dlink/')).stdout)
        .trimEnd()
        .split('\n'),
    ).toEqual(['emptydir', 'f2', 'l2'])
    await ws.close()
  })

  it('walks the target under find', async () => {
    const ws = await slashWorkspace()
    const all = await ws.shell('find /data/base/dlink/')
    expect(dec(all.stdout).trimEnd().split('\n')).toEqual([
      '/data/base/dlink/',
      '/data/base/dlink/emptydir',
      '/data/base/dlink/f2',
      '/data/base/dlink/l2',
    ])
    expect(dec((await ws.shell('find /data/base/dlink/ -type f')).stdout)).toBe(
      '/data/base/dlink/f2\n',
    )
    await ws.close()
  })

  it('leaves readlink nothing to read', async () => {
    const ws = await slashWorkspace()
    expect(dec((await ws.shell('readlink /data/base/dlink')).stdout)).toBe('sub\n')
    const r = await ws.shell('readlink /data/base/dlink/')
    expect(r.exitCode).toBe(1)
    expect(dec(r.stdout)).toBe('')
    await ws.close()
  })

  it('requires the operand to be a directory', async () => {
    const ws = await slashWorkspace()
    const cases: [string, string][] = [
      ['flink', 'Not a directory'],
      ['reg', 'Not a directory'],
      ['dangle', 'No such file or directory'],
    ]
    for (const [operand, detail] of cases) {
      const path = `/data/base/${operand}/`
      const cat = await ws.shell(`cat ${path}`)
      expect(cat.exitCode, operand).toBe(1)
      expect(dec(cat.stderr)).toBe(`cat: ${path}: ${detail}\n`)
      const wc = await ws.shell(`wc -c ${path}`)
      expect(wc.exitCode, operand).toBe(1)
      expect(dec(wc.stderr)).toBe(`wc: ${path}: ${detail}\n`)
      const ls = await ws.shell(`ls ${path}`)
      expect(ls.exitCode, operand).toBe(2)
      expect(dec(ls.stderr)).toBe(`ls: cannot access '${path}': ${detail}\n`)
      const du = await ws.shell(`du ${path}`)
      expect(du.exitCode, operand).toBe(1)
      expect(dec(du.stderr)).toBe(`du: cannot access '${path}': ${detail}\n`)
      const find = await ws.shell(`find ${path}`)
      expect(find.exitCode, operand).toBe(1)
      expect(dec(find.stderr)).toBe(`find: '${path}': ${detail}\n`)
    }
    await ws.close()
  })

  it('words rmdir a link apart from a slashed link', async () => {
    const ws = await slashWorkspace()
    const bare = await ws.shell('rmdir /data/base/dlink')
    expect(bare.exitCode).toBe(1)
    expect(dec(bare.stderr)).toBe("rmdir: failed to remove '/data/base/dlink': Not a directory\n")
    const slashed = await ws.shell('rmdir /data/base/dlink/')
    expect(slashed.exitCode).toBe(1)
    expect(dec(slashed.stderr)).toBe(
      "rmdir: failed to remove '/data/base/dlink/': Symbolic link not followed\n",
    )
    expect(dec((await ws.shell('readlink /data/base/dlink')).stdout)).toBe('sub\n')
    await ws.close()
  })

  it('protects a link from rm and unlink', async () => {
    const ws = await slashWorkspace()
    const rm = await ws.shell('rm /data/base/dlink/')
    expect(rm.exitCode).toBe(1)
    expect(dec(rm.stderr)).toBe("rm: cannot remove '/data/base/dlink/': Is a directory\n")
    expect(dec((await ws.shell('readlink /data/base/dlink')).stdout)).toBe('sub\n')
    const rmr = await ws.shell('rm -r /data/base/dlink/')
    expect(rmr.exitCode).toBe(1)
    expect(dec(rmr.stderr)).toBe("rm: cannot remove '/data/base/dlink/': Not a directory\n")
    const un = await ws.shell('unlink /data/base/dlink/')
    expect(un.exitCode).toBe(1)
    expect(dec(un.stderr)).toBe("unlink: cannot unlink '/data/base/dlink/': Not a directory\n")
    expect(dec((await ws.shell('readlink /data/base/dlink')).stdout)).toBe('sub\n')
    // Without the slash both remove the link itself, as GNU does.
    expect((await ws.shell('rm /data/base/dlink')).exitCode).toBe(0)
    expect((await ws.shell('readlink /data/base/dlink')).exitCode).toBe(1)
    await ws.close()
  })

  it('lets -f suppress ENOTDIR but not EISDIR', async () => {
    const ws = await slashWorkspace()
    expect((await ws.shell('rm -f /data/base/flink/')).exitCode).toBe(0)
    expect((await ws.shell('rm -rf /data/base/dlink/')).exitCode).toBe(0)
    // -rf left the link alone, so the plain form still refuses.
    const r = await ws.shell('rm -f /data/base/dlink/')
    expect(r.exitCode).toBe(1)
    expect(dec(r.stderr)).toBe("rm: cannot remove '/data/base/dlink/': Is a directory\n")
    await ws.close()
  })

  it('removes a bare link through unlink', async () => {
    const ws = await slashWorkspace()
    expect((await ws.shell('unlink /data/base/dlink')).exitCode).toBe(0)
    expect((await ws.shell('readlink /data/base/dlink')).exitCode).toBe(1)
    await ws.close()
  })

  it('collides mkdir with a link it cannot see', async () => {
    const ws = await slashWorkspace()
    for (const line of [
      'mkdir -p /data/base/dangle',
      'mkdir /data/base/dangle',
      'mkdir -p /data/base/dangle/',
    ]) {
      const r = await ws.shell(line)
      expect(r.exitCode, line).toBe(1)
      expect(dec(r.stderr), line).toContain('File exists')
      expect((await ws.shell('ls /data/base/nope')).exitCode).not.toBe(0)
    }
    // A link that already leads to a directory satisfies -p.
    expect((await ws.shell('mkdir -p /data/base/dlink')).exitCode).toBe(0)
    const flink = await ws.shell('mkdir -p /data/base/flink')
    expect(flink.exitCode).toBe(1)
    expect(dec(flink.stderr)).toContain('File exists')
    await ws.close()
  })

  it('never creates through a trailing slash under touch', async () => {
    const ws = await slashWorkspace()
    expect((await ws.shell('touch /data/base/dlink/')).exitCode).toBe(0)
    const f = await ws.shell('touch /data/base/flink/')
    expect(f.exitCode).toBe(1)
    expect(dec(f.stderr)).toBe("touch: setting times of '/data/base/flink/': Not a directory\n")
    const d = await ws.shell('touch /data/base/dangle/')
    expect(d.exitCode).toBe(1)
    expect(dec(d.stderr)).toBe(
      "touch: setting times of '/data/base/dangle/': No such file or directory\n",
    )
    await ws.close()
  })

  it('ignores a trailing slash in tar', async () => {
    const ws = await slashWorkspace()
    expect((await ws.shell('tar -cf /data/a.tar -C /data/base dlink/')).exitCode).toBe(0)
    expect((await ws.shell('tar -cf /data/b.tar -C /data/base dlink')).exitCode).toBe(0)
    const slashed = dec((await ws.shell('tar -tf /data/a.tar')).stdout)
    expect(slashed).toBe(dec((await ws.shell('tar -tf /data/b.tar')).stdout))
    expect(slashed.trimEnd().split('\n')).toEqual(['dlink'])
    await ws.close()
  })

  // GNU removes nothing from a line it refuses. The link entry lives in
  // the namespace, so the dispatcher drops it before the command layer
  // parses; a line that layer would reject has to leave it alone. Pinned
  // against GNU coreutils 9.7.
  it('validates a removal line before it drops a link', async () => {
    const ws = await slashWorkspace()
    const extra = await ws.shell('unlink /data/base/dlink /data/base/flink')
    expect(extra.exitCode).toBe(1)
    expect(dec(extra.stderr)).toBe(
      "unlink: extra operand '/data/base/flink'\nTry 'unlink --help' for more information.\n",
    )
    const badOpt = await ws.shell('unlink --bogus /data/base/dlink')
    expect(badOpt.exitCode).toBe(1)
    expect(dec(badOpt.stderr)).toBe(
      "unlink: unrecognized option '--bogus'\nTry 'unlink --help' for more information.\n",
    )
    const badRm = await ws.shell('rm --bogus /data/base/dlink')
    expect(badRm.exitCode).toBe(1)
    expect(dec(badRm.stderr)).toBe(
      "rm: unrecognized option '--bogus'\nTry 'rm --help' for more information.\n",
    )
    for (const name of ['dlink', 'flink']) {
      expect((await ws.shell(`readlink /data/base/${name}`)).exitCode).toBe(0)
    }
    expect((await ws.shell('unlink /data/base/flink')).exitCode).toBe(0)
    expect((await ws.shell('rm /data/base/dlink')).exitCode).toBe(0)
    expect((await ws.shell('readlink /data/base/dlink')).exitCode).toBe(1)
    await ws.close()
  })

  // rename(2) never follows, so `mv dlink/` is refused rather than
  // resolved, where a bare `mv dlink out` renames the link entry. The
  // four wordings follow mv's own order and are pinned against GNU 9.7.
  it('refuses a slashed link source instead of renaming it', async () => {
    const ws = await slashWorkspace()
    await ws.shell('mkdir /data/outdir')
    await ws.shell("printf 'x\\n' > /data/outfile")

    const plain = await ws.shell('mv /data/base/dlink/ /data/out')
    expect(plain.exitCode).toBe(1)
    expect(dec(plain.stderr)).toBe(
      "mv: cannot move '/data/base/dlink/' to '/data/out': Not a directory\n",
    )
    const toFile = await ws.shell('mv /data/base/flink/ /data/out')
    expect(toFile.exitCode).toBe(1)
    expect(dec(toFile.stderr)).toBe("mv: cannot stat '/data/base/flink/': Not a directory\n")
    const dangling = await ws.shell('mv /data/base/dangle/ /data/out')
    expect(dangling.exitCode).toBe(1)
    expect(dec(dangling.stderr)).toBe(
      "mv: cannot stat '/data/base/dangle/': No such file or directory\n",
    )
    const intoDir = await ws.shell('mv /data/base/dlink/ /data/outdir')
    expect(intoDir.exitCode).toBe(1)
    expect(dec(intoDir.stderr)).toBe(
      "mv: cannot move '/data/base/dlink/' to '/data/outdir/dlink': Not a directory\n",
    )
    const ontoFile = await ws.shell('mv /data/base/dlink/ /data/outfile')
    expect(ontoFile.exitCode).toBe(1)
    expect(dec(ontoFile.stderr)).toBe(
      "mv: cannot overwrite non-directory '/data/outfile' with directory '/data/base/dlink/'\n",
    )
    expect((await ws.shell('ls /data/out')).exitCode).not.toBe(0)
    expect((await ws.shell('mv /data/base/dlink /data/out')).exitCode).toBe(0)
    expect(dec((await ws.shell('readlink /data/out')).stdout)).toBe('sub\n')
    await ws.close()
  })

  it('resolves a link prefix before refusing the last component in mv', async () => {
    const ws = await slashWorkspace()
    await ws.shell('ln -s /data/base /data/alias')
    const r = await ws.shell('mv /data/alias/dlink/ /data/out')
    expect(r.exitCode).toBe(1)
    expect(dec(r.stderr)).toBe(
      "mv: cannot move '/data/alias/dlink/' to '/data/out': Not a directory\n",
    )
    expect((await ws.shell('readlink /data/base/dlink')).exitCode).toBe(0)
    await ws.close()
  })
})

// ln: GNU operand grammar, backups, and the hard-link tier.
async function seedLn(ws: Workspace): Promise<void> {
  await ws.shell('mkdir -p /data/d /data/e')
  await ws.shell('echo hi > /data/a.txt; echo yo > /data/b.txt')
}

describe('ln operand grammar and backups', () => {
  it('links into a directory destination', async () => {
    const ws = buildWorkspace()
    await seedLn(ws)
    const r = await ws.shell('ln -sv /data/a.txt /data/d')
    expect(r.exitCode).toBe(0)
    expect(dec(r.stdout)).toBe("'/data/d/a.txt' -> '/data/a.txt'\n")
    expect(dec((await ws.shell('readlink /data/d/a.txt')).stdout)).toBe('/data/a.txt\n')
    expect((await ws.shell('ln -sr /data/b.txt /data/d/')).exitCode).toBe(0)
    expect(dec((await ws.shell('readlink /data/d/b.txt')).stdout)).toBe('../b.txt\n')
    await ws.close()
  })

  it('-t and a trailing directory operand link every operand', async () => {
    const ws = buildWorkspace()
    await seedLn(ws)
    expect((await ws.shell('ln -s -t /data/d /data/a.txt /data/b.txt')).exitCode).toBe(0)
    expect(dec((await ws.shell('readlink /data/d/a.txt')).stdout)).toBe('/data/a.txt\n')
    expect(dec((await ws.shell('readlink /data/d/b.txt')).stdout)).toBe('/data/b.txt\n')
    expect((await ws.shell('ln -s /data/a.txt /data/b.txt /data/e')).exitCode).toBe(0)
    expect(dec((await ws.shell('readlink /data/e/b.txt')).stdout)).toBe('/data/b.txt\n')
    await ws.close()
  })

  it('a single operand links into the cwd', async () => {
    const ws = buildWorkspace()
    await seedLn(ws)
    const r = await ws.shell('cd /data/d && ln -s ../a.txt && readlink a.txt')
    expect(r.exitCode).toBe(0)
    expect(dec(r.stdout)).toBe('../a.txt\n')
    const again = await ws.shell('cd /data/d && ln -s ../a.txt')
    expect(again.exitCode).toBe(1)
    expect(dec(again.stderr)).toBe("ln: failed to create symbolic link './a.txt': File exists\n")
    await ws.close()
  })

  it.each([
    [
      'ln -s -t /data/nodir /data/a.txt',
      "ln: failed to access '/data/nodir': No such file or directory\n",
    ],
    ['ln -s -t /data/b.txt /data/a.txt', "ln: target '/data/b.txt' is not a directory\n"],
    [
      'ln -s -t /data/d -T /data/a.txt',
      'ln: cannot combine --target-directory and --no-target-directory\n',
    ],
    [
      'ln -s /data/a.txt /data/b.txt /data/nodir',
      "ln: target '/data/nodir': No such file or directory\n",
    ],
    ['ln -s /data/a.txt /data/d/x /data/b.txt', "ln: target '/data/b.txt': Not a directory\n"],
    ['ln -sT /data/a.txt /data/d', "ln: failed to create symbolic link '/data/d': File exists\n"],
    [
      'ln -sT /data/a.txt /data/b.txt /data/c',
      "ln: extra operand '/data/c'\nTry 'ln --help' for more information.\n",
    ],
    [
      'ln -sT /data/a.txt',
      "ln: missing destination file operand after '/data/a.txt'\nTry 'ln --help' for more information.\n",
    ],
    ['ln', "ln: missing file operand\nTry 'ln --help' for more information.\n"],
    [
      'ln -x /data/a.txt /data/l',
      "ln: invalid option -- 'x'\nTry 'ln --help' for more information.\n",
    ],
    [
      'ln --bogus /data/a.txt /data/l',
      "ln: unrecognized option '--bogus'\nTry 'ln --help' for more information.\n",
    ],
    [
      'ln -s --backup=bogus /data/a.txt /data/l',
      "ln: invalid argument 'bogus' for 'backup type'\nValid arguments are:\n  - 'none', 'off'\n  - 'simple', 'never'\n  - 'existing', 'nil'\n  - 'numbered', 't'\nTry 'ln --help' for more information.\n",
    ],
    [
      'ln /data/missing /data/h',
      "ln: failed to access '/data/missing': No such file or directory\n",
    ],
    ['ln /data/d /data/hd', 'ln: /data/d: hard link not allowed for directory\n'],
    [
      'ln -d /data/d /data/hd',
      "ln: failed to create hard link '/data/hd' => '/data/d': Operation not permitted\n",
    ],
    [
      'ln -F /data/d /data/hd',
      "ln: failed to create hard link '/data/hd' => '/data/d': Operation not permitted\n",
    ],
  ])('refuses in GNU words: %s', async (line, stderr) => {
    const ws = buildWorkspace()
    await seedLn(ws)
    const r = await ws.shell(line)
    expect(r.exitCode).toBe(1)
    expect(dec(r.stderr)).toBe(stderr)
    await ws.close()
  })

  it('-b moves the occupant aside, -S names the suffix', async () => {
    const ws = buildWorkspace()
    await seedLn(ws)
    await ws.shell('ln -s /data/a.txt /data/l')
    const r = await ws.shell('ln -sbv /data/b.txt /data/l')
    expect(r.exitCode).toBe(0)
    expect(dec(r.stdout)).toBe("'/data/l~' ~ '/data/l' -> '/data/b.txt'\n")
    expect(dec((await ws.shell('readlink /data/l')).stdout)).toBe('/data/b.txt\n')
    expect(dec((await ws.shell('readlink /data/l~')).stdout)).toBe('/data/a.txt\n')
    expect((await ws.shell('ln -s -S .bak /data/a.txt /data/b.txt')).exitCode).toBe(0)
    expect(dec((await ws.shell('cat /data/b.txt.bak')).stdout)).toBe('yo\n')
    expect(dec((await ws.shell('readlink /data/b.txt')).stdout)).toBe('/data/a.txt\n')
    await ws.close()
  })

  it('numbered backups and --backup=none', async () => {
    const ws = buildWorkspace()
    await seedLn(ws)
    await ws.shell('echo n > /data/l')
    expect((await ws.shell('ln -s --backup=numbered /data/a.txt /data/l')).exitCode).toBe(0)
    expect(dec((await ws.shell("cat '/data/l.~1~'")).stdout)).toBe('n\n')
    const r = await ws.shell('ln -s --backup=none /data/b.txt /data/l')
    expect(r.exitCode).toBe(1)
    expect(dec(r.stderr)).toBe("ln: failed to create symbolic link '/data/l': File exists\n")
    await ws.close()
  })

  it('dereferences a link to a directory unless -n', async () => {
    const ws = buildWorkspace()
    await seedLn(ws)
    await ws.shell('ln -s /data/d /data/dl')
    expect((await ws.shell('ln -s /data/a.txt /data/dl')).exitCode).toBe(0)
    expect(dec((await ws.shell('readlink /data/d/a.txt')).stdout)).toBe('/data/a.txt\n')
    const r = await ws.shell('ln -sn /data/b.txt /data/dl')
    expect(r.exitCode).toBe(1)
    expect(dec(r.stderr)).toBe("ln: failed to create symbolic link '/data/dl': File exists\n")
    expect((await ws.shell('ln -sfn /data/b.txt /data/dl')).exitCode).toBe(0)
    expect(dec((await ws.shell('readlink /data/dl')).stdout)).toBe('/data/b.txt\n')
    for (const line of [
      'ln -sL /data/a.txt /data/l1',
      'ln -sP /data/a.txt /data/l2',
      'ln -sd /data/a.txt /data/l3',
    ]) {
      expect((await ws.shell(line)).exitCode).toBe(0)
    }
    await ws.close()
  })

  it('a hard link copies bytes and refuses an occupied name', async () => {
    const ws = buildWorkspace()
    await seedLn(ws)
    const r = await ws.shell('ln -v /data/a.txt /data/h')
    expect(r.exitCode).toBe(0)
    expect(dec(r.stdout)).toBe("'/data/h' => '/data/a.txt'\n")
    expect(dec((await ws.shell('cat /data/h')).stdout)).toBe('hi\n')
    const dup = await ws.shell('ln /data/b.txt /data/h')
    expect(dup.exitCode).toBe(1)
    expect(dec(dup.stderr)).toBe("ln: failed to create hard link '/data/h': File exists\n")
    expect((await ws.shell('ln -f /data/b.txt /data/h')).exitCode).toBe(0)
    expect(dec((await ws.shell('cat /data/h')).stdout)).toBe('yo\n')
    const backed = await ws.shell('ln -bv /data/a.txt /data/h')
    expect(dec(backed.stdout)).toBe("'/data/h~' ~ '/data/h' => '/data/a.txt'\n")
    expect(dec((await ws.shell('cat /data/h~')).stdout)).toBe('yo\n')
    expect((await ws.shell('ln -t /data/e /data/a.txt /data/b.txt')).exitCode).toBe(0)
    expect(dec((await ws.shell('cat /data/e/b.txt')).stdout)).toBe('yo\n')
    const partial = await ws.shell('ln /data/missing /data/a.txt /data/d')
    expect(partial.exitCode).toBe(1)
    expect(dec((await ws.shell('cat /data/d/a.txt')).stdout)).toBe('hi\n')
    await ws.close()
  })

  it('a hard link of a link keeps the link unless -L', async () => {
    const ws = buildWorkspace()
    await seedLn(ws)
    await ws.shell('ln -s /data/a.txt /data/lnk')
    expect((await ws.shell('ln /data/lnk /data/h1')).exitCode).toBe(0)
    expect(dec((await ws.shell('readlink /data/h1')).stdout)).toBe('/data/a.txt\n')
    expect((await ws.shell('ln -L /data/lnk /data/h2')).exitCode).toBe(0)
    expect((await ws.shell('readlink /data/h2')).exitCode).toBe(1)
    expect(dec((await ws.shell('cat /data/h2')).stdout)).toBe('hi\n')
    await ws.shell('ln -s /data/nope /data/dang')
    const r = await ws.shell('ln -L /data/dang /data/h3')
    expect(r.exitCode).toBe(1)
    expect(dec(r.stderr)).toBe("ln: failed to access '/data/dang': No such file or directory\n")
    expect((await ws.shell('ln /data/dang /data/h4')).exitCode).toBe(0)
    expect(dec((await ws.shell('readlink /data/h4')).stdout)).toBe('/data/nope\n')
    await ws.close()
  })

  it('the last of -L and -P wins', async () => {
    const ws = buildWorkspace()
    await seedLn(ws)
    await ws.shell('ln -s /data/a.txt /data/lnk')
    expect((await ws.shell('ln -LP /data/lnk /data/hp')).exitCode).toBe(0)
    expect(dec((await ws.shell('readlink /data/hp')).stdout)).toBe('/data/a.txt\n')
    expect((await ws.shell('ln -PL /data/lnk /data/hl')).exitCode).toBe(0)
    expect((await ws.shell('readlink /data/hl')).exitCode).toBe(1)
    expect(dec((await ws.shell('cat /data/hl')).stdout)).toBe('hi\n')
    expect((await ws.shell('ln --logical --physical /data/lnk /data/hp2')).exitCode).toBe(0)
    expect(dec((await ws.shell('readlink /data/hp2')).stdout)).toBe('/data/a.txt\n')
    await ws.close()
  })

  it('-r needs -s, checked after the operand count', async () => {
    const ws = buildWorkspace()
    await seedLn(ws)
    const r = await ws.shell('ln -r /data/a.txt /data/rel')
    expect(r.exitCode).toBe(1)
    expect(dec(r.stderr)).toBe('ln: cannot do --relative without --symbolic\n')
    expect((await ws.shell('test -e /data/rel')).exitCode).toBe(1)
    const missing = "ln: missing file operand\nTry 'ln --help' for more information.\n"
    expect(dec((await ws.shell('ln -r')).stderr)).toBe(missing)
    expect(dec((await ws.shell('ln -r -T -t /data/d /data/a.txt /data/x')).stderr)).toBe(
      'ln: cannot do --relative without --symbolic\n',
    )
    expect(dec((await ws.shell('ln -T -t /data/d')).stderr)).toBe(missing)
    expect((await ws.shell('ln -rs /data/a.txt /data/d/rel')).exitCode).toBe(0)
    expect(dec((await ws.shell('readlink /data/d/rel')).stdout)).toBe('../a.txt\n')
    await ws.close()
  })
})

describe('trailing slash on a link name', () => {
  it('ln refuses a slashed link name that is not there', async () => {
    // Pinned on coreutils 9.7: symlink(2) and link(2) answer `missing/`
    // with ENOENT and create nothing, the hard-link line naming its
    // source; a directory takes the link inside it as before, and a file
    // behind the slash is still the door's "File exists".
    const ws = buildWorkspace()
    await ws.shell('printf hi > /data/a.txt; printf y > /data/reg; mkdir -p /data/d')
    for (const [line, wording] of [
      [
        'ln -s /data/a.txt /data/missing/',
        "ln: failed to create symbolic link '/data/missing/': No such file or directory\n",
      ],
      [
        'ln -sT /data/a.txt /data/missing/',
        "ln: failed to create symbolic link '/data/missing/': No such file or directory\n",
      ],
      [
        'ln /data/a.txt /data/missing/',
        "ln: failed to create hard link '/data/missing/' => '/data/a.txt': No such file or directory\n",
      ],
      [
        'ln -s /data/a.txt /data/d/missing/',
        "ln: failed to create symbolic link '/data/d/missing/': No such file or directory\n",
      ],
      [
        'ln -s /data/a.txt /data/reg/',
        "ln: failed to create symbolic link '/data/reg/': File exists\n",
      ],
    ] as const) {
      const r = await ws.shell(line)
      expect([r.exitCode, dec(r.stderr)], line).toEqual([1, wording])
    }
    expect((await ws.shell('test -e /data/missing')).exitCode).toBe(1)
    expect((await ws.shell('test -e /data/d/missing')).exitCode).toBe(1)
    expect(ws.namespace.isLink('/data/missing')).toBe(false)
    const r = await ws.shell('ln -s /data/a.txt /data/d/ && readlink /data/d/a.txt')
    expect([r.exitCode, dec(r.stdout)]).toEqual([0, '/data/a.txt\n'])
  })

  it('ln settles a slashed name before -f or -b touch it', async () => {
    // Pinned on coreutils 9.7: -f and -b lstat the link name first, and
    // `reg/` over a file (or a link to one) is `failed to access 'reg/':
    // Not a directory`, so the file is neither unlinked nor renamed aside.
    const ws = buildWorkspace()
    await ws.shell('printf hi > /data/a.txt; printf y > /data/reg; ln -s /data/reg /data/flink')
    for (const line of [
      'ln -sf /data/a.txt /data/reg/',
      'ln -sb /data/a.txt /data/reg/',
      'ln -f /data/a.txt /data/reg/',
      'ln -b /data/a.txt /data/reg/',
      'ln -sf /data/a.txt /data/flink/',
    ]) {
      const r = await ws.shell(line)
      const target = line.split(' ').pop() ?? ''
      expect([r.exitCode, dec(r.stderr)], line).toEqual([
        1,
        `ln: failed to access '${target}': Not a directory\n`,
      ])
    }
    expect(dec((await ws.shell('cat /data/reg')).stdout)).toBe('y')
    expect((await ws.shell('test -e /data/reg~')).exitCode).toBe(1)
    expect(ws.namespace.readlink('/data/flink')).toBe('/data/reg')
    const r = await ws.shell('ln -sf /data/a.txt /data/missing/')
    expect(dec(r.stderr)).toBe(
      "ln: failed to create symbolic link '/data/missing/': No such file or directory\n",
    )
    expect((await ws.shell('test -e /data/missing')).exitCode).toBe(1)
  })

  it('mv of a link refuses a slashed destination', async () => {
    // Pinned on coreutils 9.7: rename(2) never follows the source, so a
    // link is not a directory whatever it points at; `mv dlnk missing/`
    // refuses at the rename and `mv dlnk reg/` at the destination's stat,
    // and the link stays where it was either way.
    const ws = buildWorkspace()
    await ws.shell('mkdir -p /data/sd /data/e; printf y > /data/reg; ln -s /data/sd /data/dlnk')
    let r = await ws.shell('mv /data/dlnk /data/missing/')
    expect([r.exitCode, dec(r.stderr)]).toEqual([
      1,
      "mv: cannot move '/data/dlnk' to '/data/missing/': Not a directory\n",
    ])
    r = await ws.shell('mv /data/dlnk /data/reg/')
    expect([r.exitCode, dec(r.stderr)]).toEqual([
      1,
      "mv: cannot stat '/data/reg/': Not a directory\n",
    ])
    r = await ws.shell('mv /data/dlnk /data/nodir/name/')
    expect([r.exitCode, dec(r.stderr)]).toEqual([
      1,
      "mv: cannot move '/data/dlnk' to '/data/nodir/name/': No such file or directory\n",
    ])
    expect(ws.namespace.readlink('/data/dlnk')).toBe('/data/sd')
    expect((await ws.shell('test -e /data/missing')).exitCode).toBe(1)
    expect(dec((await ws.shell('cat /data/reg')).stdout)).toBe('y')
    r = await ws.shell('mv /data/dlnk /data/e/ && readlink /data/e/dlnk')
    expect([r.exitCode, dec(r.stdout)]).toEqual([0, '/data/sd\n'])
  })
})
