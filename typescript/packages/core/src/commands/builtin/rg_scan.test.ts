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

import { describe, expect, it } from 'vitest'
import { IOResult } from '../../io/types.ts'
import { ContentType, FileStat, FileType } from '../../types.ts'
import {
  rgFolderFiletype,
  rgFull,
  type RgFolderFiletypeOptions,
  type RgFullOptions,
} from './rg_scan.ts'

const ENC = new TextEncoder()

const FILES: Record<string, string> = {
  '/db/a.txt': 'Graph\nplain\nGraph again\n',
  '/db/b.txt': 'nothing here\n',
}

function readdirFn(path: string): Promise<string[]> {
  if (path === '/db') return Promise.resolve(['/db/a.txt', '/db/b.txt'])
  return Promise.reject(new Error(`not a dir: ${path}`))
}

function statFn(path: string): Promise<FileStat> {
  if (path === '/db') {
    return Promise.resolve(new FileStat({ name: 'db', type: FileType.DIRECTORY }))
  }
  const content = FILES[path]
  if (content === undefined) return Promise.reject(new Error(`ENOENT: ${path}`))
  const name = path.split('/').pop() ?? ''
  return Promise.resolve(
    new FileStat({ name, type: FileType.FILE, content: ContentType.TEXT, size: content.length }),
  )
}

function readBytesFn(path: string): Promise<Uint8Array> {
  const content = FILES[path]
  if (content === undefined) return Promise.reject(new Error(`ENOENT: ${path}`))
  return Promise.resolve(ENC.encode(content))
}

function opts(overrides: Partial<RgFullOptions> = {}): RgFullOptions {
  return {
    ignoreCase: false,
    invert: false,
    lineNumbers: false,
    countOnly: false,
    filesOnly: false,
    fixedString: false,
    onlyMatching: false,
    maxCount: null,
    wholeWord: false,
    contextBefore: 0,
    contextAfter: 0,
    fileType: null,
    globPattern: null,
    hidden: false,
    ...overrides,
  }
}

describe('rgFull countOnly', () => {
  it('prints path:count per matching file and omits zero-count files', async () => {
    const out = await rgFull(
      readdirFn,
      statFn,
      readBytesFn,
      '/db',
      'Graph',
      opts({ countOnly: true }),
      null,
    )
    expect(out).toEqual(['/db/a.txt:2'])
  })

  it('prints a bare count for a single file with matches', async () => {
    const out = await rgFull(
      readdirFn,
      statFn,
      readBytesFn,
      '/db/a.txt',
      'Graph',
      opts({ countOnly: true }),
      null,
    )
    expect(out).toEqual(['2'])
  })

  it('returns nothing for a single file without matches', async () => {
    const out = await rgFull(
      readdirFn,
      statFn,
      readBytesFn,
      '/db/b.txt',
      'Graph',
      opts({ countOnly: true }),
      null,
    )
    expect(out).toEqual([])
  })

  it('still prefixes content matches with the file path in directory walks', async () => {
    const out = await rgFull(readdirFn, statFn, readBytesFn, '/db', 'Graph', opts(), null)
    expect(out).toEqual(['/db/a.txt:Graph', '/db/a.txt:Graph again'])
  })
})

const LOG_FILES: Record<string, string> = {
  '/log/app.log':
    'error: disk full\nwarning: low memory\ninfo: all good\nerror: timeout\nnote: done\n',
  '/log/far.txt': 'hit\na\nb\nc\nhit\n',
}

function logReaddirFn(path: string): Promise<string[]> {
  if (path === '/log') return Promise.resolve(['/log/app.log', '/log/far.txt'])
  return Promise.reject(new Error(`not a dir: ${path}`))
}

function logStatFn(path: string): Promise<FileStat> {
  if (path === '/log') {
    return Promise.resolve(new FileStat({ name: 'log', type: FileType.DIRECTORY }))
  }
  const content = LOG_FILES[path]
  if (content === undefined) return Promise.reject(new Error(`ENOENT: ${path}`))
  const name = path.split('/').pop() ?? ''
  return Promise.resolve(
    new FileStat({ name, type: FileType.FILE, content: ContentType.TEXT, size: content.length }),
  )
}

