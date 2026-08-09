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
import { RAMResource } from '../../../resource/ram/ram.ts'
import type { LinkView } from '../../../ops/types.ts'
import { FileStat, FileType, LINK_TARGET_KEY, PathSpec } from '../../../types.ts'
import { CycleError } from '../../../utils/path.ts'
import { readTar } from '../tar_helper.ts'
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
    resourcePath: virtual.replace(/^\/+/, ''),
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
  resource: RAMResource,
  paths: PathSpec[],
  flags: Record<string, string | boolean | number | string[]>,
  texts: string[] = [],
  mountPrefix = '',
  links: LinkView | null = null,
): Promise<CmdResult> {
  const cmd = reg[0]
  if (cmd === undefined) throw new Error('not registered')
  const result = await cmd.fn(resource.accessor, paths, texts, {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
    resource,
    mountPrefix,
    ...(links !== null ? { links } : {}),
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
    const resource = new RAMResource()
    resource.store.files.set('/a.txt', ENC.encode('aaa'))
    resource.store.files.set('/b.txt', ENC.encode('bbb'))
    await runCmd(
      RAM_TAR,
      resource,
      [PathSpec.fromStrPath('/a.txt'), PathSpec.fromStrPath('/b.txt')],
      { c: true, f: '/archive.tar' },
    )
    expect(resource.store.files.has('/archive.tar')).toBe(true)
    const { out } = await runCmd(RAM_TAR, resource, [], { t: true, f: '/archive.tar' })
    const decoded = DEC.decode(out)
    expect(decoded).toContain('a.txt')
    expect(decoded).toContain('b.txt')
  })

  it('extracts an archive back to files', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/a.txt', ENC.encode('content_a'))
    await runCmd(RAM_TAR, resource, [PathSpec.fromStrPath('/a.txt')], {
      c: true,
      f: '/archive.tar',
    })
    resource.store.files.delete('/a.txt')
    await runCmd(RAM_TAR, resource, [], { x: true, f: '/archive.tar', C: '/' })
    expect(resource.store.files.has('/a.txt')).toBe(true)
    expect(DEC.decode(resource.store.files.get('/a.txt'))).toBe('content_a')
  })

  it('walks a directory operand instead of failing on it', async () => {
    const resource = new RAMResource()
    resource.store.dirs.add('/d')
    resource.store.dirs.add('/d/sub')
    resource.store.files.set('/d/a.txt', ENC.encode('alpha'))
    resource.store.files.set('/d/sub/b.txt', ENC.encode('beta'))
    const { exitCode, out } = await runCmd(RAM_TAR, resource, [dirSpec('/d', 'd')], {
      c: true,
      v: true,
      f: '/out.tar',
    })
    expect(exitCode).toBe(0)
    expect(DEC.decode(out).trim().split('\n')).toEqual(['d/', 'd/a.txt', 'd/sub/', 'd/sub/b.txt'])
    const listed = await runCmd(RAM_TAR, resource, [], { t: true, f: '/out.tar' })
    expect(DEC.decode(listed.out).trim().split('\n')).toEqual([
      'd/',
      'd/a.txt',
      'd/sub/',
      'd/sub/b.txt',
    ])
  })

  it('names members as the operand was typed, so -C survives a round trip', async () => {
    const resource = new RAMResource()
    resource.store.dirs.add('/base')
    resource.store.dirs.add('/base/d')
    resource.store.files.set('/base/d/a.txt', ENC.encode('alpha'))
    await runCmd(RAM_TAR, resource, [dirSpec('/base/d', 'd')], { c: true, f: '/out.tar' })
    const listed = await runCmd(RAM_TAR, resource, [], { t: true, f: '/out.tar' })
    expect(DEC.decode(listed.out).trim().split('\n')).toEqual(['d/', 'd/a.txt'])
  })

  it('warns once about a stripped leading slash', async () => {
    const resource = new RAMResource()
    resource.store.dirs.add('/d')
    resource.store.files.set('/d/a.txt', ENC.encode('alpha'))
    const { stderr } = await runCmd(RAM_TAR, resource, [dirSpec('/d', '/d')], {
      c: true,
      f: '/out.tar',
    })
    const text = DEC.decode(stderr)
    expect(text).toContain('Removing leading')
    expect(text.split('Removing leading').length - 1).toBe(1)
  })

  it("reports a missing operand in tar's own words and exits 2", async () => {
    const resource = new RAMResource()
    resource.store.dirs.add('/d')
    resource.store.files.set('/d/a.txt', ENC.encode('alpha'))
    const { exitCode, stderr } = await runCmd(
      RAM_TAR,
      resource,
      [dirSpec('/nope', 'nope'), dirSpec('/d', 'd')],
      { c: true, f: '/out.tar' },
    )
    expect(exitCode).toBe(2)
    const text = DEC.decode(stderr)
    expect(text).toContain('tar: nope: Cannot stat: No such file or directory')
    expect(text).toContain('Exiting with failure status due to previous errors')
  })

  it('refuses to create an empty archive', async () => {
    const resource = new RAMResource()
    const { exitCode, stderr, writes } = await runCmd(RAM_TAR, resource, [], {
      c: true,
      f: '/out.tar',
    })
    expect(exitCode).toBe(2)
    expect(DEC.decode(stderr)).toContain('Cowardly refusing to create an empty archive')
    expect(Object.keys(writes)).toHaveLength(0)
  })

  it('refuses a -C it cannot enter', async () => {
    const resource = new RAMResource()
    resource.store.dirs.add('/d')
    resource.store.files.set('/d/a.txt', ENC.encode('alpha'))
    const { exitCode, stderr, writes } = await runCmd(
      RAM_TAR,
      resource,
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
    const resource = new RAMResource()
    resource.store.dirs.add('/d')
    resource.store.dirs.add('/d/sub')
    resource.store.files.set('/d/a.txt', ENC.encode('a'))
    resource.store.files.set('/d/sub/b.txt', ENC.encode('b'))
    const pruned = await runCmd(RAM_TAR, resource, [dirSpec('/d', 'd')], {
      c: true,
      f: '/out.tar',
      exclude: 'sub',
    })
    expect(pruned.exitCode).toBe(0)
    const listed = await runCmd(RAM_TAR, resource, [], { t: true, f: '/out.tar' })
    expect(DEC.decode(listed.out).trim().split('\n')).toEqual(['d/', 'd/a.txt'])

    const one = await runCmd(RAM_TAR, resource, [dirSpec('/d', 'd')], {
      c: true,
      f: '/two.tar',
      exclude: 'sub/b.txt',
    })
    expect(one.exitCode).toBe(0)
    const listedTwo = await runCmd(RAM_TAR, resource, [], { t: true, f: '/two.tar' })
    expect(DEC.decode(listedTwo.out).trim().split('\n')).toEqual(['d/', 'd/a.txt', 'd/sub/'])
  })

  it('round-trips an empty directory through create and extract', async () => {
    const resource = new RAMResource()
    resource.store.dirs.add('/d')
    resource.store.dirs.add('/d/empty')
    resource.store.files.set('/d/a.txt', ENC.encode('a'))
    await runCmd(RAM_TAR, resource, [dirSpec('/d', 'd')], { c: true, f: '/out.tar' })
    const listed = await runCmd(RAM_TAR, resource, [], { t: true, f: '/out.tar' })
    expect(DEC.decode(listed.out)).toContain('d/empty/')
    await runCmd(RAM_TAR, resource, [], { x: true, f: '/out.tar', C: '/out' })
    expect(resource.store.dirs.has('/out/d/empty')).toBe(true)
  })

  it('names members from virtual paths on a prefixed mount', async () => {
    // The walk answers in mount-relative keys, the way a backend's own
    // find op does; a mount behind a prefix is the only place where
    // forgetting to lift them back shows up.
    const resource = new RAMResource()
    resource.store.dirs.add('/tdir')
    resource.store.dirs.add('/tdir/sub')
    resource.store.files.set('/tdir/a.txt', ENC.encode('aa'))
    resource.store.files.set('/tdir/sub/b.txt', ENC.encode('bb'))
    const operand = new PathSpec({
      virtual: '/data/tdir',
      directory: '/data/tdir',
      resourcePath: 'tdir',
      resolved: true,
      rawPath: 'tdir',
    })
    const { out, exitCode } = await runCmd(
      RAM_TAR,
      resource,
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
    const resource = new RAMResource()
    resource.store.dirs.add('/d')
    resource.store.files.set('/d/a.txt', ENC.encode('a'))
    resource.store.files.set('/d/old.tar', ENC.encode('stale'))
    const { stderr } = await runCmd(RAM_TAR, resource, [dirSpec('/d', 'd')], {
      c: true,
      f: '/d/old.tar',
    })
    expect(DEC.decode(stderr)).toContain('archive cannot contain itself')
    const listed = await runCmd(RAM_TAR, resource, [], { t: true, f: '/d/old.tar' })
    expect(DEC.decode(listed.out).trim().split('\n')).toEqual(['d/', 'd/a.txt'])
  })
})

