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

import { RAM_COMMANDS } from './index.ts'
import { describe, expect, it } from 'vitest'
import type { RegisteredCommand } from '../../config.ts'
import { materialize } from '../../../io/types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import type { LinkView } from '../../../ops/types.ts'
import { FileStat, FileType, LINK_TARGET_KEY, PathSpec } from '../../../types.ts'
import { CycleError } from '../../../utils/path.ts'
import { readTar } from '../tar_helper.ts'
import { UsageError } from '../../errors.ts'
const RAM_TAR = RAM_COMMANDS.filter((c) => c.name === 'tar' && c.filetype == null)
const RAM_ZIP = RAM_COMMANDS.filter((c) => c.name === 'zip' && c.filetype == null)
const RAM_UNZIP = RAM_COMMANDS.filter((c) => c.name === 'unzip' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

// An operand carrying the spelling the user typed, which is what the
// member names are built from.
function dirSpec(virtual: string, raw: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual,
    vfsPath: virtual.replace(/^\/+/, ''),
    resolved: true,
    rawPath: raw,
  })
}

// The namespace's symlink facts, as the dispatcher would offer them.
function linkView(entries: Record<string, string>, cycles = false): LinkView {
  const statOf = (path: string): FileStat =>
    new FileStat({
      name: path,
      type: FileType.SYMLINK,
      size: (entries[path] ?? '').length,
      extra: { [LINK_TARGET_KEY]: entries[path] ?? '' },
    })
  return {
    statAt: (p) => (p in entries ? statOf(p) : null),
    children: () => [],
    subtree: (dir) =>
      Object.keys(entries)
        .sort()
        .filter((k) => k.startsWith(rstrip(dir) + '/'))
        .map((k) => [k, statOf(k)] as [string, FileStat]),
    resolve: (p) => {
      // The namespace walks the chain under a hop limit and raises
      // ELOOP at the end of it; a real cycle never returns a target.
      if (cycles) throw new CycleError(p)
      return entries[p] ?? p
    },
    exists: (p) => Promise.resolve(p in entries),
    targetStat: () => Promise.resolve(null),
  }
}

function rstrip(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s
}

interface CmdResult {
  out: Uint8Array
  writes: Record<string, Uint8Array>
  exitCode: number
  stderr: Uint8Array
}

async function runCmd(
  reg: readonly RegisteredCommand[],
  vfs: RAMVFS,
  paths: PathSpec[],
  flags: Record<string, string | boolean | number | string[]>,
  texts: string[] = [],
  mountPrefix = '',
  links: LinkView | null = null,
): Promise<CmdResult> {
  const cmd = reg[0]
  if (cmd === undefined) throw new Error('not registered')
  const result = await cmd.fn(vfs.accessor, paths, texts, {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
    mountPrefix,
    ...(links !== null ? { ns: { links } } : {}),
  })
  if (result === null) {
    return { out: new Uint8Array(), writes: {}, exitCode: 0, stderr: new Uint8Array() }
  }
  const [output, io] = result as [
    unknown,
    { writes: Record<string, Uint8Array>; exitCode: number; stderr: Uint8Array | null },
  ]
  let outBytes: Uint8Array = new Uint8Array()
  if (output !== null) {
    outBytes =
      output instanceof Uint8Array ? output : await materialize(output as AsyncIterable<Uint8Array>)
  }
  return {
    out: outBytes,
    writes: io.writes,
    exitCode: io.exitCode,
    stderr: io.stderr ?? new Uint8Array(),
  }
}