function logReadBytesFn(path: string): Promise<Uint8Array> {
  const content = LOG_FILES[path]
  if (content === undefined) return Promise.reject(new Error(`ENOENT: ${path}`))
  return Promise.resolve(ENC.encode(content))
}

describe('rgFull single-file context', () => {
  it('renders after-context lines', async () => {
    const out = await rgFull(
      logReaddirFn,
      logStatFn,
      logReadBytesFn,
      '/log/app.log',
      'warning',
      opts({ contextAfter: 1 }),
      null,
    )
    expect(out).toEqual(['warning: low memory', 'info: all good'])
  })

  it('merges adjacent context groups without a separator', async () => {
    const out = await rgFull(
      logReaddirFn,
      logStatFn,
      logReadBytesFn,
      '/log/app.log',
      'error',
      opts({ contextBefore: 1, contextAfter: 1 }),
      null,
    )
    expect(out).toEqual([
      'error: disk full',
      'warning: low memory',
      'info: all good',
      'error: timeout',
      'note: done',
    ])
  })

  it('labels context lines with a dash under -n', async () => {
    const out = await rgFull(
      logReaddirFn,
      logStatFn,
      logReadBytesFn,
      '/log/app.log',
      'warning',
      opts({ lineNumbers: true, contextAfter: 1 }),
      null,
    )
    expect(out).toEqual(['2:warning: low memory', '3-info: all good'])
  })

  it('separates distant groups with --', async () => {
    const out = await rgFull(
      logReaddirFn,
      logStatFn,
      logReadBytesFn,
      '/log/far.txt',
      'hit',
      opts({ contextAfter: 1 }),
      null,
    )
    expect(out).toEqual(['hit', 'a', '--', 'hit'])
  })

  it('respects maxCount with context', async () => {
    const out = await rgFull(
      logReaddirFn,
      logStatFn,
      logReadBytesFn,
      '/log/app.log',
      'error',
      opts({ maxCount: 1, contextBefore: 1, contextAfter: 1 }),
      null,
    )
    expect(out).toEqual(['error: disk full', 'warning: low memory'])
  })

  it('skips context on directory walks (documented divergence)', async () => {
    const out = await rgFull(
      logReaddirFn,
      logStatFn,
      logReadBytesFn,
      '/log',
      'warning',
      opts({ contextAfter: 1 }),
      null,
    )
    expect(out).toEqual(['/log/app.log:warning: low memory'])
  })
})

describe('rgFull -I in directory walks', () => {
  it('drops per-file labels', async () => {
    const out = await rgFull(
      logReaddirFn,
      logStatFn,
      logReadBytesFn,
      '/log',
      'warning',
      opts({ noFilename: true }),
      null,
    )
    expect(out).toEqual(['warning: low memory'])
  })

  it('keeps paths for -l', async () => {
    const out = await rgFull(
      logReaddirFn,
      logStatFn,
      logReadBytesFn,
      '/log',
      'warning',
      opts({ noFilename: true, filesOnly: true }),
      null,
    )
    expect(out).toEqual(['/log/app.log'])
  })
})

const DIGIT_FILES: Record<string, string> = {
  '/num/one.txt': 'ab\n',
  '/num/two.txt': 'a1b2c\n',
  '/num/three.txt': 'a1b\n',
}

function digitStatFn(path: string): Promise<FileStat> {
  const content = DIGIT_FILES[path]
  if (content === undefined) return Promise.reject(new Error(`ENOENT: ${path}`))
  const name = path.split('/').pop() ?? ''
  return Promise.resolve(
    new FileStat({ name, type: FileType.FILE, content: ContentType.TEXT, size: content.length }),
  )
}

function digitReadBytesFn(path: string): Promise<Uint8Array> {
  const content = DIGIT_FILES[path]
  if (content === undefined) return Promise.reject(new Error(`ENOENT: ${path}`))
  return Promise.resolve(ENC.encode(content))
}

function digitReaddirFn(path: string): Promise<string[]> {
  return Promise.reject(new Error(`not a dir: ${path}`))
}