describe('zip / unzip', () => {
  it('zip then unzip -l lists the archived file', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/a.txt', ENC.encode('hello'))
    await runCmd(
      RAM_ZIP,
      resource,
      [PathSpec.fromStrPath('/out.zip'), PathSpec.fromStrPath('/a.txt')],
      {},
    )
    expect(resource.store.files.has('/out.zip')).toBe(true)
    const { out } = await runCmd(RAM_UNZIP, resource, [PathSpec.fromStrPath('/out.zip')], {
      args_l: true,
    })
    expect(DEC.decode(out)).toContain('a.txt')
  })

  it('zip then unzip -d round trip restores file contents', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/a.txt', ENC.encode('zip_content'))
    await runCmd(
      RAM_ZIP,
      resource,
      [PathSpec.fromStrPath('/out.zip'), PathSpec.fromStrPath('/a.txt')],
      {},
    )
    resource.store.files.delete('/a.txt')
    await runCmd(RAM_UNZIP, resource, [PathSpec.fromStrPath('/out.zip')], { d: '/' })
    expect(resource.store.files.has('/a.txt')).toBe(true)
    expect(DEC.decode(resource.store.files.get('/a.txt'))).toBe('zip_content')
  })

  it('zip -j junks paths, keeping only basename', async () => {
    const resource = new RAMResource()
    resource.store.dirs.add('/sub')
    resource.store.files.set('/sub/deep.txt', ENC.encode('hello'))
    await runCmd(
      RAM_ZIP,
      resource,
      [PathSpec.fromStrPath('/out.zip'), PathSpec.fromStrPath('/sub/deep.txt')],
      { j: true },
    )
    const { out } = await runCmd(RAM_UNZIP, resource, [PathSpec.fromStrPath('/out.zip')], {
      args_l: true,
    })
    const text = DEC.decode(out)
    expect(text).toContain('deep.txt')
    expect(text).not.toContain('sub/')
  })

  it('zip -q suppresses stdout', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/a.txt', ENC.encode('hello'))
    const { out } = await runCmd(
      RAM_ZIP,
      resource,
      [PathSpec.fromStrPath('/out.zip'), PathSpec.fromStrPath('/a.txt')],
      { q: true },
    )
    expect(out.byteLength).toBe(0)
  })

  it('zip -r walks a directory operand instead of failing on it', async () => {
    const resource = new RAMResource()
    resource.store.dirs.add('/d')
    resource.store.dirs.add('/d/sub')
    resource.store.dirs.add('/d/empty')
    resource.store.files.set('/d/a.txt', ENC.encode('alpha'))
    resource.store.files.set('/d/sub/b.txt', ENC.encode('beta'))
    const { out, exitCode } = await runCmd(
      RAM_ZIP,
      resource,
      [PathSpec.fromStrPath('/out.zip'), dirSpec('/d', 'd')],
      { r: true },
    )
    expect(exitCode).toBe(0)
    expect(DEC.decode(out)).toBe(
      '  adding: d/\n  adding: d/a.txt\n  adding: d/empty/\n  adding: d/sub/\n  adding: d/sub/b.txt\n',
    )
  })

  it('zip without -r stores the directory entry and nothing under it', async () => {
    const resource = new RAMResource()
    resource.store.dirs.add('/d')
    resource.store.files.set('/d/a.txt', ENC.encode('alpha'))
    const { out } = await runCmd(
      RAM_ZIP,
      resource,
      [PathSpec.fromStrPath('/out.zip'), dirSpec('/d', 'd')],
      {},
    )
    expect(DEC.decode(out)).toBe('  adding: d/\n')
  })

  it('zip -r then unzip restores an empty directory', async () => {
    const resource = new RAMResource()
    resource.store.dirs.add('/d')
    resource.store.dirs.add('/d/empty')
    resource.store.files.set('/d/a.txt', ENC.encode('alpha'))
    await runCmd(RAM_ZIP, resource, [PathSpec.fromStrPath('/out.zip'), dirSpec('/d', 'd')], {
      r: true,
      q: true,
    })
    resource.store.dirs.delete('/d/empty')
    resource.store.files.delete('/d/a.txt')
    await runCmd(RAM_UNZIP, resource, [PathSpec.fromStrPath('/out.zip')], { d: '/', q: true })
    expect(resource.store.dirs.has('/d/empty')).toBe(true)
    expect(DEC.decode(resource.store.files.get('/d/a.txt'))).toBe('alpha')
  })

  it('zip -r -j drops directory entries entirely', async () => {
    const resource = new RAMResource()
    resource.store.dirs.add('/d')
    resource.store.dirs.add('/d/sub')
    resource.store.files.set('/d/a.txt', ENC.encode('alpha'))
    resource.store.files.set('/d/sub/b.txt', ENC.encode('beta'))
    const { out } = await runCmd(
      RAM_ZIP,
      resource,
      [PathSpec.fromStrPath('/out.zip'), dirSpec('/d', 'd')],
      { r: true, j: true },
    )
    expect(DEC.decode(out)).toBe('  adding: a.txt\n  adding: b.txt\n')
  })

  it('zip -x is anchored on the whole stored name', async () => {
    const resource = new RAMResource()
    resource.store.dirs.add('/d')
    resource.store.dirs.add('/d/sub')
    resource.store.files.set('/d/a.txt', ENC.encode('alpha'))
    resource.store.files.set('/d/sub/b.txt', ENC.encode('beta'))
    const { out } = await runCmd(
      RAM_ZIP,
      resource,
      [PathSpec.fromStrPath('/out.zip'), dirSpec('/d', 'd')],
      { r: true, x: ['d/sub/*'] },
    )
    expect(DEC.decode(out)).toBe('  adding: d/\n  adding: d/a.txt\n')
  })

  it("warns in Info-ZIP's words on a name it cannot match, and archives the rest", async () => {
    const resource = new RAMResource()
    resource.store.files.set('/a.txt', ENC.encode('alpha'))
    const { exitCode, stderr } = await runCmd(
      RAM_ZIP,
      resource,
      [PathSpec.fromStrPath('/out.zip'), dirSpec('/a.txt', 'a.txt'), dirSpec('/nope', 'nope')],
      {},
    )
    expect(exitCode).toBe(0)
    expect(DEC.decode(stderr)).toBe('\tzip warning: name not matched: nope\n')
    expect(resource.store.files.has('/out.zip')).toBe(true)
  })

  it('writes no archive and exits 12 when nothing matched', async () => {
    const resource = new RAMResource()
    const { exitCode, stderr } = await runCmd(
      RAM_ZIP,
      resource,
      [dirSpec('/out.zip', 'out.zip'), dirSpec('/nope', 'nope')],
      {},
    )
    expect(exitCode).toBe(12)
    expect(resource.store.files.has('/out.zip')).toBe(false)
    expect(DEC.decode(stderr)).toBe(
      '\tzip warning: name not matched: nope\n\nzip error: Nothing to do! (out.zip)\n',
    )
  })

  it('-q silences the warning but never the fatal error', async () => {
    const resource = new RAMResource()
    const { exitCode, stderr } = await runCmd(
      RAM_ZIP,
      resource,
      [dirSpec('/out.zip', 'out.zip'), dirSpec('/nope', 'nope')],
      { q: true },
    )
    expect(exitCode).toBe(12)
    expect(DEC.decode(stderr)).toBe('\nzip error: Nothing to do! (out.zip)\n')
  })

  it('names members from virtual paths on a prefixed mount', async () => {
    const resource = new RAMResource()
    resource.store.dirs.add('/d')
    resource.store.files.set('/d/a.txt', ENC.encode('alpha'))
    const operand = new PathSpec({
      virtual: '/data/d',
      directory: '/data/d',
      resourcePath: 'd',
      resolved: true,
      rawPath: '/data/d',
    })
    const archive = new PathSpec({
      virtual: '/data/out.zip',
      directory: '/data',
      resourcePath: 'out.zip',
      resolved: true,
      rawPath: '/data/out.zip',
    })
    const { out } = await runCmd(RAM_ZIP, resource, [archive, operand], { r: true }, [], '/data')
    expect(DEC.decode(out)).toBe('  adding: data/d/\n  adding: data/d/a.txt\n')
  })
})