describe('tar', () => {
  it('creates an archive and lists its contents', async () => {
    const vfs = new RAMVFS()
    vfs.store.files.set('/a.txt', ENC.encode('aaa'))
    vfs.store.files.set('/b.txt', ENC.encode('bbb'))
    await runCmd(RAM_TAR, vfs, [PathSpec.fromStrPath('/a.txt'), PathSpec.fromStrPath('/b.txt')], {
      c: true,
      f: '/archive.tar',
    })
    expect(vfs.store.files.has('/archive.tar')).toBe(true)
    const { out } = await runCmd(RAM_TAR, vfs, [], { t: true, f: '/archive.tar' })
    const decoded = DEC.decode(out)
    expect(decoded).toContain('a.txt')
    expect(decoded).toContain('b.txt')
  })

  it('extracts an archive back to files', async () => {
    const vfs = new RAMVFS()
    vfs.store.files.set('/a.txt', ENC.encode('content_a'))
    await runCmd(RAM_TAR, vfs, [PathSpec.fromStrPath('/a.txt')], {
      c: true,
      f: '/archive.tar',
    })
    vfs.store.files.delete('/a.txt')
    await runCmd(RAM_TAR, vfs, [], { x: true, f: '/archive.tar', C: '/' })
    expect(vfs.store.files.has('/a.txt')).toBe(true)
    expect(DEC.decode(vfs.store.files.get('/a.txt'))).toBe('content_a')
  })

  it('walks a directory operand instead of failing on it', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/d')
    vfs.store.dirs.add('/d/sub')
    vfs.store.files.set('/d/a.txt', ENC.encode('alpha'))
    vfs.store.files.set('/d/sub/b.txt', ENC.encode('beta'))
    const { exitCode, out } = await runCmd(RAM_TAR, vfs, [dirSpec('/d', 'd')], {
      c: true,
      v: true,
      f: '/out.tar',
    })
    expect(exitCode).toBe(0)
    expect(DEC.decode(out).trim().split('\n')).toEqual(['d/', 'd/a.txt', 'd/sub/', 'd/sub/b.txt'])
    const listed = await runCmd(RAM_TAR, vfs, [], { t: true, f: '/out.tar' })
    expect(DEC.decode(listed.out).trim().split('\n')).toEqual([
      'd/',
      'd/a.txt',
      'd/sub/',
      'd/sub/b.txt',
    ])
  })

  it('names members as the operand was typed, so -C survives a round trip', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/base')
    vfs.store.dirs.add('/base/d')
    vfs.store.files.set('/base/d/a.txt', ENC.encode('alpha'))
    await runCmd(RAM_TAR, vfs, [dirSpec('/base/d', 'd')], { c: true, f: '/out.tar' })
    const listed = await runCmd(RAM_TAR, vfs, [], { t: true, f: '/out.tar' })
    expect(DEC.decode(listed.out).trim().split('\n')).toEqual(['d/', 'd/a.txt'])
  })

  it('warns once about a stripped leading slash', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/d')
    vfs.store.files.set('/d/a.txt', ENC.encode('alpha'))
    const { stderr } = await runCmd(RAM_TAR, vfs, [dirSpec('/d', '/d')], {
      c: true,
      f: '/out.tar',
    })
    const text = DEC.decode(stderr)
    expect(text).toContain('Removing leading')
    expect(text.split('Removing leading').length - 1).toBe(1)
  })

  // GNU stores no traversal-bearing name: it drops everything through the
  // last `..` and names the prefix it dropped.
  it('drops a .. prefix from the member name and says which', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/d')
    vfs.store.dirs.add('/d/sub')
    vfs.store.files.set('/d/a.txt', ENC.encode('alpha'))
    const { stderr } = await runCmd(RAM_TAR, vfs, [dirSpec('/d/a.txt', '/d/sub/../a.txt')], {
      c: true,
      f: '/out.tar',
    })
    expect(DEC.decode(stderr)).toBe("tar: Removing leading `/d/sub/../' from member names\n")
    const listed = await runCmd(RAM_TAR, vfs, [], { t: true, f: '/out.tar' })
    expect(DEC.decode(listed.out).trim()).toBe('a.txt')
  })

  // GNU names the prefix before it reports the operand it could not read,
  // even though nothing under that operand is stored.
  it('announces a prefix it could not archive', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/d')
    vfs.store.dirs.add('/d/sub')
    const { stderr } = await runCmd(RAM_TAR, vfs, [dirSpec('/d/missing', 'sub/../missing')], {
      c: true,
      f: '/out.tar',
    })
    expect(DEC.decode(stderr).split('\n').slice(0, 2)).toEqual([
      "tar: Removing leading `sub/../' from member names",
      'tar: sub/../missing: Cannot stat: No such file or directory',
    ])
  })

  // A later operand's notice must not jump ahead of an earlier operand's
  // error: GNU emits diagnostics as it walks the operands.
  it('keeps notices in operand order', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/base')
    vfs.store.dirs.add('/base/sub')
    vfs.store.files.set('/base/file', ENC.encode('x'))
    const first = await runCmd(
      RAM_TAR,
      vfs,
      [dirSpec('/base/nope', 'nope'), dirSpec('/base/file', '../file')],
      { c: true, f: '/out.tar' },
    )
    expect(DEC.decode(first.stderr).split('\n').slice(0, 2)).toEqual([
      'tar: nope: Cannot stat: No such file or directory',
      "tar: Removing leading `../' from member names",
    ])
    const second = await runCmd(
      RAM_TAR,
      vfs,
      [dirSpec('/base/file', '../file'), dirSpec('/base/nope', 'nope')],
      { c: true, f: '/out2.tar' },
    )
    expect(DEC.decode(second.stderr).split('\n').slice(0, 2)).toEqual([
      "tar: Removing leading `../' from member names",
      'tar: nope: Cannot stat: No such file or directory',
    ])
  })

  it("reports a missing operand in tar's own words and exits 2", async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/d')
    vfs.store.files.set('/d/a.txt', ENC.encode('alpha'))
    const { exitCode, stderr } = await runCmd(
      RAM_TAR,
      vfs,
      [dirSpec('/nope', 'nope'), dirSpec('/d', 'd')],
      { c: true, f: '/out.tar' },
    )
    expect(exitCode).toBe(2)
    const text = DEC.decode(stderr)
    expect(text).toContain('tar: nope: Cannot stat: No such file or directory')
    expect(text).toContain('Exiting with failure status due to previous errors')
  })

  it('refuses to create an empty archive', async () => {
    const vfs = new RAMVFS()
    const { exitCode, stderr, writes } = await runCmd(RAM_TAR, vfs, [], {
      c: true,
      f: '/out.tar',
    })
    expect(exitCode).toBe(2)
    expect(DEC.decode(stderr)).toContain('Cowardly refusing to create an empty archive')
    expect(Object.keys(writes)).toHaveLength(0)
  })

  it('refuses a -C it cannot enter', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/d')
    vfs.store.files.set('/d/a.txt', ENC.encode('alpha'))
    const { exitCode, stderr, writes } = await runCmd(
      RAM_TAR,
      vfs,
      [dirSpec('/nodir/a.txt', 'a.txt')],
      { c: true, f: '/out.tar', C: '/nodir' },
    )
    expect(exitCode).toBe(2)
    const text = DEC.decode(stderr)
    expect(text).toContain('tar: /nodir: Cannot open: No such file or directory')
    expect(text).toContain('Error is not recoverable: exiting now')
    expect(Object.keys(writes)).toHaveLength(0)
  })

  it('--exclude prunes the whole subtree, and matches mid-path like GNU', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/d')
    vfs.store.dirs.add('/d/sub')
    vfs.store.files.set('/d/a.txt', ENC.encode('a'))
    vfs.store.files.set('/d/sub/b.txt', ENC.encode('b'))
    const pruned = await runCmd(RAM_TAR, vfs, [dirSpec('/d', 'd')], {
      c: true,
      f: '/out.tar',
      exclude: 'sub',
    })
    expect(pruned.exitCode).toBe(0)
    const listed = await runCmd(RAM_TAR, vfs, [], { t: true, f: '/out.tar' })
    expect(DEC.decode(listed.out).trim().split('\n')).toEqual(['d/', 'd/a.txt'])

    const one = await runCmd(RAM_TAR, vfs, [dirSpec('/d', 'd')], {
      c: true,
      f: '/two.tar',
      exclude: 'sub/b.txt',
    })
    expect(one.exitCode).toBe(0)
    const listedTwo = await runCmd(RAM_TAR, vfs, [], { t: true, f: '/two.tar' })
    expect(DEC.decode(listedTwo.out).trim().split('\n')).toEqual(['d/', 'd/a.txt', 'd/sub/'])
  })

  it('round-trips an empty directory through create and extract', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/d')
    vfs.store.dirs.add('/d/empty')
    vfs.store.files.set('/d/a.txt', ENC.encode('a'))
    await runCmd(RAM_TAR, vfs, [dirSpec('/d', 'd')], { c: true, f: '/out.tar' })
    const listed = await runCmd(RAM_TAR, vfs, [], { t: true, f: '/out.tar' })
    expect(DEC.decode(listed.out)).toContain('d/empty/')
    await runCmd(RAM_TAR, vfs, [], { x: true, f: '/out.tar', C: '/out' })
    expect(vfs.store.dirs.has('/out/d/empty')).toBe(true)
  })

  it('names members from virtual paths on a prefixed mount', async () => {
    // The walk answers in mount-relative keys, the way a backend's own
    // find op does; a mount behind a prefix is the only place where
    // forgetting to lift them back shows up.
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/tdir')
    vfs.store.dirs.add('/tdir/sub')
    vfs.store.files.set('/tdir/a.txt', ENC.encode('aa'))
    vfs.store.files.set('/tdir/sub/b.txt', ENC.encode('bb'))
    const operand = new PathSpec({
      virtual: '/data/tdir',
      directory: '/data/tdir',
      vfsPath: 'tdir',
      resolved: true,
      rawPath: 'tdir',
    })
    const { out, exitCode } = await runCmd(
      RAM_TAR,
      vfs,
      [operand],
      { c: true, v: true, f: '/tdir.tar' },
      [],
      '/data',
    )
    expect(exitCode).toBe(0)
    expect(DEC.decode(out).trim().split('\n')).toEqual([
      'tdir/',
      'tdir/a.txt',
      'tdir/sub/',
      'tdir/sub/b.txt',
    ])
  })

  it('leaves the archive out of itself', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/d')
    vfs.store.files.set('/d/a.txt', ENC.encode('a'))
    vfs.store.files.set('/d/old.tar', ENC.encode('stale'))
    const { stderr } = await runCmd(RAM_TAR, vfs, [dirSpec('/d', 'd')], {
      c: true,
      f: '/d/old.tar',
    })
    expect(DEC.decode(stderr)).toContain('archive cannot contain itself')
    const listed = await runCmd(RAM_TAR, vfs, [], { t: true, f: '/d/old.tar' })
    expect(DEC.decode(listed.out).trim().split('\n')).toEqual(['d/', 'd/a.txt'])
  })
})