describe('rgFull -o GNU semantics', () => {
  // GNU grep 3.11: an empty match prints nothing at all, but the line is
  // still selected, so -c says 1 and the exit status is 0. Every non-empty
  // match prints, one per line.
  it('prints nothing for an empty match yet counts the line', async () => {
    const printed = await rgFull(
      digitReaddirFn,
      digitStatFn,
      digitReadBytesFn,
      '/num/one.txt',
      '[0-9]*',
      opts({ onlyMatching: true }),
      null,
    )
    expect(printed).toEqual([])
    const counted = await rgFull(
      digitReaddirFn,
      digitStatFn,
      digitReadBytesFn,
      '/num/one.txt',
      '[0-9]*',
      opts({ onlyMatching: true, countOnly: true }),
      null,
    )
    expect(counted).toEqual(['1'])
  })

  it('prints every non-empty match on the line', async () => {
    const out = await rgFull(
      digitReaddirFn,
      digitStatFn,
      digitReadBytesFn,
      '/num/two.txt',
      '[0-9]',
      opts({ onlyMatching: true }),
      null,
    )
    expect(out).toEqual(['1', '2'])
  })

  it('drops the empty matches around a non-empty one', async () => {
    const out = await rgFull(
      digitReaddirFn,
      digitStatFn,
      digitReadBytesFn,
      '/num/three.txt',
      '[0-9]*',
      opts({ onlyMatching: true }),
      null,
    )
    expect(out).toEqual(['1'])
  })
})

// The byte layout is section Q1 of the GNU truth file (GNU grep 3.11, whose
// -b/-ob output ripgrep 14 agrees with byte for byte).
const OFFSET_FILES: Record<string, string> = {
  '/off/f1.txt': 'abc\ndefabc\nabc abc\n',
  '/off/f5.txt': 'café abc\nxéy abc\n',
  '/off/empty.txt': 'ab\n',
}

function offsetStatFn(path: string): Promise<FileStat> {
  if (path === '/off') {
    return Promise.resolve(new FileStat({ name: 'off', type: FileType.DIRECTORY }))
  }
  const content = OFFSET_FILES[path]
  if (content === undefined) return Promise.reject(new Error(`ENOENT: ${path}`))
  const name = path.split('/').pop() ?? ''
  return Promise.resolve(
    new FileStat({ name, type: FileType.FILE, content: ContentType.TEXT, size: content.length }),
  )
}

function offsetReadBytesFn(path: string): Promise<Uint8Array> {
  const content = OFFSET_FILES[path]
  if (content === undefined) return Promise.reject(new Error(`ENOENT: ${path}`))
  return Promise.resolve(ENC.encode(content))
}

function offsetReaddirFn(path: string): Promise<string[]> {
  if (path === '/off') return Promise.resolve(['/off/f1.txt'])
  return Promise.reject(new Error(`not a dir: ${path}`))
}

describe('rg -b / --byte-offset', () => {
  it('prints the line start offset', async () => {
    const out = await rgFull(
      offsetReaddirFn,
      offsetStatFn,
      offsetReadBytesFn,
      '/off/f1.txt',
      'abc',
      opts({ byteOffsets: true }),
      null,
    )
    expect(out).toEqual(['0:abc', '4:defabc', '11:abc abc'])
  })

  it('prints the match offset under -o', async () => {
    const out = await rgFull(
      offsetReaddirFn,
      offsetStatFn,
      offsetReadBytesFn,
      '/off/f1.txt',
      'abc',
      opts({ onlyMatching: true, byteOffsets: true }),
      null,
    )
    expect(out).toEqual(['0:abc', '7:abc', '11:abc', '15:abc'])
  })

  it('keeps GNU field order, line number then byte offset', async () => {
    const out = await rgFull(
      offsetReaddirFn,
      offsetStatFn,
      offsetReadBytesFn,
      '/off/f1.txt',
      'abc',
      opts({ lineNumbers: true, byteOffsets: true }),
      null,
    )
    expect(out).toEqual(['1:0:abc', '2:4:defabc', '3:11:abc abc'])
  })

  it('counts bytes rather than characters', async () => {
    const out = await rgFull(
      offsetReaddirFn,
      offsetStatFn,
      offsetReadBytesFn,
      '/off/f5.txt',
      'abc',
      opts({ onlyMatching: true, byteOffsets: true }),
      null,
    )
    expect(out).toEqual(['6:abc', '15:abc'])
  })

  it('puts the filename ahead of the fields in a walk', async () => {
    const out = await rgFull(
      offsetReaddirFn,
      offsetStatFn,
      offsetReadBytesFn,
      '/off',
      'abc',
      opts({ lineNumbers: true, byteOffsets: true }),
      null,
    )
    expect(out).toEqual([
      '/off/f1.txt:1:0:abc',
      '/off/f1.txt:2:4:defabc',
      '/off/f1.txt:3:11:abc abc',
    ])
  })

  it('carries no offset in a count', async () => {
    const out = await rgFull(
      offsetReaddirFn,
      offsetStatFn,
      offsetReadBytesFn,
      '/off',
      'abc',
      opts({ countOnly: true, byteOffsets: true }),
      null,
    )
    expect(out).toEqual(['/off/f1.txt:3'])
  })
})

