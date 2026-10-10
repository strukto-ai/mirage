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

import { commandIo } from '../../../commands/builtin/generic_bind/adapter.ts'
import { RAM_COMMANDS } from './index.ts'
import { type CommandOpts, type Command } from '../../config.ts'
import { describe, expect, it } from 'vitest'
import { materialize } from '../../../io/types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import type { LinkView } from '../../../view/types.ts'
import { FileStat, FileType, LINK_TARGET_KEY, PathSpec, MountMode } from '../../../types.ts'
import { CycleError } from '../../../utils/path.ts'
import { readTar } from '../tar_helper.ts'
import { UsageError } from '../../errors.ts'
import { getTestParser } from '../../../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'
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
  reg: readonly Command[],
  vfs: RAMVFS,
  paths: PathSpec[],
  flags: CommandOpts['flags'],
  texts: string[] = [],
  mountPrefix = '',
  links: LinkView | null = null,
): Promise<CmdResult> {
  const cmd = reg[0]
  if (cmd === undefined) throw new Error('not registered')
  const before = new Map(vfs.store.files)
  const result = await cmd.fn(vfs.accessor, paths, texts, {
    stdin: null,
    flags,
    io: commandIo(vfs),
    cwd: '/',
    mountPrefix,
    ...(links !== null ? { ns: { links } } : {}),
  })
  if (result === null) {
    return { out: new Uint8Array(), writes: {}, exitCode: 0, stderr: new Uint8Array() }
  }
  const [output, io] = result as [unknown, { exitCode: number; stderr: Uint8Array | null }]
  let outBytes: Uint8Array = new Uint8Array()
  if (output !== null) {
    outBytes =
      output instanceof Uint8Array ? output : await materialize(output as AsyncIterable<Uint8Array>)
  }
  return {
    out: outBytes,
    // The files the command left with other bytes than it found.
    writes: Object.fromEntries(
      [...vfs.store.files].filter(([path, data]) => before.get(path) !== data),
    ),
    exitCode: io.exitCode,
    stderr: io.stderr ?? new Uint8Array(),
  }
}