describe('zip / unzip', () => {
  it('zip then unzip -l lists the archived file', async () => {
    const vfs = new RAMVFS()
    vfs.store.files.set('/a.txt', ENC.encode('hello'))
    await runCmd(
      RAM_ZIP,
      vfs,
      [PathSpec.fromStrPath('/out.zip'), PathSpec.fromStrPath('/a.txt')],
      {},
    )
    expect(vfs.store.files.has('/out.zip')).toBe(true)
    const { out } = await runCmd(RAM_UNZIP, vfs, [PathSpec.fromStrPath('/out.zip')], {
      args_l: true,
    })
    expect(DEC.decode(out)).toContain('a.txt')
  })

  it('zip then unzip -d round trip restores file contents', async () => {
    const vfs = new RAMVFS()
    vfs.store.files.set('/a.txt', ENC.encode('zip_content'))
    await runCmd(
      RAM_ZIP,
      vfs,
      [PathSpec.fromStrPath('/out.zip'), PathSpec.fromStrPath('/a.txt')],
      {},
    )
    vfs.store.files.delete('/a.txt')
    await runCmd(RAM_UNZIP, vfs, [PathSpec.fromStrPath('/out.zip')], { d: '/' })
    expect(vfs.store.files.has('/a.txt')).toBe(true)
    expect(DEC.decode(vfs.store.files.get('/a.txt'))).toBe('zip_content')
  })

  it('zip -j junks paths, keeping only basename', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/sub')
    vfs.store.files.set('/sub/deep.txt', ENC.encode('hello'))
    await runCmd(
      RAM_ZIP,
      vfs,
      [PathSpec.fromStrPath('/out.zip'), PathSpec.fromStrPath('/sub/deep.txt')],
      { j: true },
    )
    const { out } = await runCmd(RAM_UNZIP, vfs, [PathSpec.fromStrPath('/out.zip')], {
      args_l: true,
    })
    const text = DEC.decode(out)
    expect(text).toContain('deep.txt')
    expect(text).not.toContain('sub/')
  })

  it('zip -q suppresses stdout', async () => {
    const vfs = new RAMVFS()
    vfs.store.files.set('/a.txt', ENC.encode('hello'))
    const { out } = await runCmd(
      RAM_ZIP,
      vfs,
      [PathSpec.fromStrPath('/out.zip'), PathSpec.fromStrPath('/a.txt')],
      { q: true },
    )
    expect(out.byteLength).toBe(0)
  })

  it('zip -r walks a directory operand instead of failing on it', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/d')
    vfs.store.dirs.add('/d/sub')
    vfs.store.dirs.add('/d/empty')
    vfs.store.files.set('/d/a.txt', ENC.encode('alpha'))
    vfs.store.files.set('/d/sub/b.txt', ENC.encode('beta'))
    const { out, exitCode } = await runCmd(
      RAM_ZIP,
      vfs,
      [PathSpec.fromStrPath('/out.zip'), dirSpec('/d', 'd')],
      { r: true },
    )
    expect(exitCode).toBe(0)
    expect(DEC.decode(out)).toBe(
      '  adding: d/\n  adding: d/a.txt\n  adding: d/empty/\n  adding: d/sub/\n  adding: d/sub/b.txt\n',
    )
  })

  it('zip without -r stores the directory entry and nothing under it', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/d')
    vfs.store.files.set('/d/a.txt', ENC.encode('alpha'))
    const { out } = await runCmd(
      RAM_ZIP,
      vfs,
      [PathSpec.fromStrPath('/out.zip'), dirSpec('/d', 'd')],
      {},
    )
    expect(DEC.decode(out)).toBe('  adding: d/\n')
  })

  it('zip -r then unzip restores an empty directory', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/d')
    vfs.store.dirs.add('/d/empty')
    vfs.store.files.set('/d/a.txt', ENC.encode('alpha'))
    await runCmd(RAM_ZIP, vfs, [PathSpec.fromStrPath('/out.zip'), dirSpec('/d', 'd')], {
      r: true,
      q: true,
    })
    vfs.store.dirs.delete('/d/empty')
    vfs.store.files.delete('/d/a.txt')
    await runCmd(RAM_UNZIP, vfs, [PathSpec.fromStrPath('/out.zip')], { d: '/', q: true })
    expect(vfs.store.dirs.has('/d/empty')).toBe(true)
    expect(DEC.decode(vfs.store.files.get('/d/a.txt'))).toBe('alpha')
  })

  it('zip -r -j drops directory entries entirely', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/d')
    vfs.store.dirs.add('/d/sub')
    vfs.store.files.set('/d/a.txt', ENC.encode('alpha'))
    vfs.store.files.set('/d/sub/b.txt', ENC.encode('beta'))
    const { out } = await runCmd(
      RAM_ZIP,
      vfs,
      [PathSpec.fromStrPath('/out.zip'), dirSpec('/d', 'd')],
      { r: true, j: true },
    )
    expect(DEC.decode(out)).toBe('  adding: a.txt\n  adding: b.txt\n')
  })

  it('zip -x is anchored on the whole stored name', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/d')
    vfs.store.dirs.add('/d/sub')
    vfs.store.files.set('/d/a.txt', ENC.encode('alpha'))
    vfs.store.files.set('/d/sub/b.txt', ENC.encode('beta'))
    const { out } = await runCmd(
      RAM_ZIP,
      vfs,
      [PathSpec.fromStrPath('/out.zip'), dirSpec('/d', 'd')],
      { r: true, x: ['d/sub/*'] },
    )
    expect(DEC.decode(out)).toBe('  adding: d/\n  adding: d/a.txt\n')
  })

  it("warns in Info-ZIP's words on a name it cannot match, and archives the rest", async () => {
    const vfs = new RAMVFS()
    vfs.store.files.set('/a.txt', ENC.encode('alpha'))
    const { exitCode, stderr } = await runCmd(
      RAM_ZIP,
      vfs,
      [PathSpec.fromStrPath('/out.zip'), dirSpec('/a.txt', 'a.txt'), dirSpec('/nope', 'nope')],
      {},
    )
    expect(exitCode).toBe(0)
    expect(DEC.decode(stderr)).toBe('\tzip warning: name not matched: nope\n')
    expect(vfs.store.files.has('/out.zip')).toBe(true)
  })

  it('writes no archive and exits 12 when nothing matched', async () => {
    const vfs = new RAMVFS()
    const { exitCode, stderr } = await runCmd(
      RAM_ZIP,
      vfs,
      [dirSpec('/out.zip', 'out.zip'), dirSpec('/nope', 'nope')],
      {},
    )
    expect(exitCode).toBe(12)
    expect(vfs.store.files.has('/out.zip')).toBe(false)
    expect(DEC.decode(stderr)).toBe(
      '\tzip warning: name not matched: nope\n\nzip error: Nothing to do! (out.zip)\n',
    )
  })

  it('-q silences the warning but never the fatal error', async () => {
    const vfs = new RAMVFS()
    const { exitCode, stderr } = await runCmd(
      RAM_ZIP,
      vfs,
      [dirSpec('/out.zip', 'out.zip'), dirSpec('/nope', 'nope')],
      { q: true },
    )
    expect(exitCode).toBe(12)
    expect(DEC.decode(stderr)).toBe('\nzip error: Nothing to do! (out.zip)\n')
  })

  it('names members from virtual paths on a prefixed mount', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/d')
    vfs.store.files.set('/d/a.txt', ENC.encode('alpha'))
    const operand = new PathSpec({
      virtual: '/data/d',
      directory: '/data/d',
      vfsPath: 'd',
      resolved: true,
      rawPath: '/data/d',
    })
    const archive = new PathSpec({
      virtual: '/data/out.zip',
      directory: '/data',
      vfsPath: 'out.zip',
      resolved: true,
      rawPath: '/data/out.zip',
    })
    const { out } = await runCmd(RAM_ZIP, vfs, [archive, operand], { r: true }, [], '/data')
    expect(DEC.decode(out)).toBe('  adding: data/d/\n  adding: data/d/a.txt\n')
  })
  // Pinned against Info-ZIP 3.0 on debian:stable-slim.
  it('zip -r of . stores its contents at the archive root', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/d')
    vfs.store.dirs.add('/d/sub')
    vfs.store.files.set('/d/[Content_Types].xml', ENC.encode('x'))
    vfs.store.files.set('/d/sub/b.txt', ENC.encode('beta'))
    const { out } = await runCmd(
      RAM_ZIP,
      vfs,
      [PathSpec.fromStrPath('/out.zip'), dirSpec('/d', '.')],
      { r: true },
    )
    expect(DEC.decode(out)).toBe(
      '  adding: [Content_Types].xml\n  adding: sub/\n  adding: sub/b.txt\n',
    )
  })

  it('strips only the leading ./ run, from names and -x patterns', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/d')
    vfs.store.dirs.add('/d/sub')
    vfs.store.files.set('/d/a.txt', ENC.encode('alpha'))
    vfs.store.files.set('/d/sub/b.txt', ENC.encode('beta'))
    const { out } = await runCmd(
      RAM_ZIP,
      vfs,
      [
        PathSpec.fromStrPath('/out.zip'),
        dirSpec('/d/a.txt', '././a.txt'),
        dirSpec('/d/sub', 'sub/.'),
        dirSpec('/d/sub/b.txt', './sub/b.txt'),
      ],
      { r: true, x: ['./sub/b.txt'] },
    )
    expect(DEC.decode(out)).toBe('  adding: a.txt\n  adding: sub/./\n  adding: sub/./b.txt\n')
  })

  it('zip of . without -r has nothing to do', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/d')
    vfs.store.files.set('/d/a.txt', ENC.encode('alpha'))
    const { exitCode, stderr } = await runCmd(
      RAM_ZIP,
      vfs,
      [dirSpec('/out.zip', 'out.zip'), dirSpec('/d', '.')],
      {},
    )
    expect(exitCode).toBe(12)
    expect(DEC.decode(stderr)).toBe('\nzip error: Nothing to do! (out.zip)\n')
  })

  it('stores one path named twice once', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/d')
    vfs.store.files.set('/d/a.txt', ENC.encode('alpha'))
    const { out, exitCode } = await runCmd(
      RAM_ZIP,
      vfs,
      [
        PathSpec.fromStrPath('/out.zip'),
        dirSpec('/d', '.'),
        dirSpec('/d/a.txt', 'a.txt'),
        dirSpec('/d/a.txt', 'a.txt'),
      ],
      { r: true },
    )
    expect(exitCode).toBe(0)
    expect(DEC.decode(out)).toBe('  adding: a.txt\n')
  })

  it('refuses two paths that store under one name', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/d')
    vfs.store.files.set('/d/a.txt', ENC.encode('alpha'))
    const { exitCode, stderr } = await runCmd(
      RAM_ZIP,
      vfs,
      [
        dirSpec('/out.zip', 'out.zip'),
        dirSpec('/d/a.txt', './a.txt'),
        dirSpec('/d/a.txt', 'a.txt'),
      ],
      {},
    )
    expect(exitCode).toBe(16)
    expect(vfs.store.files.has('/out.zip')).toBe(false)
    expect(DEC.decode(stderr)).toBe(
      '\tzip warning:   first full name: ./a.txt\n' +
        '                      second full name: a.txt\n' +
        '                     name in zip file repeated: a.txt\n' +
        '\nzip error: Invalid command arguments (cannot repeat names in zip file)\n',
    )
  })

  it('names -j as the cause of a repeated name, and -q keeps only the error', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/d')
    vfs.store.dirs.add('/d/sub')
    vfs.store.files.set('/d/a.txt', ENC.encode('alpha'))
    vfs.store.files.set('/d/sub/a.txt', ENC.encode('again'))
    const paths = [
      dirSpec('/out.zip', 'out.zip'),
      dirSpec('/d/sub/a.txt', 'sub/a.txt'),
      dirSpec('/d/a.txt', 'a.txt'),
    ]
    const loud = await runCmd(RAM_ZIP, vfs, paths, { j: true })
    expect(loud.exitCode).toBe(16)
    expect(DEC.decode(loud.stderr)).toContain(
      '                     name in zip file repeated: a.txt\n' +
        '                     this may be a result of using -j\n',
    )
    const quiet = await runCmd(RAM_ZIP, vfs, paths, { j: true, q: true })
    expect(quiet.exitCode).toBe(16)
    expect(DEC.decode(quiet.stderr)).toBe(
      '\nzip error: Invalid command arguments (cannot repeat names in zip file)\n',
    )
  })
})