describe('rgFull reports selection on the IOResult it is given', () => {
  // Selection cannot be read off the printed lines under -o: a directory
  // whose only matches are zero-width prints nothing and GNU still exits 0.
  function emptyReaddirFn(path: string): Promise<string[]> {
    if (path === '/off') return Promise.resolve(['/off/empty.txt'])
    return Promise.reject(new Error(`not a dir: ${path}`))
  }

  it('exits 0 for a directory whose only matches are empty', async () => {
    const io = new IOResult({ exitCode: 1 })
    const out = await rgFull(
      emptyReaddirFn,
      offsetStatFn,
      offsetReadBytesFn,
      '/off',
      '[0-9]*',
      opts({ onlyMatching: true }),
      null,
      null,
      io,
    )
    expect(out).toEqual([])
    expect(io.exitCode).toBe(0)
  })

  it('leaves the status alone when nothing was selected', async () => {
    const io = new IOResult({ exitCode: 1 })
    const out = await rgFull(
      emptyReaddirFn,
      offsetStatFn,
      offsetReadBytesFn,
      '/off',
      '[0-9]',
      opts({ onlyMatching: true }),
      null,
      null,
      io,
    )
    expect(out).toEqual([])
    expect(io.exitCode).toBe(1)
  })

  it('exits 0 for a single file whose only match is empty', async () => {
    const io = new IOResult({ exitCode: 1 })
    const out = await rgFull(
      emptyReaddirFn,
      offsetStatFn,
      offsetReadBytesFn,
      '/off/empty.txt',
      '[0-9]*',
      opts({ onlyMatching: true }),
      null,
      null,
      io,
    )
    expect(out).toEqual([])
    expect(io.exitCode).toBe(0)
  })
})

// A second fixture set, whose contents are raw bytes rather than text: the
// cases below turn on the exact bytes of a line terminator or of an invalid
// sequence, which a string fixture cannot express.
const RAW: Record<string, Uint8Array> = {
  '/raw/crlf.txt': new Uint8Array([0x61, 0x0d, 0x0a, 0x62, 0x0d, 0x0a]),
  '/raw/ab.txt': new Uint8Array([0x61, 0x0a, 0x62, 0x0a]),
  '/raw/vt.txt': new Uint8Array([0x61, 0x0b, 0x62, 0x0a]),
  '/raw/inv.bin': new Uint8Array([0xff, 0x0a, 0x61, 0x0a]),
  '/raw/inv2.bin': new Uint8Array([0xff, 0x61, 0x0a]),
  '/raw/m.txt': new Uint8Array([0x61, 0x0a, 0x61, 0x62, 0x0a, 0x62, 0x0a]),
  '/rawmw/x.txt': ENC.encode('a1\na2\n'),
  '/rawmw/y.txt': ENC.encode('a3\na4\n'),
  '/raw/ov.txt': ENC.encode('abc\ndef\n'),
  '/raw/f5.txt': ENC.encode('café abc\nxéy abc\n'),
}

function rawReaddirFn(path: string): Promise<string[]> {
  if (path === '/raw') return Promise.resolve(Object.keys(RAW))
  if (path === '/rawdir') return Promise.resolve(['/raw/ov.txt'])
  if (path === '/rawmw') return Promise.resolve(['/rawmw/x.txt', '/rawmw/y.txt'])
  return Promise.reject(new Error(`not a dir: ${path}`))
}