describe('tar', () => {
  it('creates an archive, lists it and extracts it back to files', async () => {
    const vfs = new RAMVFS()
    vfs.store.files.set('/a.txt', ENC.encode('content_a'))
    vfs.store.files.set('/b.txt', ENC.encode('bbb'))
    await runCmd(RAM_TAR, vfs, [PathSpec.fromStrPath('/a.txt'), PathSpec.fromStrPath('/b.txt')], {
      create: true,
      file: PathSpec.fromStrPath('/archive.tar'),
    })
    const { out } = await runCmd(RAM_TAR, vfs, [], {
      list: true,
      file: PathSpec.fromStrPath('/archive.tar'),
    })
    expect(DEC.decode(out).trim().split('\n')).toEqual(['a.txt', 'b.txt'])
    vfs.store.files.delete('/a.txt')
    await runCmd(RAM_TAR, vfs, [], {
      extract: true,
      file: PathSpec.fromStrPath('/archive.tar'),
      directory: PathSpec.fromStrPath('/'),
    })
    expect(DEC.decode(vfs.store.files.get('/a.txt'))).toBe('content_a')
  })

  it('walks a directory operand instead of failing on it', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/d')
    vfs.store.dirs.add('/d/sub')
    vfs.store.files.set('/d/a.txt', ENC.encode('alpha'))
    vfs.store.files.set('/d/sub/b.txt', ENC.encode('beta'))
    const { exitCode, out } = await runCmd(RAM_TAR, vfs, [dirSpec('/d', 'd')], {
      create: true,
      verbose: true,
      file: PathSpec.fromStrPath('/out.tar'),
    })
    expect(exitCode).toBe(0)
    expect(DEC.decode(out).trim().split('\n')).toEqual(['d/', 'd/a.txt', 'd/sub/', 'd/sub/b.txt'])
    const listed = await runCmd(RAM_TAR, vfs, [], {
      list: true,
      file: PathSpec.fromStrPath('/out.tar'),
    })
    expect(DEC.decode(listed.out).trim().split('\n')).toEqual([
      'd/',
      'd/a.txt',
      'd/sub/',
      'd/sub/b.txt',
    ])
  })

  it('warns once about a stripped leading slash', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/d')
    vfs.store.files.set('/d/a.txt', ENC.encode('alpha'))
    const { stderr } = await runCmd(RAM_TAR, vfs, [dirSpec('/d', '/d')], {
      create: true,
      file: PathSpec.fromStrPath('/out.tar'),
    })
    const text = DEC.decode(stderr)
    expect(text).toContain('Removing leading')
    expect(text.split('Removing leading').length - 1).toBe(1)
  })

  // GNU stores no traversal-bearing name: it drops everything through the
  // last `..` and names the prefix it dropped, as it walks the operands, so
  // a later operand's notice never jumps ahead of an earlier one's error and
  // a prefix is named even when nothing under its operand is stored.
  it.each([
    [
      [['/d/a.txt', '/d/sub/../a.txt']],
      ["tar: Removing leading `/d/sub/../' from member names", ''],
    ],
    [
      [['/d/missing', 'sub/../missing']],
      [
        "tar: Removing leading `sub/../' from member names",
        'tar: sub/../missing: Cannot stat: No such file or directory',
      ],
    ],
    [
      [
        ['/base/nope', 'nope'],
        ['/base/file', '../file'],
      ],
      [
        'tar: nope: Cannot stat: No such file or directory',
        "tar: Removing leading `../' from member names",
      ],
    ],
    [
      [
        ['/base/file', '../file'],
        ['/base/nope', 'nope'],
      ],
      [
        "tar: Removing leading `../' from member names",
        'tar: nope: Cannot stat: No such file or directory',
      ],
    ],
  ])('names each dropped prefix in operand order: %j', async (operands, lines) => {
    const vfs = new RAMVFS()
    for (const dir of ['/d', '/d/sub', '/base', '/base/sub']) vfs.store.dirs.add(dir)
    vfs.store.files.set('/d/a.txt', ENC.encode('alpha'))
    vfs.store.files.set('/base/file', ENC.encode('x'))
    const { stderr } = await runCmd(
      RAM_TAR,
      vfs,
      operands.map(([virtual, raw]) => dirSpec(virtual ?? '', raw ?? '')),
      { create: true, file: PathSpec.fromStrPath('/out.tar') },
    )
    expect(DEC.decode(stderr).split('\n').slice(0, 2)).toEqual(lines)
  })

  it("reports a missing operand in tar's own words and exits 2", async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/d')
    vfs.store.files.set('/d/a.txt', ENC.encode('alpha'))
    const { exitCode, stderr } = await runCmd(
      RAM_TAR,
      vfs,
      [dirSpec('/nope', 'nope'), dirSpec('/d', 'd')],
      { create: true, file: PathSpec.fromStrPath('/out.tar') },
    )
    expect(exitCode).toBe(2)
    const text = DEC.decode(stderr)
    expect(text).toContain('tar: nope: Cannot stat: No such file or directory')
    expect(text).toContain('Exiting with failure status due to previous errors')
  })

  it('refuses an unenterable -C before it writes anything', async () => {
    const vfs = new RAMVFS()
    const { exitCode, stderr, writes } = await runCmd(
      RAM_TAR,
      vfs,
      [dirSpec('/nodir/a.txt', 'a.txt')],
      {
        create: true,
        file: PathSpec.fromStrPath('/out.tar'),
        directory: PathSpec.fromStrPath('/nodir'),
      },
    )
    expect(exitCode).toBe(2)
    expect(DEC.decode(stderr)).toContain('tar: /nodir: Cannot open: No such file or directory')
    expect(Object.keys(writes)).toHaveLength(0)
  })

  it('--exclude matches mid-path like GNU', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/d')
    vfs.store.dirs.add('/d/sub')
    vfs.store.files.set('/d/a.txt', ENC.encode('a'))
    vfs.store.files.set('/d/sub/b.txt', ENC.encode('b'))
    const one = await runCmd(RAM_TAR, vfs, [dirSpec('/d', 'd')], {
      create: true,
      file: PathSpec.fromStrPath('/two.tar'),
      exclude: 'sub/b.txt',
    })
    expect(one.exitCode).toBe(0)
    const listedTwo = await runCmd(RAM_TAR, vfs, [], {
      list: true,
      file: PathSpec.fromStrPath('/two.tar'),
    })
    expect(DEC.decode(listedTwo.out).trim().split('\n')).toEqual(['d/', 'd/a.txt', 'd/sub/'])
  })

  it('round-trips an empty directory through create and extract', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/d')
    vfs.store.dirs.add('/d/empty')
    vfs.store.files.set('/d/a.txt', ENC.encode('a'))
    await runCmd(RAM_TAR, vfs, [dirSpec('/d', 'd')], {
      create: true,
      file: PathSpec.fromStrPath('/out.tar'),
    })
    const listed = await runCmd(RAM_TAR, vfs, [], {
      list: true,
      file: PathSpec.fromStrPath('/out.tar'),
    })
    expect(DEC.decode(listed.out)).toContain('d/empty/')
    vfs.store.dirs.add('/out')
    await runCmd(RAM_TAR, vfs, [], {
      extract: true,
      file: PathSpec.fromStrPath('/out.tar'),
      directory: PathSpec.fromStrPath('/out'),
    })
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
      { create: true, verbose: true, file: PathSpec.fromStrPath('/tdir.tar') },
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
})