describe('unzip members', () => {
  const APP = 'APPXML-CONTENT\n'
  const SHEET = 'SHEET1-CONTENT\n'
  const WORKBOOK = 'WORKBOOK-CONTENT\n'
  const CAUTION = 'caution: filename not matched:  '

  async function makeBook(): Promise<RAMVFS> {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/docProps')
    vfs.store.dirs.add('/xl')
    vfs.store.files.set('/docProps/app.xml', ENC.encode(APP))
    vfs.store.files.set('/xl/sheet1.xml', ENC.encode(SHEET))
    vfs.store.files.set('/xl/workbook.xml', ENC.encode(WORKBOOK))
    await runCmd(
      RAM_ZIP,
      vfs,
      [
        PathSpec.fromStrPath('/book.zip'),
        PathSpec.fromStrPath('/docProps/app.xml'),
        PathSpec.fromStrPath('/xl/sheet1.xml'),
        PathSpec.fromStrPath('/xl/workbook.xml'),
      ],
      {},
    )
    return vfs
  }

  function book(): PathSpec[] {
    return [PathSpec.fromStrPath('/book.zip')]
  }

  it('-p with a member outputs only that member', async () => {
    const vfs = await makeBook()
    const r = await runCmd(RAM_UNZIP, vfs, book(), { p: true }, ['xl/workbook.xml'])
    expect(DEC.decode(r.out)).toBe(WORKBOOK)
    expect(r.exitCode).toBe(0)
    expect(r.stderr.byteLength).toBe(0)
  })

  it('-p with a missing member exits 11 with a caution on stderr', async () => {
    const vfs = await makeBook()
    const r = await runCmd(RAM_UNZIP, vfs, book(), { p: true }, ['NOSUCHFILE.xml'])
    expect(r.out.byteLength).toBe(0)
    expect(r.exitCode).toBe(11)
    expect(DEC.decode(r.stderr)).toBe(`${CAUTION}NOSUCHFILE.xml\n`)
  })

  it('-p output follows archive order, not argument order', async () => {
    const vfs = await makeBook()
    const r = await runCmd(RAM_UNZIP, vfs, book(), { p: true }, [
      'xl/workbook.xml',
      'docProps/app.xml',
    ])
    expect(DEC.decode(r.out)).toBe(APP + WORKBOOK)
    expect(r.exitCode).toBe(0)
  })

  it('-p charges each entry to the first matching spec', async () => {
    const vfs = await makeBook()
    const r = await runCmd(RAM_UNZIP, vfs, book(), { p: true }, ['*.xml', 'xl/workbook.xml'])
    expect(DEC.decode(r.out)).toBe(APP + SHEET + WORKBOOK)
    expect(r.exitCode).toBe(11)
    expect(DEC.decode(r.stderr)).toBe(`${CAUTION}xl/workbook.xml\n`)
  })

  it('-p wildcard star crosses slashes', async () => {
    const vfs = await makeBook()
    const r = await runCmd(RAM_UNZIP, vfs, book(), { p: true }, ['doc*'])
    expect(DEC.decode(r.out)).toBe(APP)
    expect(r.exitCode).toBe(0)
  })

  it('-p wildcard selects a subtree', async () => {
    const vfs = await makeBook()
    const r = await runCmd(RAM_UNZIP, vfs, book(), { p: true }, ['xl/*'])
    expect(DEC.decode(r.out)).toBe(SHEET + WORKBOOK)
    expect(r.exitCode).toBe(0)
  })

  it('-p treats ? as one byte, the way Info-ZIP does', async () => {
    const vfs = new RAMVFS()
    vfs.store.files.set('/é.txt', ENC.encode('ACCENT\n'))
    vfs.store.files.set('/ab.txt', ENC.encode('AB\n'))
    await runCmd(
      RAM_ZIP,
      vfs,
      [
        PathSpec.fromStrPath('/bytes.zip'),
        PathSpec.fromStrPath('/é.txt'),
        PathSpec.fromStrPath('/ab.txt'),
      ],
      {},
    )
    const arch = [PathSpec.fromStrPath('/bytes.zip')]
    const one = await runCmd(RAM_UNZIP, vfs, arch, { p: true }, ['?.txt'])
    expect(one.out.byteLength).toBe(0)
    expect(one.exitCode).toBe(11)
    expect(DEC.decode(one.stderr)).toBe(`${CAUTION}?.txt\n`)
    const two = await runCmd(RAM_UNZIP, vfs, arch, { p: true }, ['??.txt'])
    expect(DEC.decode(two.out)).toBe('ACCENT\nAB\n')
    expect(two.exitCode).toBe(0)
  })

  it('-l filters rows and exits 11 only when nothing matched', async () => {
    const vfs = await makeBook()
    const hit = await runCmd(RAM_UNZIP, vfs, book(), { args_l: true }, ['xl/workbook.xml'])
    expect(DEC.decode(hit.out)).toContain('xl/workbook.xml')
    expect(DEC.decode(hit.out)).not.toContain('docProps/app.xml')
    expect(hit.exitCode).toBe(0)
    const miss = await runCmd(RAM_UNZIP, vfs, book(), { args_l: true }, ['NOSUCHFILE.xml'])
    expect(miss.exitCode).toBe(11)
    expect(miss.stderr.byteLength).toBe(0)
    const partial = await runCmd(RAM_UNZIP, vfs, book(), { args_l: true }, [
      'xl/workbook.xml',
      'NOSUCHFILE.xml',
    ])
    expect(partial.exitCode).toBe(0)
    expect(partial.stderr.byteLength).toBe(0)
  })

  it('-t reports unmatched members on stdout and exits 11', async () => {
    const vfs = await makeBook()
    const r = await runCmd(RAM_UNZIP, vfs, book(), { t: true }, [
      'xl/workbook.xml',
      'NOSUCHFILE.xml',
    ])
    const text = DEC.decode(r.out)
    expect(text).toContain(`${CAUTION}NOSUCHFILE.xml`)
    expect(text).toContain('At least one error was detected')
    expect(r.exitCode).toBe(11)
    expect(r.stderr.byteLength).toBe(0)
  })

  it('extraction writes only the selected members', async () => {
    const vfs = await makeBook()
    const r = await runCmd(RAM_UNZIP, vfs, book(), { d: '/ext' }, [
      'xl/workbook.xml',
      'NOSUCHFILE.xml',
    ])
    expect(vfs.store.files.has('/ext/xl/workbook.xml')).toBe(true)
    expect(vfs.store.files.has('/ext/docProps/app.xml')).toBe(false)
    expect(r.exitCode).toBe(11)
    expect(DEC.decode(r.stderr)).toBe(`${CAUTION}NOSUCHFILE.xml\n`)
  })
})