function rawStatFn(path: string): Promise<FileStat> {
  if (path === '/raw' || path === '/rawdir' || path === '/rawmw') {
    return Promise.resolve(new FileStat({ name: path, type: FileType.DIRECTORY }))
  }
  const content = RAW[path]
  if (content === undefined) return Promise.reject(new Error(`ENOENT: ${path}`))
  return Promise.resolve(
    new FileStat({
      name: path.split('/').pop() ?? '',
      type: FileType.FILE,
      content: ContentType.TEXT,
      size: content.length,
    }),
  )
}

function rawReadBytesFn(path: string): Promise<Uint8Array> {
  const content = RAW[path]
  if (content === undefined) return Promise.reject(new Error(`ENOENT: ${path}`))
  return Promise.resolve(content)
}

function raw(
  path: string,
  pattern: string,
  overrides: Partial<RgFullOptions> = {},
  io: IOResult | null = null,
): Promise<string[]> {
  return rgFull(
    rawReaddirFn,
    rawStatFn,
    rawReadBytesFn,
    path,
    pattern,
    opts(overrides),
    null,
    null,
    io,
  )
}

describe('rgFull splits on newlines only', () => {
  // GNU grep 3.11 and ripgrep 14.1.0 both end a line at `\n` and nothing
  // else: `rg -n -v zzz` over `a\r\nb\r\n` is `1:a\r` and `2:b\r`, and
  // `rg -b b` is `3:b\r`. Splitting on every Unicode break ate the carriage
  // returns and moved the offsets with them.
  it('keeps a carriage return in the line', async () => {
    expect(await raw('/raw/crlf.txt', 'zzz', { invert: true, lineNumbers: true })).toEqual([
      '1:a\r',
      '2:b\r',
    ])
  })

  it('counts a carriage return toward the byte offset', async () => {
    expect(await raw('/raw/crlf.txt', 'b', { byteOffsets: true })).toEqual(['3:b\r'])
  })

  it('does not open a last empty line for the terminator', async () => {
    expect(await raw('/raw/ab.txt', 'zzz', { invert: true, countOnly: true })).toEqual(['2'])
  })

  it('does not end a line at a vertical tab', async () => {
    expect(await raw('/raw/vt.txt', 'zzz', { invert: true, lineNumbers: true })).toEqual(['1:a\vb'])
  })
})

describe('rgFull -m 0 selects nothing', () => {
  // Measured: `rg -m0 a f`, `rg -m0 -c a f` and `rg -m0 -l a f` on ripgrep
  // 14.1.0 and the same three on GNU grep 3.11 all print zero bytes and
  // exit 1.
  it('prints nothing', async () => {
    const io = new IOResult({ exitCode: 1 })
    expect(await raw('/raw/m.txt', 'a', { maxCount: 0 }, io)).toEqual([])
    expect(io.exitCode).toBe(1)
  })

  it('counts nothing', async () => {
    expect(await raw('/raw/m.txt', 'a', { maxCount: 0, countOnly: true })).toEqual([])
  })

  it('names nothing', async () => {
    expect(await raw('/raw/m.txt', 'a', { maxCount: 0, filesOnly: true })).toEqual([])
  })

  it('prints nothing from a walk', async () => {
    expect(await raw('/rawdir', 'a', { maxCount: 0 })).toEqual([])
  })
})

describe('rgFull -o -v prints nothing', () => {
  // GNU grep 3.11 over `abc\ndef\n` answers zero bytes and exit 0 for
  // `grep -ov abc`, and `1` for `grep -ovc`. ripgrep prints the whole line,
  // and GNU is the reference this family already follows for -o.
  it('prints nothing', async () => {
    const io = new IOResult({ exitCode: 1 })
    expect(await raw('/raw/ov.txt', 'abc', { onlyMatching: true, invert: true }, io)).toEqual([])
    expect(io.exitCode).toBe(0)
  })

  it('still counts the selected line', async () => {
    expect(
      await raw('/raw/ov.txt', 'abc', { onlyMatching: true, invert: true, countOnly: true }),
    ).toEqual(['1'])
  })

  it('prints nothing from a walk', async () => {
    expect(await raw('/rawdir', 'abc', { onlyMatching: true, invert: true })).toEqual([])
  })
})

