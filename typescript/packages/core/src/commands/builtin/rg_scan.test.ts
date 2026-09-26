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
import { IOResult, materialize } from '../../io/types.ts'
import { ContentType, FileStat, FileType, PathSpec } from '../../types.ts'
import type { CommandOpts } from '../config.ts'
import { specOf } from '../spec/builtins.ts'
import { FlagView } from '../spec/flag_view.ts'
import type { FlagValue } from '../spec/types.ts'
import { parseFlags, rgGeneric, walkFilter } from './generic/rg.ts'
import { enoent } from '../../utils/errors.ts'
import { decodeLine } from './grep_offsets.ts'
import { type WalkFilter, walkCandidates } from './rg_scan.ts'

// The keywords the scan used to take, which these cases were written
// against.
interface RgFullOptions {
  ignoreCase: boolean
  invert: boolean
  lineNumbers: boolean
  countOnly: boolean
  filesOnly: boolean
  filesWithoutMatch?: boolean
  fixedString: boolean
  onlyMatching: boolean
  maxCount: number | null
  wholeWord: boolean
  contextBefore: number
  contextAfter: number
  fileType: string | null
  globPattern: string | null
  hidden: boolean
  byteOffsets?: boolean
  noFilename?: boolean
}

// Each keyword as the rg dest it stands for.
const DESTS: Readonly<Record<string, string>> = {
  ignoreCase: 'ignore_case',
  invert: 'invert_match',
  lineNumbers: 'line_number',
  countOnly: 'count',
  filesOnly: 'files_with_matches',
  filesWithoutMatch: 'files_without_match',
  fixedString: 'fixed_strings',
  onlyMatching: 'only_matching',
  wholeWord: 'word_regexp',
  hidden: 'hidden',
  byteOffsets: 'byte_offset',
  noFilename: 'no_filename',
  maxCount: 'max_count',
  contextBefore: 'before_context',
  contextAfter: 'after_context',
}

/**
 * Run the generic rg over one operand and answer with its printed lines, the
 * way the scan these cases were written for answered. `warnings` receives
 * stderr's lines, a `label` names the file on every line (-H), and `io`
 * receives the exit status.
 */
async function rgFull(
  readdirFn: (path: string) => Promise<string[]>,
  statFn: (path: string) => Promise<FileStat>,
  readBytesFn: (path: string) => Promise<Uint8Array>,
  path: string,
  pattern: string,
  options: RgFullOptions,
  warnings: string[] | null,
  label: string | null = null,
  io: IOResult | null = null,
): Promise<string[]> {
  const flags: Record<string, FlagValue> = {}
  for (const [key, value] of Object.entries(options)) {
    const dest = DESTS[key]
    if (dest === undefined || value === null || value === false) continue
    if (typeof value === 'number') {
      if (key !== 'maxCount' && value === 0) continue
      flags[dest] = String(value)
    } else if (typeof value === 'boolean') flags[dest] = value
  }
  if (options.fileType !== null) flags.type = [options.fileType]
  if (options.globPattern !== null) flags.glob = [options.globPattern]
  if (label !== null) flags.with_filename = true
  const opts = { stdin: null, flags, filetypeFns: null, cwd: '/' } as unknown as CommandOpts
  const operand = new PathSpec({ virtual: path, directory: path, vfsPath: path.slice(1) })
  const [out, result] = (await rgGeneric(
    [operand],
    [pattern],
    opts,
    (p) => statFn(p.virtual),
    (p) => readdirFn(p.virtual),
    async function* (p) {
      yield await readBytesFn(p.virtual)
    },
  )) as [Uint8Array | AsyncIterable<Uint8Array> | null, IOResult]
  const text = out === null ? '' : decodeLine(await materialize(out))
  if (io !== null) io.exitCode = result.exitCode
  if (warnings !== null) {
    const stderr = decodeLine(await materialize(result.stderr))
    if (stderr !== '') warnings.push(...stderr.split('\n').slice(0, -1))
  }
  return text === '' ? [] : text.split('\n').slice(0, -1)
}