describe('zip / unzip', () => {
  it('round-trips through unzip, and -j keeps only the basename', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/sub')
    vfs.store.files.set('/a.txt', ENC.encode('zip_content'))
    vfs.store.files.set('/sub/deep.txt', ENC.encode('hello'))
    await runCmd(
      RAM_ZIP,
      vfs,
      [
        PathSpec.fromStrPath('/out.zip'),
        PathSpec.fromStrPath('/a.txt'),
        PathSpec.fromStrPath('/sub/deep.txt'),
      ],
      { j: true },
    )
    const { out } = await runCmd(RAM_UNZIP, vfs, [PathSpec.fromStrPath('/out.zip')], {
      args_l: true,
    })
    expect(DEC.decode(out)).toContain('deep.txt')
    expect(DEC.decode(out)).not.toContain('sub/')
    vfs.store.files.delete('/a.txt')
    await runCmd(RAM_UNZIP, vfs, [PathSpec.fromStrPath('/out.zip')], {
      d: PathSpec.fromStrPath('/'),
    })
    expect(DEC.decode(vfs.store.files.get('/a.txt'))).toBe('zip_content')
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

  it.each([
    [['xl/workbook.xml', 'docProps/app.xml'], APP + WORKBOOK, 0, ''],
    [['*.xml', 'xl/workbook.xml'], APP + SHEET + WORKBOOK, 11, `${CAUTION}xl/workbook.xml\n`],
    [['xl/*'], SHEET + WORKBOOK, 0, ''],
  ])(
    '-p %j selects in archive order, charging the first match',
    async (members, out, code, err) => {
      const vfs = await makeBook()
      const r = await runCmd(RAM_UNZIP, vfs, book(), { p: true }, members)
      expect([DEC.decode(r.out), r.exitCode, DEC.decode(r.stderr)]).toEqual([out, code, err])
    },
  )

  it.each([
    [['NOSUCHFILE.xml'], false, 11],
    [['xl/workbook.xml', 'NOSUCHFILE.xml'], true, 0],
  ])('-l %j filters rows and exits 11 only when nothing matched', async (members, listed, code) => {
    const vfs = await makeBook()
    const r = await runCmd(RAM_UNZIP, vfs, book(), { args_l: true }, members)
    const text = DEC.decode(r.out)
    expect(text.includes('xl/workbook.xml')).toBe(listed)
    expect(text).not.toContain('docProps/app.xml')
    expect([r.exitCode, r.stderr.byteLength]).toEqual([code, 0])
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
    const r = await runCmd(RAM_UNZIP, vfs, book(), { d: PathSpec.fromStrPath('/ext') }, [
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
      { create: true, dereference: true, verbose: true, file: PathSpec.fromStrPath('/out.tar') },
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
      { create: true, dereference: true, file: PathSpec.fromStrPath('/out.tar') },
      [],
      '',
      links,
    )
    expect(exitCode).toBe(2)
    const text = DEC.decode(stderr)
    expect(text).toContain('tar: d/a: Cannot stat: Too many levels of symbolic links')
    expect(text).toContain('tar: d/b: Cannot stat: Too many levels of symbolic links')
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
      { create: true, file: PathSpec.fromStrPath('/out.tar') },
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
      { create: true, dereference: true, file: PathSpec.fromStrPath('/out.tar') },
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
      { create: true, dereference: true, file: PathSpec.fromStrPath('/out.tar') },
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
      create: true,
      file: PathSpec.fromStrPath('/out.tar'),
      directory: ['/missing', '/good'].map((path) => PathSpec.fromStrPath(path)),
    })
    expect(exitCode).toBe(2)
    const text = DEC.decode(stderr)
    expect(text).toContain('tar: /missing: Cannot open: No such file or directory')
    expect(text).toContain('Error is not recoverable')
    expect(vfs.store.files.has('/out.tar')).toBe(false)
  })
})