describe('rgFull offsets over a smuggled byte', () => {
  // `rg -b a` over `\xff\na\n` is `2:a` on ripgrep 14.1.0 and GNU grep 3.11;
  // `rg -bo a` over `\xffa\n` is `1:a`. A replacing decode read the invalid
  // byte as U+FFFD, three bytes wide, so both answers ran ahead.
  it('counts one byte for a line offset', async () => {
    expect(await raw('/raw/inv.bin', 'a', { byteOffsets: true })).toEqual(['2:a'])
  })

  it('counts one byte for a match offset', async () => {
    expect(await raw('/raw/inv2.bin', 'a', { byteOffsets: true, onlyMatching: true })).toEqual([
      '1:a',
    ])
  })

  it('counts the bytes of a multi-byte character', async () => {
    // Section Q6 of the GNU truth file: the match on line one is at byte 6,
    // not at the character index 5, and line two's is at 15.
    expect(await raw('/raw/f5.txt', 'abc', { byteOffsets: true, onlyMatching: true })).toEqual([
      '6:abc',
      '15:abc',
    ])
  })

  it('replaces a smuggled byte in the printed line', async () => {
    // The scan answers in `string[]`, which `formatRecords` encodes, so the
    // byte prints as U+FFFD -- what a replacing decode already gave, with
    // the offset now right.
    expect(await raw('/raw/inv2.bin', 'a', { byteOffsets: true })).toEqual(['0:�a'])
  })
})

describe('rgFull -l names the file', () => {
  it('answers with the path for a single unlabelled operand', async () => {
    // The path IS the output under -l, so it is never dropped for want of a
    // `-H`: this used to answer with an empty line where the python twin
    // answered with the file.
    expect(await raw('/raw/m.txt', 'a', { filesOnly: true })).toEqual(['/raw/m.txt'])
  })
})

describe('rgFolderFiletype reports selection on the io channel', () => {
  // The filetype walk is TypeScript-only, so nothing outside this file can
  // see it: `rg -o '[0-9]*' dir` over a line whose only match is empty
  // selects the line and prints nothing, and the branch answered 1 from the
  // empty list where `rgFull`, the python twin and `grep -o` all answer 0.
  function folderOpts(overrides: Partial<RgFolderFiletypeOptions> = {}): RgFolderFiletypeOptions {
    return {
      ignoreCase: false,
      invert: false,
      lineNumbers: false,
      countOnly: false,
      filesOnly: false,
      onlyMatching: false,
      maxCount: null,
      fixedString: false,
      wholeWord: false,
      fileType: null,
      globPattern: null,
      hidden: false,
      ...overrides,
    }
  }

  it('reports a selection an empty match printed nothing for', async () => {
    const io = new IOResult({ exitCode: 1 })
    const hits = await rgFolderFiletype(
      rawReaddirFn,
      rawStatFn,
      rawReadBytesFn,
      '/rawdir',
      '[0-9]*',
      folderOpts({ onlyMatching: true }),
      null,
      io,
    )
    expect([hits, io.exitCode]).toEqual([[], 0])
  })

  it('leaves the status alone when nothing was selected', async () => {
    const io = new IOResult({ exitCode: 1 })
    const hits = await rgFolderFiletype(
      rawReaddirFn,
      rawStatFn,
      rawReadBytesFn,
      '/rawdir',
      'zzz',
      folderOpts(),
      null,
      io,
    )
    expect([hits, io.exitCode]).toEqual([[], 1])
  })
})

describe('rgFull -m N counts per file in a walk', () => {
  // `rg -m1 a dir` prints one line per file on ripgrep 14.1.0, and the limit
  // restarts for the next file. The python twin's walk had the limit only
  // inside its count arm, so it printed every match where this one stopped
  // at the first.
  it('prints one line per file', async () => {
    expect(await raw('/rawmw', 'a', { maxCount: 1, lineNumbers: true })).toEqual([
      '/rawmw/x.txt:1:a1',
      '/rawmw/y.txt:1:a3',
    ])
  })

  it('prints two lines per file', async () => {
    expect(await raw('/rawmw', 'a', { maxCount: 2, lineNumbers: true })).toEqual([
      '/rawmw/x.txt:1:a1',
      '/rawmw/x.txt:2:a2',
      '/rawmw/y.txt:1:a3',
      '/rawmw/y.txt:2:a4',
    ])
  })
})