describe('unzip members', () => {
  const APP = 'APPXML-CONTENT\n'
  const SHEET = 'SHEET1-CONTENT\n'
  const WORKBOOK = 'WORKBOOK-CONTENT\n'
  const CAUTION = 'caution: filename not matched:  '

  async function makeBook(): Promise<RAMResource> {
    const resource = new RAMResource()
    resource.store.dirs.add('/docProps')
    resource.store.dirs.add('/xl')
    resource.store.files.set('/docProps/app.xml', ENC.encode(APP))
    resource.store.files.set('/xl/sheet1.xml', ENC.encode(SHEET))
    resource.store.files.set('/xl/workbook.xml', ENC.encode(WORKBOOK))
    await runCmd(
      RAM_ZIP,
      resource,
      [
        PathSpec.fromStrPath('/book.zip'),
        PathSpec.fromStrPath('/docProps/app.xml'),
        PathSpec.fromStrPath('/xl/sheet1.xml'),
        PathSpec.fromStrPath('/xl/workbook.xml'),
      ],
      {},
    )
    return resource
  }

  function book(): PathSpec[] {
    return [PathSpec.fromStrPath('/book.zip')]
  }

  it('-p with a member outputs only that member', async () => {
    const resource = await makeBook()
    const r = await runCmd(RAM_UNZIP, resource, book(), { p: true }, ['xl/workbook.xml'])
    expect(DEC.decode(r.out)).toBe(WORKBOOK)
    expect(r.exitCode).toBe(0)
    expect(r.stderr.byteLength).toBe(0)
  })

  it('-p with a missing member exits 11 with a caution on stderr', async () => {
    const resource = await makeBook()
    const r = await runCmd(RAM_UNZIP, resource, book(), { p: true }, ['NOSUCHFILE.xml'])
    expect(r.out.byteLength).toBe(0)
    expect(r.exitCode).toBe(11)
    expect(DEC.decode(r.stderr)).toBe(`${CAUTION}NOSUCHFILE.xml\n`)
  })

  it('-p output follows archive order, not argument order', async () => {
    const resource = await makeBook()
    const r = await runCmd(RAM_UNZIP, resource, book(), { p: true }, [
      'xl/workbook.xml',
      'docProps/app.xml',
    ])
    expect(DEC.decode(r.out)).toBe(APP + WORKBOOK)
    expect(r.exitCode).toBe(0)
  })

  it('-p charges each entry to the first matching spec', async () => {
    const resource = await makeBook()
    const r = await runCmd(RAM_UNZIP, resource, book(), { p: true }, ['*.xml', 'xl/workbook.xml'])
    expect(DEC.decode(r.out)).toBe(APP + SHEET + WORKBOOK)
    expect(r.exitCode).toBe(11)
    expect(DEC.decode(r.stderr)).toBe(`${CAUTION}xl/workbook.xml\n`)
  })

  it('-p wildcard star crosses slashes', async () => {
    const resource = await makeBook()
    const r = await runCmd(RAM_UNZIP, resource, book(), { p: true }, ['doc*'])
    expect(DEC.decode(r.out)).toBe(APP)
    expect(r.exitCode).toBe(0)
  })

  it('-p wildcard selects a subtree', async () => {
    const resource = await makeBook()
    const r = await runCmd(RAM_UNZIP, resource, book(), { p: true }, ['xl/*'])
    expect(DEC.decode(r.out)).toBe(SHEET + WORKBOOK)
    expect(r.exitCode).toBe(0)
  })

  it('-p treats ? as one byte, the way Info-ZIP does', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/é.txt', ENC.encode('ACCENT\n'))
    resource.store.files.set('/ab.txt', ENC.encode('AB\n'))
    await runCmd(
      RAM_ZIP,
      resource,
      [
        PathSpec.fromStrPath('/bytes.zip'),
        PathSpec.fromStrPath('/é.txt'),
        PathSpec.fromStrPath('/ab.txt'),
      ],
      {},
    )
    const arch = [PathSpec.fromStrPath('/bytes.zip')]
    const one = await runCmd(RAM_UNZIP, resource, arch, { p: true }, ['?.txt'])
    expect(one.out.byteLength).toBe(0)
    expect(one.exitCode).toBe(11)
    expect(DEC.decode(one.stderr)).toBe(`${CAUTION}?.txt\n`)
    const two = await runCmd(RAM_UNZIP, resource, arch, { p: true }, ['??.txt'])
    expect(DEC.decode(two.out)).toBe('ACCENT\nAB\n')
    expect(two.exitCode).toBe(0)
  })

  it('-l filters rows and exits 11 only when nothing matched', async () => {
    const resource = await makeBook()
    const hit = await runCmd(RAM_UNZIP, resource, book(), { args_l: true }, ['xl/workbook.xml'])
    expect(DEC.decode(hit.out)).toContain('xl/workbook.xml')
    expect(DEC.decode(hit.out)).not.toContain('docProps/app.xml')
    expect(hit.exitCode).toBe(0)
    const miss = await runCmd(RAM_UNZIP, resource, book(), { args_l: true }, ['NOSUCHFILE.xml'])
    expect(miss.exitCode).toBe(11)
    expect(miss.stderr.byteLength).toBe(0)
    const partial = await runCmd(RAM_UNZIP, resource, book(), { args_l: true }, [
      'xl/workbook.xml',
      'NOSUCHFILE.xml',
    ])
    expect(partial.exitCode).toBe(0)
    expect(partial.stderr.byteLength).toBe(0)
  })

  it('-t reports unmatched members on stdout and exits 11', async () => {
    const resource = await makeBook()
    const r = await runCmd(RAM_UNZIP, resource, book(), { t: true }, [
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
    const resource = await makeBook()
    const r = await runCmd(RAM_UNZIP, resource, book(), { d: '/ext' }, [
      'xl/workbook.xml',
      'NOSUCHFILE.xml',
    ])
    expect(resource.store.files.has('/ext/xl/workbook.xml')).toBe(true)
    expect(resource.store.files.has('/ext/docProps/app.xml')).toBe(false)
    expect(r.exitCode).toBe(11)
    expect(DEC.decode(r.stderr)).toBe(`${CAUTION}NOSUCHFILE.xml\n`)
  })
})

describe('archive planner regressions', () => {
  it('two links to one target are not a loop', async () => {
    // GNU tar -h and Info-ZIP both store the two names.
    const resource = new RAMResource()
    resource.store.dirs.add('/d')
    resource.store.files.set('/d/a.txt', ENC.encode('alpha'))
    const links = linkView({ '/d/one': '/d/a.txt', '/d/two': '/d/a.txt' })
    const { out, exitCode, stderr } = await runCmd(
      RAM_TAR,
      resource,
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
    const resource = new RAMResource()
    resource.store.dirs.add('/d')
    const links = linkView({ '/d/a': '/d/b', '/d/b': '/d/a' }, true)
    const { exitCode, stderr } = await runCmd(
      RAM_TAR,
      resource,
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
    const resource = new RAMResource()
    resource.store.dirs.add('/d')
    resource.store.files.set('/d/a.txt', ENC.encode('alpha'))
    const links = linkView({ '/link': '/d/a.txt' })
    const { out } = await runCmd(
      RAM_TAR,
      resource,
      [dirSpec('/link', 'link')],
      { c: true, v: true, f: '/out.tar' },
      [],
      '',
      links,
    )
    expect(DEC.decode(out).trim()).toBe('link')
    const { out: listed } = await runCmd(RAM_TAR, resource, [], { t: true, f: '/out.tar' })
    expect(DEC.decode(listed).trim()).toBe('link')
  })

  it('stores a symlink operand with its target and no bytes', async () => {
    // The name alone cannot tell the two apart, so read the archive back:
    // a link member carries linkname and no content.
    const resource = new RAMResource()
    resource.store.dirs.add('/d')
    resource.store.files.set('/d/a.txt', ENC.encode('alpha'))
    const links = linkView({ '/link': '/d/a.txt' })
    const { writes } = await runCmd(
      RAM_TAR,
      resource,
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
    const resource = new RAMResource()
    resource.store.dirs.add('/d')
    resource.store.files.set('/d/a.txt', ENC.encode('alpha'))
    const links = linkView({ '/link': '/d/a.txt' })
    const { writes } = await runCmd(
      RAM_TAR,
      resource,
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
    const resource = new RAMResource()
    const links = linkView({ '/link': '/d/missing.txt' })
    const { exitCode, stderr } = await runCmd(
      RAM_TAR,
      resource,
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
    const resource = new RAMResource()
    resource.store.dirs.add('/good')
    resource.store.files.set('/good/y.txt', ENC.encode('y'))
    const { exitCode, stderr } = await runCmd(
      RAM_TAR,
      resource,
      [dirSpec('/good/y.txt', 'y.txt')],
      { c: true, f: '/out.tar', C: ['/missing', '/good'] },
    )
    expect(exitCode).toBe(2)
    const text = DEC.decode(stderr)
    expect(text).toContain('tar: /missing: Cannot open: No such file or directory')
    expect(text).toContain('Error is not recoverable')
    expect(resource.store.files.has('/out.tar')).toBe(false)
  })
})