describe('unzip archive validation', () => {
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
// What -t prints for each of makeMulti's members (UnZip 6.00).
const MULTI_TESTED = ['d/', 'd/a.txt', 'b.txt']
  .map((name) => `    testing: ${name.padEnd(22)}   OK\n`)
  .join('')

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

  it('zipinfo letters need -Z', async () => {
    const vfs = await makeMulti()
    await expect(runCmd(RAM_UNZIP, vfs, M, { args_1: true })).rejects.toThrow(UsageError)
    await expect(runCmd(RAM_UNZIP, vfs, M, { h: true })).rejects.toThrow(
      'unzip: -h is a ZipInfo option and needs -Z',
    )
  })
})

describe('unzip -v', () => {
  const M = [PathSpec.fromStrPath('/m.zip')]

  it.each([[{ args_l: true }], [{ v: true }]])('yields to -t and -p (%o)', async (listing) => {
    // Info-ZIP lists only when neither -t nor -p picks another mode.
    const vfs = await makeMulti()
    const p = await runCmd(RAM_UNZIP, vfs, M, { ...listing, p: true }, ['b.txt'])
    expect(DEC.decode(p.out)).toBe('b')
    const t = await runCmd(RAM_UNZIP, vfs, M, { ...listing, t: true })
    expect(DEC.decode(t.out)).toBe(
      'Archive:  /m.zip\n' + MULTI_TESTED + 'No errors detected in compressed data of /m.zip.\n',
    )
  })
})

describe('unzip -Zm, -Zs and -x', () => {
  const M = [PathSpec.fromStrPath('/m.zip')]

  it('a filter that leaves nothing exits 11 in every mode', async () => {
    const vfs = await makeMulti()
    const z = await runCmd(RAM_UNZIP, vfs, M, { Z: true, args_1: true, x: ['*'] })
    expect(z.exitCode).toBe(11)
    expect(z.out.byteLength).toBe(0)
    const t = await runCmd(RAM_UNZIP, vfs, M, { t: true, x: ['*'] })
    expect(DEC.decode(t.out)).toBe('Archive:  /m.zip\nCaution:  zero files tested in /m.zip.\n')
    expect(t.exitCode).toBe(11)
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
      'Archive:  /m.zip\n' +
        'caution: filename not matched:  nomatch\n' +
        'caution: excluded filename not matched:  b.txt\n' +
        'At least one error was detected in /m.zip.\n',
    )
    expect(bad.exitCode).toBe(11)
    const ok = await runCmd(RAM_UNZIP, vfs, M, { t: true, x: ['nomatch'] })
    expect(DEC.decode(ok.out)).toBe(
      'Archive:  /m.zip\n' +
        MULTI_TESTED +
        'caution: excluded filename not matched:  nomatch\n' +
        'No errors detected in /m.zip for the 3 files tested.\n',
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

async function readOnlyShell(
  seed: string,
  line: string,
): Promise<[number, string, string, string[]]> {
  const vfs = new RAMVFS()
  const ws = new Workspace(
    { '/ro/': [vfs, MountMode.WRITE] },
    { mode: MountMode.WRITE, shellParser: await getTestParser() },
  )
  try {
    const seeded = await ws.shell(seed)
    if (seeded.exitCode !== 0) throw new Error(DEC.decode(seeded.stderr))
    ws.setMountMode('/ro/', MountMode.READ)
    const before = [...vfs.store.files.keys()].sort()
    const r = await ws.shell(line)
    const after = [...vfs.store.files.keys()].sort()
    expect(after).toEqual(before)
    return [r.exitCode, DEC.decode(r.stdout), DEC.decode(r.stderr), after]
  } finally {
    await ws.close()
  }
}

const ARCHIVES = "printf 'hello\\n' > /ro/f.txt && cd /ro && zip -q a.zip f.txt && rm f.txt"

describe('unzip on a read-only mount', () => {
  it.each(['unzip -t /ro/a.zip', 'unzip -Z /ro/a.zip'])(
    'runs %s, which writes nothing',
    async (line) => {
      const [exitCode] = await readOnlyShell(ARCHIVES, line)
      expect(exitCode).toBe(0)
    },
  )

  it.each([
    // UnZip 6.00: a member it cannot create is named as it would have made
    // it (exit 50), an extraction directory it cannot make ends the run
    // (exit 2). Mirrors test_unzip.py.
    ['cd /ro && unzip a.zip', 50, 'error:  cannot create f.txt\n        Read-only file system\n'],
    [
      'unzip -q /ro/a.zip -d /ro/out',
      2,
      'checkdir:  cannot create extraction directory: /ro/out\n           Read-only file system\n',
    ],
  ])('refuses %s at its write', async (line, code, refused) => {
    const [exitCode, , stderr] = await readOnlyShell(ARCHIVES, line)
    expect([exitCode, stderr]).toEqual([code, refused])
  })
})