describe('archive planner regressions', () => {
  it('two links to one target are not a loop', async () => {
    // GNU tar -h and Info-ZIP both store the two names.
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/d')
    vfs.store.files.set('/d/a.txt', ENC.encode('alpha'))
    const links = linkView({ '/d/one': '/d/a.txt', '/d/two': '/d/a.txt' })
    const { out, exitCode, stderr } = await runCmd(
      RAM_TAR,
      vfs,
      [dirSpec('/d', 'd')],
      { c: true, h: true, v: true, f: '/out.tar' },
      [],
      '',
      links,
    )
    expect(exitCode).toBe(0)
    expect(DEC.decode(stderr)).toBe('')
    expect(DEC.decode(out).trim().split('\n')).toEqual(['d/', 'd/a.txt', 'd/one', 'd/two'])
  })

  it('a real cycle is one fatal problem per member and keeps the directory', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/d')
    const links = linkView({ '/d/a': '/d/b', '/d/b': '/d/a' }, true)
    const { exitCode, stderr } = await runCmd(
      RAM_TAR,
      vfs,
      [dirSpec('/d', 'd')],
      { c: true, h: true, f: '/out.tar' },
      [],
      '',
      links,
    )
    expect(exitCode).toBe(2)
    const text = DEC.decode(stderr)
    expect(text).toContain('tar: d/a: Cannot stat: Too many levels of symbolic links')
    expect(text).toContain('tar: d/b: Cannot stat: Too many levels of symbolic links')
  })

  it('stores a symlink operand as a symlink rather than its target', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/d')
    vfs.store.files.set('/d/a.txt', ENC.encode('alpha'))
    const links = linkView({ '/link': '/d/a.txt' })
    const { out } = await runCmd(
      RAM_TAR,
      vfs,
      [dirSpec('/link', 'link')],
      { c: true, v: true, f: '/out.tar' },
      [],
      '',
      links,
    )
    expect(DEC.decode(out).trim()).toBe('link')
    const { out: listed } = await runCmd(RAM_TAR, vfs, [], { t: true, f: '/out.tar' })
    expect(DEC.decode(listed).trim()).toBe('link')
  })

  it('stores a symlink operand with its target and no bytes', async () => {
    // The name alone cannot tell the two apart, so read the archive back:
    // a link member carries linkname and no content.
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/d')
    vfs.store.files.set('/d/a.txt', ENC.encode('alpha'))
    const links = linkView({ '/link': '/d/a.txt' })
    const { writes } = await runCmd(
      RAM_TAR,
      vfs,
      [dirSpec('/link', 'link')],
      { c: true, f: '/out.tar' },
      [],
      '',
      links,
    )
    const entries = await readTar(writes['/out.tar'] ?? new Uint8Array(0))
    expect(entries).toHaveLength(1)
    expect(entries[0]?.name).toBe('link')
    expect(entries[0]?.linkname).toBe('/d/a.txt')
    expect(entries[0]?.isFile).toBe(false)
    expect(entries[0]?.data.byteLength).toBe(0)
  })

  it('-h stores the target bytes under the link name', async () => {
    // GNU tar -h follows the link, so the member keeps the link's name but
    // becomes a regular file holding what the target holds.
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/d')
    vfs.store.files.set('/d/a.txt', ENC.encode('alpha'))
    const links = linkView({ '/link': '/d/a.txt' })
    const { writes } = await runCmd(
      RAM_TAR,
      vfs,
      [dirSpec('/link', 'link')],
      { c: true, h: true, f: '/out.tar' },
      [],
      '',
      links,
    )
    const entries = await readTar(writes['/out.tar'] ?? new Uint8Array(0))
    expect(entries).toHaveLength(1)
    expect(entries[0]?.name).toBe('link')
    expect(entries[0]?.isFile).toBe(true)
    expect(entries[0]?.linkname).toBe('')
    expect(DEC.decode(entries[0]?.data)).toBe('alpha')
  })

  it('-h on a link whose target is gone reports it and writes no member', async () => {
    const vfs = new RAMVFS()
    const links = linkView({ '/link': '/d/missing.txt' })
    const { exitCode, stderr } = await runCmd(
      RAM_TAR,
      vfs,
      [dirSpec('/link', 'link')],
      { c: true, h: true, f: '/out.tar' },
      [],
      '',
      links,
    )
    expect(exitCode).toBe(2)
    expect(DEC.decode(stderr)).toContain('No such file or directory')
  })

  it('fails at the first unenterable -C, not the last', async () => {
    // GNU chdirs at each -C, so a bad early one stops the whole run.
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/good')
    vfs.store.files.set('/good/y.txt', ENC.encode('y'))
    const { exitCode, stderr } = await runCmd(RAM_TAR, vfs, [dirSpec('/good/y.txt', 'y.txt')], {
      c: true,
      f: '/out.tar',
      C: ['/missing', '/good'],
    })
    expect(exitCode).toBe(2)
    const text = DEC.decode(stderr)
    expect(text).toContain('tar: /missing: Cannot open: No such file or directory')
    expect(text).toContain('Error is not recoverable')
    expect(vfs.store.files.has('/out.tar')).toBe(false)
  })
})