function walk(flags: Record<string, FlagValue> = {}): WalkFilter {
  return walkFilter(parseFlags(new FlagView(flags, specOf('rg'))))
}

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

// The overrides go last and in the order given, which is line order to a
// last-wins option (`--files-without-match -c` prints counts).
function opts(overrides: Partial<RgFullOptions> = {}): RgFullOptions {
  const base: Record<string, unknown> = {
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
  }
  for (const key of Object.keys(overrides)) Reflect.deleteProperty(base, key)
  return { ...base, ...overrides } as RgFullOptions
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

  it('prints labelled context on directory walks', async () => {
    // ripgrep 14.1.1 prints context in a walk too, each line led by its
    // file's name: `name:` on a match, `name-` on context.
    const out = await rgFull(
      logReaddirFn,
      logStatFn,
      logReadBytesFn,
      '/log',
      'warning',
      opts({ contextAfter: 1 }),
      null,
    )
    expect(out).toEqual(['/log/app.log:warning: low memory', '/log/app.log-info: all good'])
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

describe('rgFull -o ripgrep semantics', () => {
  // ripgrep 14.1.1: every match prints on its own line, an empty one included,
  // found the way Rust's regex iterates, and -c counts the matches.
  it('prints each empty match and counts it', async () => {
    const printed = await rgFull(
      digitReaddirFn,
      digitStatFn,
      digitReadBytesFn,
      '/num/one.txt',
      '[0-9]*',
      opts({ onlyMatching: true }),
      null,
    )
    expect(printed).toEqual(['', '', ''])
    const counted = await rgFull(
      digitReaddirFn,
      digitStatFn,
      digitReadBytesFn,
      '/num/one.txt',
      '[0-9]*',
      opts({ onlyMatching: true, countOnly: true }),
      null,
    )
    expect(counted).toEqual(['3'])
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

  it('prints the empty matches around a non-empty one', async () => {
    const out = await rgFull(
      digitReaddirFn,
      digitStatFn,
      digitReadBytesFn,
      '/num/three.txt',
      '[0-9]*',
      opts({ onlyMatching: true }),
      null,
    )
    expect(out).toEqual(['', '1', ''])
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
  // The status rides the IOResult, not the printed lines; a zero-width match
  // selects its line and prints an empty piece.
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
    expect(out).toEqual(['/off/empty.txt:', '/off/empty.txt:', '/off/empty.txt:'])
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
    expect(out).toEqual(['', '', ''])
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

describe('rgFull -o -v prints each selected line whole', () => {
  // ripgrep 14.1.1 over `abc\ndef\n` answers `def` for `rg -ov abc` and `0`
  // for `rg -ovc abc`, counting matches, where GNU grep prints nothing and
  // counts the line. rg follows ripgrep.
  it('prints the line whole', async () => {
    const io = new IOResult({ exitCode: 1 })
    expect(await raw('/raw/ov.txt', 'abc', { onlyMatching: true, invert: true }, io)).toEqual([
      'def',
    ])
    expect(io.exitCode).toBe(0)
  })

  it('counts no matches', async () => {
    expect(
      await raw('/raw/ov.txt', 'abc', { onlyMatching: true, invert: true, countOnly: true }),
    ).toEqual(['0'])
  })

  it('prints the line whole from a walk', async () => {
    expect(await raw('/rawdir', 'abc', { onlyMatching: true, invert: true })).toEqual([
      '/raw/ov.txt:def',
    ])
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

  it('keeps a smuggled byte in the printed line', async () => {
    // The scan answers in `string[]`, and the byte rides through as the
    // sentinel `decodeLine` gave it: `formatRecords` puts it back as itself,
    // which is what ripgrep prints (measured 14.1.1: `\377` reaches the
    // terminal raw, never as U+FFFD).
    expect(await raw('/raw/inv2.bin', 'a', { byteOffsets: true })).toEqual(['0:\udcffa'])
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

// ripgrep's --files-without-match: the paths that selected no line. -c
// outranks it (ripgrep 14.1.1 prints counts), and -m0 lists nothing since it
// is read before the scan. Mirrored in test_rg_scan.py.
describe('rgFull --files-without-match', () => {
  it('lists a matchless file and not a matching one', async () => {
    expect(await raw('/raw/m.txt', 'zzz', { filesWithoutMatch: true })).toEqual(['/raw/m.txt'])
    expect(await raw('/raw/m.txt', 'a', { filesWithoutMatch: true })).toEqual([])
  })

  it('yields to a later -c and lists nothing under -m0', async () => {
    // ripgrep 14.1.1: `--files-without-match -c` prints counts, and
    // `-c --files-without-match` lists the matchless files.
    expect(await raw('/raw/m.txt', 'a', { filesWithoutMatch: true, countOnly: true })).toEqual(
      await raw('/raw/m.txt', 'a', { countOnly: true }),
    )
    expect(await raw('/raw/m.txt', 'a', { countOnly: true, filesWithoutMatch: true })).toEqual([])
    expect(await raw('/raw/m.txt', 'zzz', { filesWithoutMatch: true, maxCount: 0 })).toEqual([])
  })
})

// A walk prints context the way ripgrep 14.1.1 does: every line leads with its
// file's name, `name:` on a match and `name-` on context, and `--` sits between
// one file's context and the next file's.
describe('rgFull walk context', () => {
  const WALK: Record<string, string> = {
    '/w/a.txt': 'x\nhit\ny\n',
    '/w/b.txt': 'miss\n',
    '/w/c.txt': 'hit\nz\n',
  }
  const readdirFn = (path: string): Promise<string[]> =>
    path === '/w'
      ? Promise.resolve(Object.keys(WALK))
      : Promise.reject(new Error(`ENOTDIR: ${path}`))
  const statFn = (path: string): Promise<FileStat> =>
    path === '/w'
      ? Promise.resolve(new FileStat({ name: 'w', type: FileType.DIRECTORY }))
      : Promise.resolve(new FileStat({ name: path.slice(3), type: FileType.FILE }))
  const readBytesFn = (path: string): Promise<Uint8Array> =>
    Promise.resolve(ENC.encode(WALK[path] ?? ''))

  it('labels every line and separates the files that print', async () => {
    const out = await rgFull(
      readdirFn,
      statFn,
      readBytesFn,
      '/w',
      'hit',
      opts({ contextAfter: 1, lineNumbers: true }),
      null,
    )
    expect(out).toEqual(['/w/a.txt:2:hit', '/w/a.txt-3-y', '--', '/w/c.txt:1:hit', '/w/c.txt-2-z'])
  })

  it('gives counts no separator', async () => {
    const out = await rgFull(
      readdirFn,
      statFn,
      readBytesFn,
      '/w',
      'hit',
      opts({ contextAfter: 1, countOnly: true }),
      null,
    )
    expect(out).toEqual(['/w/a.txt:1', '/w/c.txt:1'])
  })
})

describe('walkCandidates', () => {
  // Narrowed candidates pass the filters the walk they replace applies.
  const scope = (virtual = '/data'): PathSpec =>
    new PathSpec({ virtual, directory: virtual, vfsPath: '' })
  const candidate = (virtual: string): PathSpec =>
    new PathSpec({
      virtual,
      directory: '',
      vfsPath: virtual.replace(/^\/data\//, ''),
      resolved: true,
    })

  it('prunes below the longest matching scope', () => {
    const kept = walkCandidates(
      [candidate('/data/.cfg/a.txt'), candidate('/data/.cfg/.secret')],
      [scope(), scope('/data/.cfg')],
      walk(),
      '/',
    )
    expect(kept.map((p) => p.virtual)).toEqual(['/data/.cfg/a.txt'])
  })

  it('drops dotfiles below the scope', () => {
    const kept = walkCandidates(
      [candidate('/data/.env'), candidate('/data/.git/config'), candidate('/data/a.txt')],
      [scope()],
      walk(),
      '/',
    )
    expect(kept.map((p) => p.virtual)).toEqual(['/data/a.txt'])
  })

  it('keeps dotfiles under --hidden', () => {
    const paths = [candidate('/data/.env'), candidate('/data/a.txt')]
    expect(walkCandidates(paths, [scope()], walk({ hidden: true }), '/')).toEqual(paths)
  })

  it('ignores dots in the scope itself', () => {
    const kept = walkCandidates([candidate('/data/.cfg/a.txt')], [scope('/data/.cfg')], walk(), '/')
    expect(kept.map((p) => p.virtual)).toEqual(['/data/.cfg/a.txt'])
  })

  it('applies --type and --glob to the file', () => {
    const paths = [candidate('/data/a.py'), candidate('/data/b.md')]
    expect(
      walkCandidates(paths, [scope()], walk({ type: ['py'] }), '/').map((p) => p.virtual),
    ).toEqual(['/data/a.py'])
    expect(
      walkCandidates(paths, [scope()], walk({ glob: ['*.md'] }), '/').map((p) => p.virtual),
    ).toEqual(['/data/b.md'])
  })
})

// ripgrep 14.1.1 searches a file named on the line whatever --type, --glob or
// a leading dot say (`rg --type rust b in` prints `b`); a walked file is still
// filtered.
describe('rgFull named operands', () => {
  const NAMED: Record<string, string> = { '/t/.in': 'b\n', '/t/w/in': 'b\n', '/t/w/.h.rs': 'b\n' }
  const readdirFn = (path: string): Promise<string[]> =>
    path === '/t/w'
      ? Promise.resolve(['/t/w/in', '/t/w/.h.rs'])
      : Promise.reject(new Error(`ENOTDIR: ${path}`))
  const statFn = (path: string): Promise<FileStat> =>
    Promise.resolve(
      new FileStat({
        name: path.slice(path.lastIndexOf('/') + 1),
        type: path === '/t/w' ? FileType.DIRECTORY : FileType.FILE,
      }),
    )
  const readBytesFn = (path: string): Promise<Uint8Array> =>
    Promise.resolve(ENC.encode(NAMED[path] ?? ''))

  it.each([[{ fileType: 'rust' }], [{ globPattern: '*.rs' }], [{}]])(
    'searches a named file: %j',
    async (filters) => {
      const out = await rgFull(
        readdirFn,
        statFn,
        readBytesFn,
        '/t/.in',
        'b',
        opts({ lineNumbers: true, ...filters }),
        null,
      )
      expect(out).toEqual(['1:b'])
    },
  )

  it('still filters a walked file', async () => {
    // The type keeps .h.rs whatever its leading dot says (ripgrep 14.1.1's
    // `rg -t txt` searches .hid.txt), and drops `in`.
    const out = await rgFull(
      readdirFn,
      statFn,
      readBytesFn,
      '/t/w',
      'b',
      opts({ fileType: 'rust' }),
      null,
    )
    expect(out).toEqual(['/t/w/.h.rs:b'])
  })
})

describe('rgFull warnings', () => {
  it('names a walked path it could not read as typed', async () => {
    const warnings: string[] = []
    const readSome = (p: string): Promise<Uint8Array> =>
      p === '/db/b.txt' ? Promise.reject(enoent(p)) : readBytesFn(p)
    const out = await rgFull(readdirFn, statFn, readSome, '/db', 'Graph', opts(), warnings)
    expect(out).toEqual(['/db/a.txt:Graph', '/db/a.txt:Graph again'])
    expect(warnings).toEqual(['rg: /db/b.txt: No such file or directory'])
  })
})
