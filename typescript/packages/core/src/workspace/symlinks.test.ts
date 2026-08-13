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
import { RAMResource } from '../resource/ram/ram.ts'
import { createShellParser, type ShellParser } from '../shell/parse.ts'
import { MountMode } from '../types.ts'
import { applyStateDict, toStateDict } from './snapshot/state.ts'
import { Workspace } from './workspace.ts'

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
  const ram = new RAMResource()
  const ops = new OpsRegistry()
  ops.registerResource(ram)
  return new Workspace({ '/data': ram }, { mode: MountMode.WRITE, ops, shellParser: parser })
}

const dec = (b: Uint8Array | null): string => (b === null ? '' : new TextDecoder().decode(b))

describe('symlinks (namespace-backed)', () => {
  it('ln -s then readlink returns the target verbatim', async () => {
    const ws = buildWorkspace()
    await ws.execute('echo hi > /data/a.txt')
    const r1 = await ws.execute('ln -s /data/a.txt /data/link.txt')
    expect(r1.exitCode).toBe(0)
    const r2 = await ws.execute('readlink /data/link.txt')
    expect(dec(r2.stdout)).toBe('/data/a.txt\n')
    await ws.close()
  })

  it('keeps a relative target verbatim', async () => {
    const ws = buildWorkspace()
    await ws.execute('echo hi > /data/a.txt')
    await ws.execute('ln -s a.txt /data/link.txt')
    const r = await ws.execute('readlink /data/link.txt')
    expect(dec(r.stdout)).toBe('a.txt\n')
    await ws.close()
  })

  it('ln -s -f overwrites an existing link', async () => {
    const ws = buildWorkspace()
    await ws.execute('echo a > /data/a.txt')
    await ws.execute('echo b > /data/b.txt')
    await ws.execute('ln -s /data/a.txt /data/link.txt')
    await ws.execute('ln -s -f /data/b.txt /data/link.txt')
    const r = await ws.execute('readlink /data/link.txt')
    expect(dec(r.stdout)).toBe('/data/b.txt\n')
    await ws.close()
  })

  it('ln -s without -f refuses an existing link', async () => {
    const ws = buildWorkspace()
    await ws.execute('echo a > /data/a.txt')
    await ws.execute('ln -s /data/a.txt /data/link.txt')
    const r = await ws.execute('ln -s /data/a.txt /data/link.txt')
    expect(r.exitCode).toBe(1)
    expect(dec(r.stderr)).toContain('File exists')
    await ws.close()
  })

  it('ln -sr stores the target relative to the link directory', async () => {
    const ws = buildWorkspace()
    await ws.execute('mkdir -p /data/a /data/b')
    await ws.execute('echo hi > /data/a/f.txt')
    const r1 = await ws.execute('ln -sr /data/a/f.txt /data/b/link')
    expect(r1.exitCode).toBe(0)
    expect(dec((await ws.execute('readlink /data/b/link')).stdout)).toBe('../a/f.txt\n')
    // the relative link resolves back to the file
    expect(dec((await ws.execute('cat /data/b/link')).stdout)).toBe('hi\n')
    await ws.close()
  })

  it('ln -srv reports the relative link', async () => {
    const ws = buildWorkspace()
    await ws.execute('mkdir -p /data/a /data/b')
    await ws.execute('echo hi > /data/a/f.txt')
    const r = await ws.execute('ln -srv /data/a/f.txt /data/b/link')
    expect(dec(r.stdout)).toBe("'/data/b/link' -> '../a/f.txt'\n")
    await ws.close()
  })

  it('ln -sn and -sT are accepted no-ops that still create the link', async () => {
    const ws = buildWorkspace()
    await ws.execute('echo hi > /data/a.txt')
    expect((await ws.execute('ln -sn /data/a.txt /data/l1')).exitCode).toBe(0)
    expect((await ws.execute('ln -sT /data/a.txt /data/l2')).exitCode).toBe(0)
    expect(dec((await ws.execute('readlink /data/l1')).stdout)).toBe('/data/a.txt\n')
    await ws.close()
  })

  // GNU bash 5.2: `cd /data/slink && pwd` prints the link, not the
  // target. The logical name is what the shell reports and what the next
  // `cd ..` acts on; `pwd -P` is how you ask for the target.
  it('cd through a symlink keeps the name it was given', async () => {
    const ws = buildWorkspace()
    await ws.execute('mkdir -p /data/real')
    await ws.execute('ln -s /data/real /data/slink')
    expect(dec((await ws.execute('cd /data/slink && pwd')).stdout)).toBe('/data/slink\n')
    expect(dec((await ws.execute('cd /data/slink && pwd -P')).stdout)).toBe('/data/real\n')
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
    await ws.execute('mkdir -p /data/deep/real/sub')
    await ws.execute('ln -s /data/deep/real /data/lk')
    const r = await ws.execute(command)
    expect(dec(r.stderr)).toBe('')
    expect(dec(r.stdout)).toBe(expected)
    await ws.close()
  })

  // GNU prints the name it selected through $CDPATH even under -P, where
  // the directory it lands on is the link's target.
  it('a $CDPATH hit announces the spelling, not the target', async () => {
    const ws = buildWorkspace()
    await ws.execute('mkdir -p /data/c/t')
    await ws.execute('ln -s /data/c/t /data/c/lnk')
    const r = await ws.execute('export CDPATH=/data/c; cd -P lnk; pwd')
    expect(dec(r.stdout)).toBe('/data/c/lnk\n/data/c/t\n')
    await ws.close()
  })

  it('set -o rejects a name bash does not have', async () => {
    const ws = buildWorkspace()
    const r = await ws.execute('set -o bogusname')
    expect(r.exitCode).toBe(2)
    expect(dec(r.stderr)).toBe('set: bogusname: invalid option name\n')
    await ws.close()
  })

  // GNU applies left to right and stops at the bad name, so an option
  // named before it stays on and one named after it never lands.
  it('set -o keeps what it applied before the bad name', async () => {
    const ws = buildWorkspace()
    const r = await ws.execute('set -o pipefail -o bogus -o noclobber')
    expect(r.exitCode).toBe(2)
    const session = ws.getSession(ws.defaultSessionId)
    expect(session.shellOptions.pipefail).toBe(true)
    expect(session.shellOptions.noclobber).toBeUndefined()
    await ws.close()
  })

  it('pwd rejects an unknown option', async () => {
    const ws = buildWorkspace()
    const r = await ws.execute('pwd -x')
    expect(r.exitCode).toBe(2)
    expect(dec(r.stderr)).toBe('pwd: -x: invalid option\npwd: usage: pwd [-LP]\n')
    await ws.close()
  })

  it('pwd ignores operands', async () => {
    const ws = buildWorkspace()
    const r = await ws.execute('cd /data && pwd extra')
    expect(r.exitCode).toBe(0)
    expect(dec(r.stdout)).toBe('/data\n')
    await ws.close()
  })

  // bash never re-checks the logical name: removing the link it was
  // spelled through leaves `pwd` printing it, and only `pwd -P` tells you
  // where you actually are.
  it('the logical cwd is not revalidated', async () => {
    const ws = buildWorkspace()
    await ws.execute('mkdir -p /data/deep/real')
    await ws.execute('ln -s /data/deep/real /data/lk')
    const r = await ws.execute('cd /data/lk && rm /data/lk && pwd && pwd -P')
    expect(dec(r.stdout)).toBe('/data/lk\n/data/deep/real\n')
    await ws.close()
  })

  it('cd through a symlink loop is ELOOP', async () => {
    const ws = buildWorkspace()
    await ws.execute('ln -s /data/b /data/a')
    await ws.execute('ln -s /data/a /data/b')
    const r = await ws.execute('cd /data/a')
    expect(r.exitCode).toBe(1)
    expect(dec(r.stderr)).toContain('Too many levels of symbolic links')
    await ws.close()
  })

  it('symlinks survive a snapshot round-trip', async () => {
    const ws = buildWorkspace()
    await ws.execute('echo hi > /data/a.txt')
    await ws.execute('ln -s /data/a.txt /data/link.txt')
    const state = await toStateDict(ws)
    const ws2 = buildWorkspace()
    await applyStateDict(ws2, state)
    const r = await ws2.execute('readlink /data/link.txt')
    expect(dec(r.stdout)).toBe('/data/a.txt\n')
    await ws.close()
    await ws2.close()
  })

  it('cat follows a link', async () => {
    const ws = buildWorkspace()
    await ws.execute('echo hi > /data/a.txt')
    await ws.execute('ln -s /data/a.txt /data/link.txt')
    const r = await ws.execute('cat /data/link.txt')
    expect(r.exitCode).toBe(0)
    expect(dec(r.stdout)).toBe('hi\n')
    await ws.close()
  })

  it('read follows a mid-path directory link', async () => {
    const ws = buildWorkspace()
    await ws.execute('mkdir -p /data/real && echo hi > /data/real/f.txt')
    await ws.execute('ln -s /data/real /data/dirlink')
    const r = await ws.execute('cat /data/dirlink/f.txt')
    expect(dec(r.stdout)).toBe('hi\n')
    await ws.close()
  })

  it('read follows a relative target', async () => {
    const ws = buildWorkspace()
    await ws.execute('mkdir -p /data/sub && echo hi > /data/sub/a.txt')
    await ws.execute('ln -s a.txt /data/sub/link.txt')
    const r = await ws.execute('cat /data/sub/link.txt')
    expect(dec(r.stdout)).toBe('hi\n')
    await ws.close()
  })

  it('write through a link updates the target', async () => {
    const ws = buildWorkspace()
    await ws.execute('echo old > /data/a.txt')
    await ws.execute('ln -s /data/a.txt /data/link.txt')
    await ws.execute('echo new > /data/link.txt')
    const r = await ws.execute('cat /data/a.txt')
    expect(dec(r.stdout)).toBe('new\n')
    await ws.close()
  })

  it('cat of a dangling link errors with the typed name', async () => {
    const ws = buildWorkspace()
    await ws.execute('ln -s /data/missing /data/dangle')
    const r = await ws.execute('cat /data/dangle')
    expect(r.exitCode).toBe(1)
    expect(dec(r.stderr)).toContain('/data/dangle')
    await ws.close()
  })

  it('cat of a link loop is ELOOP with the operand named', async () => {
    const ws = buildWorkspace()
    await ws.execute('ln -s /data/b /data/a')
    await ws.execute('ln -s /data/a /data/b')
    const r = await ws.execute('cat /data/a')
    expect(r.exitCode).toBe(1)
    expect(dec(r.stderr)).toContain('cat: /data/a: Too many levels of symbolic links')
    await ws.close()
  })

  it('ls lists links, -F marks them, -l shows the arrow', async () => {
    const ws = buildWorkspace()
    await ws.execute('echo hi > /data/a.txt')
    await ws.execute('ln -s /data/a.txt /data/link.txt')
    let r = await ws.execute('ls /data')
    expect(dec(r.stdout)).toContain('link.txt')
    r = await ws.execute('ls -F /data')
    expect(dec(r.stdout)).toContain('link.txt@')
    r = await ws.execute('ls -l /data')
    expect(dec(r.stdout)).toContain('link.txt -> /data/a.txt')
    await ws.close()
  })

  it('ls through a directory link lists the target', async () => {
    const ws = buildWorkspace()
    await ws.execute('mkdir -p /data/real && echo hi > /data/real/f.txt')
    await ws.execute('ln -s /data/real /data/dirlink')
    const r = await ws.execute('ls /data/dirlink')
    expect(dec(r.stdout)).toBe('f.txt\n')
    await ws.close()
  })

  it('rm removes the link, not the target', async () => {
    const ws = buildWorkspace()
    await ws.execute('echo hi > /data/a.txt')
    await ws.execute('ln -s /data/a.txt /data/link.txt')
    let r = await ws.execute('rm /data/link.txt')
    expect(r.exitCode).toBe(0)
    r = await ws.execute('readlink /data/link.txt')
    expect(r.exitCode).toBe(1)
    r = await ws.execute('cat /data/a.txt')
    expect(dec(r.stdout)).toBe('hi\n')
    await ws.close()
  })

  it('rm removes a dangling link', async () => {
    const ws = buildWorkspace()
    await ws.execute('ln -s /data/missing /data/dangle')
    const r = await ws.execute('rm /data/dangle')
    expect(r.exitCode).toBe(0)
    await ws.close()
  })

  it('rm handles mixed link and file operands', async () => {
    const ws = buildWorkspace()
    await ws.execute('echo hi > /data/a.txt && echo x > /data/b.txt')
    await ws.execute('ln -s /data/a.txt /data/link.txt')
    const r = await ws.execute('rm /data/link.txt /data/b.txt')
    expect(r.exitCode).toBe(0)
    const ls = await ws.execute('ls /data')
    expect(dec(ls.stdout)).toBe('a.txt\n')
    await ws.close()
  })

  it('rm of the target leaves the link dangling', async () => {
    const ws = buildWorkspace()
    await ws.execute('echo hi > /data/a.txt')
    await ws.execute('ln -s /data/a.txt /data/link.txt')
    await ws.execute('rm /data/a.txt')
    let r = await ws.execute('readlink /data/link.txt')
    expect(dec(r.stdout)).toBe('/data/a.txt\n')
    r = await ws.execute('cat /data/link.txt')
    expect(r.exitCode).toBe(1)
    await ws.close()
  })

  it('rm -r purges links under the removed dir', async () => {
    const ws = buildWorkspace()
    await ws.execute('mkdir -p /data/sub && echo hi > /data/sub/f.txt')
    await ws.execute('ln -s /data/sub/f.txt /data/sub/inner')
    let r = await ws.execute('rm -r /data/sub')
    expect(r.exitCode).toBe(0)
    r = await ws.execute('readlink /data/sub/inner')
    expect(r.exitCode).toBe(1)
    await ws.close()
  })

  it('mv renames the link entry', async () => {
    const ws = buildWorkspace()
    await ws.execute('echo hi > /data/a.txt')
    await ws.execute('ln -s /data/a.txt /data/link.txt')
    let r = await ws.execute('mv /data/link.txt /data/renamed.txt')
    expect(r.exitCode).toBe(0)
    r = await ws.execute('readlink /data/renamed.txt')
    expect(dec(r.stdout)).toBe('/data/a.txt\n')
    r = await ws.execute('readlink /data/link.txt')
    expect(r.exitCode).toBe(1)
    await ws.close()
  })

  it('mv moves a link into an existing directory', async () => {
    const ws = buildWorkspace()
    await ws.execute('mkdir -p /data/dir && echo hi > /data/a.txt')
    await ws.execute('ln -s /data/a.txt /data/link.txt')
    let r = await ws.execute('mv /data/link.txt /data/dir')
    expect(r.exitCode).toBe(0)
    r = await ws.execute('readlink /data/dir/link.txt')
    expect(dec(r.stdout)).toBe('/data/a.txt\n')
    await ws.close()
  })

  it('mv of a file onto a link replaces the entry', async () => {
    const ws = buildWorkspace()
    await ws.execute('echo a > /data/a.txt && echo b > /data/b.txt')
    await ws.execute('ln -s /data/a.txt /data/link.txt')
    let r = await ws.execute('mv /data/b.txt /data/link.txt')
    expect(r.exitCode).toBe(0)
    r = await ws.execute('readlink /data/link.txt')
    expect(r.exitCode).toBe(1)
    r = await ws.execute('cat /data/link.txt')
    expect(dec(r.stdout)).toBe('b\n')
    r = await ws.execute('cat /data/a.txt')
    expect(dec(r.stdout)).toBe('a\n')
    await ws.close()
  })

  it('cp follows the source link', async () => {
    const ws = buildWorkspace()
    await ws.execute('echo hi > /data/a.txt')
    await ws.execute('ln -s /data/a.txt /data/link.txt')
    let r = await ws.execute('cp /data/link.txt /data/copy.txt')
    expect(r.exitCode).toBe(0)
    r = await ws.execute('cat /data/copy.txt')
    expect(dec(r.stdout)).toBe('hi\n')
    await ws.close()
  })

  it('grep follows a link', async () => {
    const ws = buildWorkspace()
    await ws.execute("printf 'alpha\\nbeta\\n' > /data/a.txt")
    await ws.execute('ln -s /data/a.txt /data/link.txt')
    const r = await ws.execute('grep beta /data/link.txt')
    expect(r.exitCode).toBe(0)
    expect(dec(r.stdout)).toContain('beta')
    await ws.close()
  })
  async function seeded(): Promise<Workspace> {
    const ws = buildWorkspace()
    await ws.execute('mkdir -p /data/dir')
    await ws.execute('echo hello > /data/dir/real.txt')
    await ws.execute('ln -s /data/dir/real.txt /data/link.txt')
    await ws.execute('ln -s /data/dir /data/dlink')
    return ws
  }

  async function dangling(): Promise<Workspace> {
    const ws = await seeded()
    await ws.execute('ln -s /data/nope /data/dangle')
    return ws
  }

  it('ls -l reports a link operand without following it', async () => {
    const ws = await seeded()
    const r = await ws.execute('ls -l /data/link.txt')
    expect(r.exitCode).toBe(0)
    const line = dec(r.stdout).trim()
    expect(line.startsWith('lrwxrwxrwx')).toBe(true)
    expect(line.endsWith('/data/link.txt -> /data/dir/real.txt')).toBe(true)
    await ws.close()
  })

  it('ls -l on a dangling link succeeds', async () => {
    const ws = await dangling()
    const r = await ws.execute('ls -l /data/dangle')
    expect(r.exitCode).toBe(0)
    expect(dec(r.stdout).trim().endsWith('/data/dangle -> /data/nope')).toBe(true)
    await ws.close()
  })

  it('ls -l on a directory link shows the link, bare ls dereferences', async () => {
    const ws = await seeded()
    const long = await ws.execute('ls -l /data/dlink')
    expect(dec(long.stdout).trim().endsWith('/data/dlink -> /data/dir')).toBe(true)
    const bare = await ws.execute('ls /data/dlink')
    expect(dec(bare.stdout)).toBe('real.txt\n')
    await ws.close()
  })

  it('ls -R lists links and does not descend them', async () => {
    const ws = await dangling()
    const out = dec((await ws.execute('ls -R /data')).stdout)
    expect(out.split('\n').slice(0, 5)).toEqual(['/data:', 'dangle', 'dir', 'dlink', 'link.txt'])
    expect(out).toContain('/data/dir:')
    expect(out).not.toContain('/data/dlink:')
    await ws.close()
  })

  it('ls -F marks links with an at sign', async () => {
    const ws = await seeded()
    const out = dec((await ws.execute('ls -F /data')).stdout)
    expect(out).toContain('dlink@')
    expect(out).toContain('link.txt@')
    await ws.close()
  })

  it('find reports links and -type l selects them', async () => {
    const ws = await dangling()
    expect(dec((await ws.execute('find /data -type l')).stdout)).toBe(
      '/data/dangle\n/data/dlink\n/data/link.txt\n',
    )
    expect(dec((await ws.execute('find /data -type f')).stdout)).toBe('/data/dir/real.txt\n')
    await ws.close()
  })

  it('readlink -e fails on a dangling link while -f prints it', async () => {
    const ws = await dangling()
    const e = await ws.execute('readlink -e /data/dangle')
    expect(e.exitCode).toBe(1)
    expect(dec(e.stdout)).toBe('')
    const f = await ws.execute('readlink -f /data/dangle')
    expect(f.exitCode).toBe(0)
    expect(dec(f.stdout)).toBe('/data/nope\n')
    await ws.close()
  })

  it('file describes a link and calls a dangling one broken', async () => {
    const ws = await dangling()
    expect(dec((await ws.execute('file /data/link.txt')).stdout)).toBe(
      '/data/link.txt: symbolic link to /data/dir/real.txt\n',
    )
    expect(dec((await ws.execute('file /data/dangle')).stdout)).toBe(
      '/data/dangle: broken symbolic link to /data/nope\n',
    )
    await ws.close()
  })

  it('du -a accounts for links and does not follow a link operand', async () => {
    const ws = await dangling()
    const listed = dec((await ws.execute('du -a /data')).stdout)
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => l.split('\t')[1])
    expect(listed).toContain('/data/dangle')
    expect(listed).toContain('/data/dlink')
    expect(listed).toContain('/data/link.txt')
    // GNU du reports the link itself without -L; mirage sizes it by the
    // target length because du counts bytes, not blocks.
    const one = dec((await ws.execute('du /data/link.txt')).stdout)
      .trim()
      .split('\t')
    expect(one[1]).toBe('/data/link.txt')
    expect(Number(one[0])).toBe('/data/dir/real.txt'.length)
    await ws.close()
  })

  it('stat lstats a link and -L dereferences', async () => {
    const ws = await seeded()
    expect(dec((await ws.execute('stat /data/link.txt')).stdout)).toContain('type=symlink')
    expect(dec((await ws.execute('stat -L /data/link.txt')).stdout)).toContain('type=text')
    await ws.close()
  })

  // GNU renders %N as `'name' -> 'target'` for a link, and as the bare
  // quoted name otherwise.
  it('stat %N renders the link arrow', async () => {
    const ws = await seeded()
    expect(dec((await ws.execute("stat -c '%N' /data/link.txt")).stdout)).toBe(
      "'/data/link.txt' -> '/data/dir/real.txt'\n",
    )
    expect(dec((await ws.execute("stat -c '%N' /data/dir/real.txt")).stdout)).toBe(
      "'/data/dir/real.txt'\n",
    )
    // %n is the bare name even for a link.
    expect(dec((await ws.execute("stat -c '%n' /data/link.txt")).stdout)).toBe('/data/link.txt\n')
    // -L reports the target, which is not a link, so no arrow.
    expect(dec((await ws.execute("stat -L -c '%N' /data/link.txt")).stdout)).toBe(
      "'/data/link.txt'\n",
    )
    await ws.close()
  })

  it('stat %N renders the arrow for a dangling link', async () => {
    const ws = await dangling()
    expect(dec((await ws.execute("stat -c '%N' /data/dangle")).stdout)).toBe(
      "'/data/dangle' -> '/data/nope'\n",
    )
    await ws.close()
  })

  it('stat %N quotes each side on its own', async () => {
    const ws = buildWorkspace()
    await ws.execute('echo hi > "/data/it\'s"')
    await ws.execute('ln -s "/data/it\'s" /data/plain')
    expect(dec((await ws.execute("stat -c '%N' /data/plain")).stdout)).toBe(
      "'/data/plain' -> \"/data/it's\"\n",
    )
    await ws.close()
  })

  // A target with an apostrophe next to a live character goes back to single
  // quotes, so replaying the line cannot expand $c.
  it('stat %N single-quotes a target holding shell metacharacters', async () => {
    const ws = buildWorkspace()
    await ws.execute('ln -s "/data/a\'b\\$c" /data/meta')
    expect(dec((await ws.execute("stat -c '%N' /data/meta")).stdout)).toBe(
      "'/data/meta' -> '/data/a'\\''b$c'\n",
    )
    await ws.close()
  })

  // GNU quotes %N only when the directive carries no modifier, and a width
  // or precision applies to the name and the target separately.
  it('stat %N modifiers drop the quotes and pad each side', async () => {
    const ws = await seeded()
    expect(dec((await ws.execute("stat -c '[%20N]' /data/link.txt")).stdout)).toBe(
      '[      /data/link.txt ->   /data/dir/real.txt]\n',
    )
    expect(dec((await ws.execute("stat -c '[%-20N]' /data/link.txt")).stdout)).toBe(
      '[/data/link.txt       -> /data/dir/real.txt  ]\n',
    )
    expect(dec((await ws.execute("stat -c '[%.6N]' /data/link.txt")).stdout)).toBe(
      '[/data/ -> /data/]\n',
    )
    expect(dec((await ws.execute("stat -c '[%20N]' /data/dir/real.txt")).stdout)).toBe(
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
      await ws.execute(c)
    }
    const f = await ws.execute('find -L /data/d -type f')
    expect(dec(f.stdout).trimEnd().split('\n')).toEqual([
      '/data/d/flink',
      '/data/d/real.txt',
      '/data/d/sub/inner.txt',
    ])
    const d = await ws.execute('find -L /data/d -type d')
    expect(dec(d.stdout).trimEnd().split('\n')).toEqual(['/data/d', '/data/d/dlink', '/data/d/sub'])
    // Only a dangling link stays type l under -L.
    const l = await ws.execute('find -L /data/d -type l')
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
      await ws.execute(c)
    }
    const l = await ws.execute('find /data/d -type l')
    expect(dec(l.stdout).trimEnd().split('\n')).toEqual(['/data/d/dlink', '/data/d/flink'])
    const f = await ws.execute('find /data/d -type f')
    expect(dec(f.stdout).trimEnd().split('\n')).toEqual(['/data/d/real.txt'])
    await ws.close()
  })
})