describe('unzip archive validation', () => {
  const PLAIN = ENC.encode('plain text')
  const NO_EOCD =
    '  End-of-central-directory signature not found.  Either this file is not\n' +
    '  a zipfile, or it constitutes one disk of a multi-part archive.  In the\n' +
    '  latter case the central directory and zipfile comment will be found on\n' +
    '  the last disk(s) of this archive.\n'

  function plainVfs(bytes: Uint8Array = PLAIN): RAMVFS {
    const vfs = new RAMVFS()
    vfs.store.files.set('/a.zip', bytes)
    return vfs
  }

  function archive(): PathSpec[] {
    return [PathSpec.fromStrPath('/a.zip')]
  }

  it('refuses plain text as no archive, in unzip voice', async () => {
    const r = await runCmd(RAM_UNZIP, plainVfs(), archive(), { args_l: true })
    expect(r.exitCode).toBe(9)
    expect(r.out.byteLength).toBe(0)
    expect(DEC.decode(r.stderr)).toBe(
      NO_EOCD +
        'unzip:  cannot find zipfile directory in one of /a.zip or\n' +
        '        /a.zip.zip, and cannot find /a.zip.ZIP, period.\n',
    )
  })

  it('refuses an empty file as no archive', async () => {
    const r = await runCmd(RAM_UNZIP, plainVfs(new Uint8Array()), archive(), {})
    expect(r.exitCode).toBe(9)
    expect(DEC.decode(r.stderr)).toContain('End-of-central-directory signature not found')
  })

  it('-p names the archive above the paragraph and does not sign', async () => {
    const r = await runCmd(RAM_UNZIP, plainVfs(), archive(), { p: true })
    expect(r.exitCode).toBe(9)
    expect(DEC.decode(r.stderr)).toBe('[/a.zip]\n' + NO_EOCD)
  })

  it('-Z signs the refusal as zipinfo', async () => {
    const r = await runCmd(RAM_UNZIP, plainVfs(), archive(), { Z: true, args_1: true })
    expect(r.exitCode).toBe(9)
    expect(DEC.decode(r.stderr)).toBe(
      '[/a.zip]\n' +
        NO_EOCD +
        'zipinfo:  cannot find zipfile directory in one of /a.zip or\n' +
        '          /a.zip.zip, and cannot find /a.zip.ZIP, period.\n',
    )
  })

  it('a clobbered central directory exits 3', async () => {
    const vfs = await makeMulti()
    const bytes = vfs.store.files.get('/m.zip')
    if (bytes === undefined) throw new Error('no archive')
    const bad = bytes.slice()
    const at = findSig(bad, [0x50, 0x4b, 0x01, 0x02])
    bad.set([0x58, 0x58, 0x58, 0x58], at)
    vfs.store.files.set('/m.zip', bad)
    const r = await runCmd(RAM_UNZIP, vfs, [PathSpec.fromStrPath('/m.zip')], { args_l: true })
    expect(r.exitCode).toBe(3)
    expect(DEC.decode(r.stderr)).toBe(
      'error [/m.zip]:  start of central directory not found;\n' +
        '  zipfile corrupt.\n' +
        '  (please check that you have transferred or created the zipfile in the\n' +
        '  appropriate BINARY mode and that you have compiled UnZip properly)\n',
    )
  })

  it('an entry reaching past the directory exits 3', async () => {
    const vfs = await makeMulti()
    const bytes = vfs.store.files.get('/m.zip')
    if (bytes === undefined) throw new Error('no archive')
    const bad = bytes.slice()
    const at = findSig(bad, [0x50, 0x4b, 0x01, 0x02])
    bad.set([0xff, 0xff], at + 28)
    vfs.store.files.set('/m.zip', bad)
    const r = await runCmd(RAM_UNZIP, vfs, [PathSpec.fromStrPath('/m.zip')], { args_l: true })
    expect(r.exitCode).toBe(3)
    expect(DEC.decode(r.stderr)).toContain('start of central directory not found')
  })

  it('an entry count short of the directory exits 3', async () => {
    const vfs = await makeMulti()
    const bytes = vfs.store.files.get('/m.zip')
    if (bytes === undefined) throw new Error('no archive')
    const bad = bytes.slice()
    const at = findSig(bad, [0x50, 0x4b, 0x05, 0x06])
    bad.set([0x02, 0x00], at + 10)
    vfs.store.files.set('/m.zip', bad)
    const r = await runCmd(RAM_UNZIP, vfs, [PathSpec.fromStrPath('/m.zip')], { Z: true })
    expect(r.exitCode).toBe(3)
    expect(DEC.decode(r.stderr)).toContain('start of central directory not found')
  })

  it('bytes before the archive shift every offset, and it lists with a warning', async () => {
    const vfs = await makeMulti()
    const bytes = vfs.store.files.get('/m.zip')
    if (bytes === undefined) throw new Error('no archive')
    const stub = ENC.encode('#!/bin/sh\n')
    const prefixed = new Uint8Array(stub.byteLength + bytes.byteLength)
    prefixed.set(stub, 0)
    prefixed.set(bytes, stub.byteLength)
    vfs.store.files.set('/m.zip', prefixed)
    const warning =
      'warning [/m.zip]:  10 extra bytes at beginning or within zipfile\n  (attempting to process anyway)\n'
    const listed = await runCmd(RAM_UNZIP, vfs, [PathSpec.fromStrPath('/m.zip')], {
      Z: true,
      args_1: true,
    })
    expect(DEC.decode(listed.out)).toBe('d/\nd/a.txt\nb.txt\n')
    expect(listed.exitCode).toBe(1)
    expect(DEC.decode(listed.stderr)).toBe(warning)
    const piped = await runCmd(RAM_UNZIP, vfs, [PathSpec.fromStrPath('/m.zip')], { p: true }, [
      'b.txt',
    ])
    expect(DEC.decode(piped.out)).toBe('b')
    expect(piped.exitCode).toBe(1)
    const missed = await runCmd(RAM_UNZIP, vfs, [PathSpec.fromStrPath('/m.zip')], { p: true }, [
      'nomatch',
    ])
    expect(missed.exitCode).toBe(11)
    expect(DEC.decode(missed.stderr)).toBe(warning + 'caution: filename not matched:  nomatch\n')
  })

  it('an end record pointing past the directory is a missing-bytes error that still lists', async () => {
    const vfs = await makeMulti()
    const bytes = vfs.store.files.get('/m.zip')
    if (bytes === undefined) throw new Error('no archive')
    const patched = bytes.slice()
    const at = findSig(patched, [0x50, 0x4b, 0x05, 0x06])
    const view = new DataView(patched.buffer, patched.byteOffset)
    view.setUint32(at + 16, view.getUint32(at + 16, true) + 3, true)
    vfs.store.files.set('/m.zip', patched)
    const r = await runCmd(RAM_UNZIP, vfs, [PathSpec.fromStrPath('/m.zip')], {
      Z: true,
      args_1: true,
    })
    expect(DEC.decode(r.out)).toBe('d/\nd/a.txt\nb.txt\n')
    expect(r.exitCode).toBe(2)
    expect(DEC.decode(r.stderr)).toBe(
      'error [/m.zip]:  missing 3 bytes in zipfile\n  (attempting to process anyway)\n',
    )
  })
})

