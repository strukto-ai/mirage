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
import { eacces, enoent } from '../../../errors/fs.ts'
import { zgrepGeneric } from '../generic/zgrep.ts'
import { RAM_COMMANDS } from './index.ts'
import { describe, expect, it } from 'vitest'
import { materialize } from '../../../io/types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { MountMode, PathSpec } from '../../../types.ts'
import { getTestParser } from '../../../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'
import { gzip } from '../../../utils/compress.ts'
const RAM_ZGREP = RAM_COMMANDS.filter((c) => c.name === 'zgrep' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runZgrep(
  vfs: RAMVFS,
  paths: PathSpec[],
  texts: string[],
  flags: Record<string, string | boolean | number | string[]> = {},
  stdin: Uint8Array | null = null,
): Promise<{ out: string; exitCode: number }> {
  const cmd = RAM_ZGREP[0]
  if (cmd === undefined) throw new Error('zgrep not registered')
  const result = await cmd.fn((vfs as { accessor?: unknown }).accessor as never, paths, texts, {
    stdin,
    flags,
    filetypeFns: null,
    io: commandIo(vfs),
    cwd: '/',
  })
  if (result === null) return { out: '', exitCode: -1 }
  const [out, ioResult] = result
  const buf =
    out === null
      ? new Uint8Array()
      : out instanceof Uint8Array
        ? out
        : await materialize(out as AsyncIterable<Uint8Array>)
  return { out: DEC.decode(buf), exitCode: ioResult.exitCode }
}

describe('zgrep', () => {
  it('finds pattern in gzipped file', async () => {
    const vfs = new RAMVFS()
    const compressed = await gzip(ENC.encode('foo\nbar\nbaz\n'))
    vfs.store.files.set('/f.gz', compressed)
    const r = await runZgrep(vfs, [PathSpec.fromStrPath('/f.gz')], ['bar'])
    expect(r.exitCode).toBe(0)
    expect(r.out.trim()).toBe('bar')
  })

  it('exits with 1 when no match', async () => {
    const vfs = new RAMVFS()
    const compressed = await gzip(ENC.encode('foo\nbar\n'))
    vfs.store.files.set('/f.gz', compressed)
    const r = await runZgrep(vfs, [PathSpec.fromStrPath('/f.gz')], ['xyz'])
    expect(r.exitCode).toBe(1)
  })

  it('-L prints the operand as typed', async () => {
    const vfs = new RAMVFS()
    vfs.store.files.set('/o.gz', await gzip(ENC.encode('foo\n')))
    const typed = new PathSpec({
      virtual: '/o.gz',
      directory: '/',
      vfsPath: '/o.gz',
      rawPath: './o.gz',
    })
    const r = await runZgrep(vfs, [typed], ['hello'], { files_without_match: true })
    expect(r.exitCode).toBe(1)
    expect(r.out).toBe('./o.gz\n')
    const listed = await runZgrep(vfs, [typed], ['foo'], { args_l: true })
    expect(listed.out).toBe('./o.gz\n')
  })

  it('labels stdin "(standard input)" under -H', async () => {
    const vfs = new RAMVFS()
    const compressed = await gzip(ENC.encode('foo\nbar\n'))
    const r = await runZgrep(vfs, [], ['bar'], { H: true }, compressed)
    expect(r.exitCode).toBe(0)
    expect(r.out).toBe('(standard input):bar\n')
  })

  it('lists stdin as "-" under -l and -L', async () => {
    // zgrep (gzip 1.13) lists stdin by the name it hands grep, `-`, while -H
    // labels its lines `(standard input)`.
    const vfs = new RAMVFS()
    const compressed = await gzip(ENC.encode('foo\nbar\n'))
    const listed = await runZgrep(vfs, [], ['bar'], { args_l: true }, compressed)
    expect([listed.out, listed.exitCode]).toEqual(['-\n', 0])
    const unlisted = await runZgrep(vfs, [], ['zzz'], { files_without_match: true }, compressed)
    expect([unlisted.out, unlisted.exitCode]).toEqual(['-\n', 1])
  })
})

describe('zgrep with stdin operands', () => {
  // zgrep hands grep a stdin operand as `-`: -l lists it as `-` while its
  // lines are labelled `(standard input)`; /dev/stdin is as typed.
  const DASH = new PathSpec({ virtual: '/-', directory: '/', vfsPath: '-', rawPath: '-' })
  const DEV = new PathSpec({ virtual: '/dev/stdin', directory: '/dev', vfsPath: 'stdin' })
  it.each([
    [DASH, { H: true }, '(standard input):hello\n'],
    [DEV, { H: true }, '/dev/stdin:hello\n'],
    [DASH, { args_l: true }, '-\n'],
    [DEV, { args_l: true }, '/dev/stdin\n'],
  ] as const)('names %s like GNU', async (operand, flags, want) => {
    const r = await runZgrep(
      new RAMVFS(),
      [operand],
      ['hello'],
      flags,
      await gzip(ENC.encode('hello\n')),
    )
    expect(r).toEqual({ out: want, exitCode: 0 })
  })
})

async function shell(
  line: string,
  stdin: Uint8Array | null = null,
  seed: Record<string, Uint8Array> = {},
): Promise<[string, string, number]> {
  const ws = new Workspace(
    { '/data/': new RAMVFS() },
    { mode: MountMode.WRITE, shellParser: await getTestParser() },
  )
  try {
    for (const [path, body] of Object.entries(seed)) {
      await ws.shell(`tee ${path} > /dev/null`, { stdin: body })
    }
    const io = await ws.shell(line, { stdin })
    const dec = new TextDecoder()
    return [dec.decode(io.stdout), dec.decode(io.stderr), io.exitCode]
  } finally {
    await ws.close()
  }
}

describe('zgrep on inputs gzip passes or refuses', () => {
  // zgrep decompresses with `gzip -cdfq`, which passes a plain file.
  it('searches a plain input as it is', async () => {
    const plain = ENC.encode('hello\nworld\n')
    expect(await shell('zgrep -c o /data/plain.txt', null, { '/data/plain.txt': plain })).toEqual([
      '2\n',
      '',
      0,
    ])
    expect(await shell('zgrep hello', ENC.encode('hello\n'))).toEqual(['hello\n', '', 0])
  })

  it('reports a bad archive and exits 2 beside a match', async () => {
    const hello = await gzip(ENC.encode('hello\n'))
    const r = await shell('zgrep hello /data/cut.gz /data/h.gz', null, {
      '/data/cut.gz': hello.subarray(0, 10),
      '/data/h.gz': hello,
    })
    expect(r).toEqual(['/data/h.gz:hello\n', '\ngzip: /data/cut.gz: unexpected end of file\n', 2])
  })
})

describe('zgrep matches on ASCII rules, as grep does under LC_ALL=C', () => {
  // zgrep is gzip piped into grep (gzip 1.13, grep 3.11): neither U+212A
  // nor U+017F folds to k or s, and neither byte of U+00E9 is a word
  // constituent, so -w and \b see a boundary beside it.
  const LOOKALIKES = 'K\nſ\n'
  const WORD = 'éab\nab\nabé\n'
  it.each([
    ['zgrep -ci k /data/f.gz', '1\n', 0],
    ['zgrep -ci s /data/f.gz', '0\n', 1],
    ['zgrep -io k /data/f.gz', 'k\n', 0],
    ['zgrep -iv k /data/f.gz', LOOKALIKES, 0],
    ['zgrep -il s /data/f.gz', '', 1],
    ['zgrep -iL s /data/f.gz', '/data/f.gz\n', 1],
  ] as const)('folds %s on ASCII only', async (line, out, exit) => {
    const seed = { '/data/f.gz': await gzip(ENC.encode(LOOKALIKES + 'k\n')) }
    expect(await shell(line, null, seed)).toEqual([out, '', exit])
  })
  it.each([
    ['zgrep -w ab /data/w.gz', WORD],
    ['zgrep -cw ab /data/w.gz', '3\n'],
    ['zgrep -ow ab /data/w.gz', 'ab\nab\nab\n'],
    ["zgrep -c '\\bab' /data/w.gz", '3\n'],
  ] as const)('finds the word boundary of %s on ASCII only', async (line, out) => {
    const seed = { '/data/w.gz': await gzip(ENC.encode(WORD)) }
    expect(await shell(line, null, seed)).toEqual([out, '', 0])
  })
})

describe('zgrep invalid extended expressions (GNU grep 3.11)', () => {
  it.each([
    ['(', 'Unmatched ( or \\('],
    ['[z-a]', 'Invalid range end'],
    ['a{2,1}', 'Invalid content of \\{\\}'],
    ['\\', 'Trailing backslash'],
  ])(
    'reports %s with exit 2 in every output mode, including empty input',
    async (pattern, diagnostic) => {
      for (const data of ['', 'hello\n']) {
        for (const mode of ['', '-l', '-L', '-c', '-o', '-q']) {
          expect(
            await shell(`zgrep -E ${mode} '${pattern}'`, await gzip(ENC.encode(data))),
          ).toEqual(['', `grep: ${diagnostic}\n`, 2])
        }
      }
    },
  )

  it.each([
    ['', ''],
    ['-l', ''],
    ['-L', '-\n'],
    ['-c', ''],
    ['-o', ''],
    ['-v', ''],
    ['-q -L', '-\n'],
  ])('skips regex validation and selection under -m0 %s', async (mode, output) => {
    for (const pattern of ['hello', '(']) {
      expect(
        await shell(`zgrep -E -m0 ${mode} '${pattern}'`, await gzip(ENC.encode('hello\n'))),
      ).toEqual([output, '', 1])
    }
  })
})

describe('zgrep opens each operand as gzip -cdfq does', () => {
  // /data holds a.txt, x.gz (a.txt compressed), a directory and a link to
  // x.gz, as zgrep 1.13 was pinned. Mirrors python's
  // test_zgrep_opens_each_operand_as_gzip_cdfq_does.
  it.each([
    // gzip retries a missing name with each suffix, a link included.
    ['zgrep hello x', 'hello\n', '', 0],
    ['zgrep hello xl', 'hello\n', '', 0],
    ['zgrep -l hello x', 'x\n', '', 0],
    ['zgrep hello nope', '', 'gzip: nope.gz: No such file or directory\n', 2],
    ["zgrep hello ''", '', 'gzip: .gz: No such file or directory\n', 2],
    // A failed open is empty input to grep, and the run goes on.
    [
      'zgrep hello nope x a.txt',
      'x:hello\na.txt:hello\n',
      'gzip: nope.gz: No such file or directory\n',
      2,
    ],
    ['zgrep -c hello nope x', 'nope:0\nx:1\n', 'gzip: nope.gz: No such file or directory\n', 2],
    ['zgrep -L hello nope', 'nope\n', 'gzip: nope.gz: No such file or directory\n', 2],
    // gzip -q keeps a directory's warning to itself.
    ['zgrep hello dir', '', '', 1],
    ['zgrep -c hello dir a.txt', 'dir:0\na.txt:1\n', '', 0],
    ['zgrep -L hello dir', 'dir\n', '', 1],
    ['zgrep hello a.txt/x', '', 'gzip: a.txt/x: Not a directory\n', 2],
    ['zgrep hello x.gz/', '', 'gzip: x.gz/: Not a directory\n', 2],
    ['zgrep -s hello nope', '', 'gzip: nope.gz: No such file or directory\n', 2],
  ] as const)('%s', async (line, out, err, code) => {
    const text = ENC.encode('hello\nworld\n')
    const r = await shell(`mkdir /data/dir && cd /data && ln -s x.gz xl.gz && ${line}`, null, {
      '/data/a.txt': text,
      '/data/x.gz': await gzip(text),
    })
    expect(r).toEqual([out, err, code])
  })
})

it.each([
  [{}, '/bad:hello\n/good.gz:hello\n'],
  [{ c: true }, '/bad:1\n/good.gz:1\n'],
  [{ files_without_match: true }, ''],
] as const)('keeps partial matches and continues after read errors: %j', async (flags, out) => {
  const reads: string[] = []
  async function* read(path: PathSpec): AsyncIterable<Uint8Array> {
    reads.push(path.virtual)
    if (path.virtual === '/bad') throw enoent(path)
    yield await gzip(ENC.encode('hello\n'))
    if (path.virtual === '/bad.gz') throw eacces(path)
  }
  const result = await zgrepGeneric(
    [PathSpec.fromStrPath('/bad'), PathSpec.fromStrPath('/good.gz')],
    ['hello'],
    { flags, stdin: null, filetypeFns: null, cwd: '/' },
    read,
  )
  if (result === null) throw new Error('zgrep returned no result')
  const [body, io] = result
  expect(DEC.decode(await materialize(body))).toBe(out)
  expect(io.exitCode).toBe(2)
  expect(await io.stderrStr()).toBe('\ngzip: /bad.gz: Permission denied\n')
  expect(reads).toEqual(['/bad', '/bad.gz', '/good.gz'])
})

it('under a UTF-8 locale leaves out a line no character owns', async () => {
  const vfs = new RAMVFS()
  vfs.store.files.set(
    '/u.gz',
    await gzip(new Uint8Array([0x61, 0x31, 10, 0x61, 0xff, 10, 0x61, 0x32, 10])),
  )
  const cmd = RAM_ZGREP[0]
  if (cmd === undefined) throw new Error('zgrep not registered')
  const path = PathSpec.fromStrPath('/u.gz')
  const result = await cmd.fn((vfs as { accessor?: unknown }).accessor as never, [path], ['a'], {
    stdin: null,
    flags: {},
    filetypeFns: null,
    io: commandIo(vfs),
    cwd: '/',
    env: { LC_ALL: 'C.UTF-8' },
  })
  if (result === null) throw new Error('zgrep answered nothing')
  const [out, io] = result
  expect(DEC.decode(await materialize(out as AsyncIterable<Uint8Array>))).toBe('a1\na2\n')
  expect(DEC.decode(await io.materializeStderr())).toBe('grep: /u.gz: binary file matches\n')
})