function findSig(bytes: Uint8Array, sig: number[]): number {
  outer: for (let i = 0; i + sig.length <= bytes.byteLength; i++) {
    for (let j = 0; j < sig.length; j++) if (bytes[i + j] !== sig[j]) continue outer
    return i
  }
  throw new Error('signature not found')
}

// d/ (empty dir entry), d/a.txt (200 bytes) and b.txt (1 byte), zipped by
// mirage: 1980-01-01 stamps and 0644/40755 modes, so every row is pinned.
async function makeMulti(): Promise<RAMVFS> {
  const vfs = new RAMVFS()
  vfs.store.dirs.add('/d')
  vfs.store.files.set('/d/a.txt', ENC.encode('a'.repeat(200)))
  vfs.store.files.set('/b.txt', ENC.encode('b'))
  await runCmd(
    RAM_ZIP,
    vfs,
    [PathSpec.fromStrPath('/m.zip'), dirSpec('/d', 'd'), PathSpec.fromStrPath('/b.txt')],
    { r: true },
  )
  return vfs
}

describe('unzip -Z (zipinfo mode)', () => {
  const M = [PathSpec.fromStrPath('/m.zip')]

  it('-Z1 lists names only, whatever -h and -t say', async () => {
    const vfs = await makeMulti()
    const r = await runCmd(RAM_UNZIP, vfs, M, { Z: true, args_1: true, h: true, t: true })
    expect(DEC.decode(r.out)).toBe('d/\nd/a.txt\nb.txt\n')
    expect(r.exitCode).toBe(0)
    expect(r.stderr.byteLength).toBe(0)
  })

  it('-Z prints the header, the rows and the totals', async () => {
    const vfs = await makeMulti()
    const size = vfs.store.files.get('/m.zip')?.byteLength ?? 0
    const r = await runCmd(RAM_UNZIP, vfs, M, { Z: true })
    const lines = DEC.decode(r.out).split('\n')
    expect(lines.slice(0, 5)).toEqual([
      'Archive:  /m.zip',
      `Zip file size: ${String(size)} bytes, number of entries: 3`,
      'drwxr-xr-x  2.0 unx        0 b- stor 80-Jan-01 00:00 d/',
      '-rw-r--r--  2.0 unx      200 b- defN 80-Jan-01 00:00 d/a.txt',
      '-rw-r--r--  2.0 unx        1 b- defN 80-Jan-01 00:00 b.txt',
    ])
    expect(lines[5]).toMatch(
      /^3 files, 201 bytes uncompressed, \d+ bytes compressed: {2}-?\d+\.\d%$/,
    )
    expect(lines[6]).toBe('')
  })

  it('-Zl adds the compressed size column', async () => {
    const vfs = await makeMulti()
    const r = await runCmd(RAM_UNZIP, vfs, M, { Z: true, args_l: true }, ['d/'])
    expect(DEC.decode(r.out)).toBe(
      'drwxr-xr-x  2.0 unx        0 b-        0 stor 80-Jan-01 00:00 d/\n',
    )
  })

  it('-Zh and -Zt alone print only that line', async () => {
    const vfs = await makeMulti()
    const size = vfs.store.files.get('/m.zip')?.byteLength ?? 0
    const h = await runCmd(RAM_UNZIP, vfs, M, { Z: true, h: true })
    expect(DEC.decode(h.out)).toBe(
      `Archive:  /m.zip\nZip file size: ${String(size)} bytes, number of entries: 3\n`,
    )
    const t = await runCmd(RAM_UNZIP, vfs, M, { Z: true, t: true })
    expect(DEC.decode(t.out)).toMatch(
      /^3 files, 201 bytes uncompressed, \d+ bytes compressed: {2}-?\d+\.\d%\n$/,
    )
  })

  it('-Z2 keeps the header that was asked for', async () => {
    const vfs = await makeMulti()
    const r = await runCmd(RAM_UNZIP, vfs, M, { Z: true, '2': true, h: true })
    expect(DEC.decode(r.out)).toMatch(
      /^Archive: {2}\/m\.zip\nZip file size: \d+ bytes, number of entries: 3\nd\/\nd\/a\.txt\nb\.txt\n$/,
    )
  })

  it('a member miss exits 11 with a caution, a hit and a miss exits 0', async () => {
    const vfs = await makeMulti()
    const miss = await runCmd(RAM_UNZIP, vfs, M, { Z: true, args_1: true }, ['nomatch'])
    expect(miss.exitCode).toBe(11)
    expect(miss.out.byteLength).toBe(0)
    expect(DEC.decode(miss.stderr)).toBe('caution: filename not matched:  nomatch\n')
    const mixed = await runCmd(RAM_UNZIP, vfs, M, { Z: true, args_1: true }, ['d/*', 'nomatch'])
    expect(mixed.exitCode).toBe(0)
    expect(DEC.decode(mixed.out)).toBe('d/\nd/a.txt\n')
    expect(DEC.decode(mixed.stderr)).toBe('caution: filename not matched:  nomatch\n')
  })

  it('zipinfo letters need -Z', async () => {
    const vfs = await makeMulti()
    await expect(runCmd(RAM_UNZIP, vfs, M, { args_1: true })).rejects.toThrow(UsageError)
    await expect(runCmd(RAM_UNZIP, vfs, M, { h: true })).rejects.toThrow(
      'unzip: -h is a ZipInfo option and needs -Z',
    )
  })
})

describe('unzip -Zm, -Zs and -x', () => {
  const M = [PathSpec.fromStrPath('/m.zip')]

  it('-Zm and -Zs pick the row format, and need -Z', async () => {
    const vfs = await makeMulti()
    const m = await runCmd(RAM_UNZIP, vfs, M, { Z: true, m: true }, ['d/'])
    expect(DEC.decode(m.out)).toBe('drwxr-xr-x  2.0 unx        0 b-  0% stor 80-Jan-01 00:00 d/\n')
    const s = await runCmd(RAM_UNZIP, vfs, M, { Z: true, s: true }, ['d/'])
    expect(DEC.decode(s.out)).toBe('drwxr-xr-x  2.0 unx        0 b- stor 80-Jan-01 00:00 d/\n')
    await expect(runCmd(RAM_UNZIP, vfs, M, { m: true })).rejects.toThrow(
      'unzip: -m is a ZipInfo option and needs -Z',
    )
  })

  it('-x drops the excluded entries and counts as a filter for the -Z layout', async () => {
    const vfs = await makeMulti()
    const r = await runCmd(RAM_UNZIP, vfs, M, { Z: true, x: ['b.txt'] })
    expect(DEC.decode(r.out)).toBe(
      'drwxr-xr-x  2.0 unx        0 b- stor 80-Jan-01 00:00 d/\n' +
        '-rw-r--r--  2.0 unx      200 b- defN 80-Jan-01 00:00 d/a.txt\n',
    )
    expect(r.exitCode).toBe(0)
    expect(r.stderr.byteLength).toBe(0)
  })

  it('an unmatched exclude is a caution, not an error', async () => {
    const vfs = await makeMulti()
    const r = await runCmd(RAM_UNZIP, vfs, M, { Z: true, args_1: true, x: ['nomatch'] }, ['d/*'])
    expect(DEC.decode(r.out)).toBe('d/\nd/a.txt\n')
    expect(r.exitCode).toBe(0)
    expect(DEC.decode(r.stderr)).toBe('caution: excluded filename not matched:  nomatch\n')
  })

  it('a filter that leaves nothing exits 11 in every mode', async () => {
    const vfs = await makeMulti()
    const z = await runCmd(RAM_UNZIP, vfs, M, { Z: true, args_1: true, x: ['*'] })
    expect(z.exitCode).toBe(11)
    expect(z.out.byteLength).toBe(0)
    const l = await runCmd(RAM_UNZIP, vfs, M, { args_l: true, x: ['*'] })
    expect(DEC.decode(l.out)).toBe('  Length      Name\n---------  ----\n')
    expect(l.exitCode).toBe(11)
    const p = await runCmd(RAM_UNZIP, vfs, M, { p: true, x: ['*'] })
    expect(p.exitCode).toBe(11)
    const t = await runCmd(RAM_UNZIP, vfs, M, { t: true, x: ['*'] })
    expect(DEC.decode(t.out)).toBe('Caution:  zero files tested in /m.zip.\n')
    expect(t.exitCode).toBe(11)
    const x = await runCmd(RAM_UNZIP, vfs, M, { x: ['*'] })
    expect(x.exitCode).toBe(11)
    expect(Object.keys(x.writes)).toEqual([])
  })

  it('an excluded member still counts for its include pattern', async () => {
    const vfs = await makeMulti()
    const r = await runCmd(RAM_UNZIP, vfs, M, { Z: true, args_1: true, x: ['d/a.txt'] }, ['d/*'])
    expect(DEC.decode(r.out)).toBe('d/\n')
    expect(r.exitCode).toBe(0)
    expect(r.stderr.byteLength).toBe(0)
  })

  it('-t reports both caution kinds on stdout', async () => {
    const vfs = await makeMulti()
    const bad = await runCmd(RAM_UNZIP, vfs, M, { t: true, x: ['b.txt'] }, ['nomatch'])
    expect(DEC.decode(bad.out)).toBe(
      'caution: filename not matched:  nomatch\n' +
        'caution: excluded filename not matched:  b.txt\n' +
        'At least one error was detected in /m.zip.\n',
    )
    expect(bad.exitCode).toBe(11)
    const ok = await runCmd(RAM_UNZIP, vfs, M, { t: true, x: ['nomatch'] })
    expect(DEC.decode(ok.out)).toBe(
      'caution: excluded filename not matched:  nomatch\nNo errors detected in /m.zip\n',
    )
    expect(ok.exitCode).toBe(0)
  })

  it('-p excludes and reports the caution on stderr', async () => {
    const vfs = await makeMulti()
    const r = await runCmd(RAM_UNZIP, vfs, M, { p: true, x: ['d/*', 'nomatch'] })
    expect(DEC.decode(r.out)).toBe('b')
    expect(r.exitCode).toBe(0)
    expect(DEC.decode(r.stderr)).toBe('caution: excluded filename not matched:  nomatch\n')
  })
})
