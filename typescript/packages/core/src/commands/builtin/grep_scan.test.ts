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
  grepFilesOnly,
  grepLines,
  grepStream,
  type GrepLinesOptions,
  type GrepStreamOptions,
} from './grep_scan.ts'

const ENC = new TextEncoder()

describe('grepFilesOnly', () => {
  it('scans file operands under recursive instead of walking them', async () => {
    // GNU: `grep -rl pat file` treats the operand as a file; only directory
    // operands are walked (search-narrowed candidates arrive as files).
    const readdirFn = (path: string): Promise<string[]> => Promise.reject(new Error(path))
    const statFn = (path: string): Promise<FileStat> =>
      Promise.resolve(new FileStat({ name: path, type: FileType.FILE, content: ContentType.TEXT }))
    const readBytesFn = (): Promise<Uint8Array> => Promise.resolve(ENC.encode('alpha beta\n'))
    const hits = await grepFilesOnly(readdirFn, statFn, readBytesFn, '/data/notes.txt', 'alpha', {
      recursive: true,
      ignoreCase: false,
      invert: false,
      lineNumbers: false,
      countOnly: false,
      fixedString: false,
      onlyMatching: false,
      maxCount: null,
      wholeWord: false,
      basic: true,
    })
    expect(hits).toEqual(['/data/notes.txt'])
  })
})

const DEC = new TextDecoder()

async function* bytesOf(text: string): AsyncIterable<Uint8Array> {
  await Promise.resolve()
  yield ENC.encode(text)
}

// Bounded drive of the generator: a pattern that can match the empty string
// used to leave reGlobal.lastIndex where it was, so grepStream yielded
// forever. Neither the integ nor the conformance schema has a per-case
// timeout, so a regression there would burn the whole job; stopping after
// `limit` yields turns it into an assertion instead.
async function take(
  source: AsyncIterable<Uint8Array>,
  limit: number,
): Promise<{ text: string; capped: boolean }> {
  const parts: string[] = []
  let capped = false
  for await (const chunk of source) {
    if (parts.length >= limit) {
      capped = true
      break
    }
    parts.push(DEC.decode(chunk))
  }
  return { text: parts.join(''), capped }
}

function streamOpts(overrides: Partial<GrepStreamOptions> = {}): GrepStreamOptions {
  return {
    invert: false,
    lineNumbers: false,
    onlyMatching: true,
    maxCount: null,
    countOnly: false,
    afterContext: 0,
    beforeContext: 0,
    ...overrides,
  }
}

function lineOpts(overrides: Partial<GrepLinesOptions> = {}): GrepLinesOptions {
  return {
    invert: false,
    lineNumbers: false,
    countOnly: false,
    filesOnly: false,
    onlyMatching: true,
    maxCount: null,
    ...overrides,
  }
}

describe('grepStream -o terminates on an empty-matching pattern', () => {
  it.each([
    ['[0-9]*', 'ab\n'],
    ['', 'ab\n'],
    ['^', 'ab\n'],
    ['$', 'ab\n'],
    ['[0-9]*', 'a\nb\n'],
  ])('finishes for /%s/ over %j', async (source, input) => {
    const got = await take(grepStream(bytesOf(input), new RegExp(source), streamOpts()), 64)
    expect(got.capped).toBe(false)
    expect(got.text).toBe('')
  })
})

describe('grepStream -o GNU semantics', () => {
  // GNU grep 3.11: `printf 'ab\n' | grep -o '[0-9]*'` writes 0 bytes and
  // exits 0, while `grep -oc '[0-9]*'` says 1 — an empty match prints
  // nothing but the line is still selected.
  it('prints nothing for an empty match yet counts the line', async () => {
    const printed = await take(grepStream(bytesOf('ab\n'), /[0-9]*/, streamOpts()), 64)
    expect(printed.text).toBe('')
    const counted = await take(
      grepStream(bytesOf('ab\n'), /[0-9]*/, streamOpts({ countOnly: true })),
      64,
    )
    expect(counted.text).toBe('1\n')
  })

  it('counts selected lines, not matches, under -c', async () => {
    const counted = await take(
      grepStream(bytesOf('a1b2c\n'), /[0-9]/, streamOpts({ countOnly: true })),
      64,
    )
    expect(counted.text).toBe('1\n')
  })

  it.each([
    ['a1b\n', '[0-9]*', '1\n'],
    ['a1b2c\n', '[0-9]', '1\n2\n'],
    ['1a22b\n', '[0-9]*', '1\n22\n'],
    ['abc\n', 'b*', 'b\n'],
  ])('prints every non-empty match of /%s/ in %j', async (input, source, expected) => {
    const got = await take(grepStream(bytesOf(input), new RegExp(source), streamOpts()), 64)
    expect(got.capped).toBe(false)
    expect(got.text).toBe(expected)
  })
})

describe('grepLines -o GNU semantics', () => {
  it('prints nothing for an empty match yet counts the line', () => {
    expect(grepLines('/p', ['ab'], /[0-9]*/, lineOpts())).toEqual([])
    expect(grepLines('/p', ['ab'], /[0-9]*/, lineOpts({ countOnly: true }))).toEqual(['1'])
    expect(grepLines('/p', ['ab'], /[0-9]*/, lineOpts({ filesOnly: true }))).toEqual(['/p'])
  })

  it('prints every non-empty match on the line, one per entry', () => {
    expect(grepLines('/p', ['a1b'], /[0-9]*/, lineOpts())).toEqual(['1'])
    expect(grepLines('/p', ['a1b2c'], /[0-9]/, lineOpts())).toEqual(['1', '2'])
    expect(grepLines('/p', ['1a22b'], /[0-9]*/, lineOpts())).toEqual(['1', '22'])
    expect(grepLines('/p', ['abc'], /b*/, lineOpts())).toEqual(['b'])
  })

  it('numbers every match of the line it came from', () => {
    expect(grepLines('/p', ['x', 'a1b2c'], /[0-9]/, lineOpts({ lineNumbers: true }))).toEqual([
      '2:1',
      '2:2',
    ])
  })
})

describe('grepStream reports selection on the IOResult it is given', () => {
  // The other half of GNU's -o rule: a line whose only match was empty
  // prints nothing, so the caller cannot read the exit status off an empty
  // stream. `printf 'ab\n' | grep -o '[0-9]*'` writes 0 bytes and exits 0.
  it('exits 0 for a line selected by an empty match', async () => {
    const io = new IOResult()
    const got = await take(grepStream(bytesOf('ab\n'), /[0-9]*/, streamOpts({ io })), 64)
    expect(got.text).toBe('')
    expect(io.exitCode).toBe(0)
  })

  it('exits 1 when no line was selected at all', async () => {
    const io = new IOResult()
    const got = await take(grepStream(bytesOf('ab\n'), /[0-9]/, streamOpts({ io })), 64)
    expect(got.text).toBe('')
    expect(io.exitCode).toBe(1)
  })
})

describe('-b through the select and stream paths', () => {
  // The byte layout is section Q1 of the GNU truth file (GNU grep 3.11).
  const F1 = ['abc', 'defabc', 'abc abc']

  it('prints the line start offset', () => {
    const opts = lineOpts({ onlyMatching: false, byteOffsets: true })
    expect(grepLines('/p', F1, /abc/, opts)).toEqual(['0:abc', '4:defabc', '11:abc abc'])
  })

  it('prints the match offset under -o', () => {
    expect(grepLines('/p', F1, /abc/, lineOpts({ byteOffsets: true }))).toEqual([
      '0:abc',
      '7:abc',
      '11:abc',
      '15:abc',
    ])
  })

  it('keeps GNU field order whatever the flags', () => {
    expect(
      grepLines(
        '/p',
        ['abc', 'defabc'],
        /abc/,
        lineOpts({ onlyMatching: false, lineNumbers: true, byteOffsets: true }),
      ),
    ).toEqual(['1:0:abc', '2:4:defabc'])
  })

  it('counts bytes rather than characters', () => {
    // `caf` + U+00E9 (two bytes) + a space is six bytes.
    expect(
      grepLines('/p', ['café abc', 'xéy abc'], /abc/, lineOpts({ byteOffsets: true })),
    ).toEqual(['6:abc', '15:abc'])
  })

  it('leaves a count and a file list alone', () => {
    expect(grepLines('/p', F1, /abc/, lineOpts({ countOnly: true, byteOffsets: true }))).toEqual([
      '3',
    ])
    expect(grepLines('/p', F1, /abc/, lineOpts({ filesOnly: true, byteOffsets: true }))).toEqual([
      '/p',
    ])
  })

  it('prints the offsets of the lines -v selected', () => {
    expect(
      grepLines(
        '/p',
        ['one', 'two abc', 'three', 'four abc', 'five'],
        /abc/,
        lineOpts({ onlyMatching: false, invert: true, byteOffsets: true }),
      ),
    ).toEqual(['0:one', '12:three', '27:five'])
  })

  it('streams the line start offset', async () => {
    const io = new IOResult()
    const got = await take(
      grepStream(
        bytesOf('abc\ndefabc\nabc abc\n'),
        /abc/,
        streamOpts({ onlyMatching: false, byteOffsets: true, io }),
      ),
      64,
    )
    expect(got.text).toBe('0:abc\n4:defabc\n11:abc abc\n')
    expect(io.exitCode).toBe(0)
  })

  it('streams the match offset under -o, with the line number first', async () => {
    const got = await take(
      grepStream(
        bytesOf('abc\ndefabc\nabc abc\n'),
        /abc/,
        streamOpts({ lineNumbers: true, byteOffsets: true }),
      ),
      64,
    )
    expect(got.text).toBe('1:0:abc\n2:7:abc\n3:11:abc\n3:15:abc\n')
  })

  it('does not double-count a missing final newline', async () => {
    const got = await take(
      grepStream(bytesOf('abc\nno-newline-abc'), /abc/, streamOpts({ byteOffsets: true })),
      64,
    )
    expect(got.text).toBe('0:abc\n15:abc\n')
  })

  it('prints nothing for an empty match under -ob and still exits 0', async () => {
    const io = new IOResult()
    const got = await take(
      grepStream(bytesOf('ab\n'), /[0-9]*/, streamOpts({ byteOffsets: true, io })),
      64,
    )
    expect(got.text).toBe('')
    expect(io.exitCode).toBe(0)
  })

  it('gives every field on a context line the dash separator', async () => {
    const got = await take(
      grepStream(
        bytesOf('one\ntwo abc\nthree\nfour abc\nfive\n'),
        /abc/,
        streamOpts({
          onlyMatching: false,
          lineNumbers: true,
          byteOffsets: true,
          afterContext: 1,
          beforeContext: 1,
        }),
      ),
      64,
    )
    expect(got.text).toBe('1-0-one\n2:4:two abc\n3-12-three\n4:18:four abc\n5-27-five\n')
  })

  it('leaves a count alone', async () => {
    const got = await take(
      grepStream(
        bytesOf('abc\ndefabc\n'),
        /abc/,
        streamOpts({ onlyMatching: false, countOnly: true, byteOffsets: true }),
      ),
      64,
    )
    expect(got.text).toBe('2\n')
  })
})

// A source of raw bytes, for the cases whose input is not valid UTF-8.
async function* rawOf(bytes: number[]): AsyncIterable<Uint8Array> {
  await Promise.resolve()
  yield new Uint8Array(bytes)
}

// Drive the generator to completion and keep the bytes, not the text.
async function rawTake(source: AsyncIterable<Uint8Array>): Promise<number[]> {
  const out: number[] = []
  for await (const chunk of source) out.push(...chunk)
  return out
}

describe('-m 0 selects nothing', () => {
  // Measured on GNU grep 3.11: `grep -m0 a f`, `grep -m0 -c a f`,
  // `grep -m0 -v a f` and `grep -m0 -l a f` all print zero bytes and exit 1.
  // Reading the limit only after a line was printed let the first selected
  // line out first, because `count >= 0` is already true.
  it('prints no line', () => {
    expect(grepLines('/f.txt', ['a', 'ab', 'b'], /a/, lineOpts({ maxCount: 0 }))).toEqual([])
  })

  it('counts nothing', () => {
    // Not `['0']`: `grepRecursive` renders `<file>:<count>` from whatever
    // comes back, and GNU prints no per-file zeros under -m0.
    expect(
      grepLines('/f.txt', ['a', 'ab', 'b'], /a/, lineOpts({ maxCount: 0, countOnly: true })),
    ).toEqual([])
  })

  it('names no file', () => {
    expect(
      grepLines('/f.txt', ['a', 'ab', 'b'], /a/, lineOpts({ maxCount: 0, filesOnly: true })),
    ).toEqual([])
  })

  it('reports no selection', () => {
    const io = new IOResult({ exitCode: 1 })
    grepLines('/f.txt', ['a', 'ab', 'b'], /a/, lineOpts({ maxCount: 0, io }))
    expect(io.exitCode).toBe(1)
  })

  it('streams nothing', async () => {
    const io = new IOResult({ exitCode: 1 })
    const got = await take(
      grepStream(bytesOf('a\nab\nb\n'), /a/, streamOpts({ maxCount: 0, io })),
      64,
    )
    expect([got.text, io.exitCode]).toEqual(['', 1])
  })

  it('streams nothing under -c', async () => {
    // Zero bytes, not `0\n` -- GNU prints nothing for `grep -m0 -c`, and
    // `grepInput` answers the same way.
    const io = new IOResult({ exitCode: 1 })
    const got = await take(
      grepStream(bytesOf('a\nab\nb\n'), /a/, streamOpts({ maxCount: 0, countOnly: true, io })),
      64,
    )
    expect([got.text, io.exitCode]).toEqual(['', 1])
  })

  it('still streams a genuine zero', async () => {
    // The mirror: without -m0 a real zero is still `0`.
    const io = new IOResult({ exitCode: 1 })
    const got = await take(
      grepStream(bytesOf('a\nb\n'), /zzz/, streamOpts({ countOnly: true, io })),
      64,
    )
    expect([got.text, io.exitCode]).toEqual(['0\n', 1])
  })

  it('streams no context', async () => {
    const io = new IOResult({ exitCode: 1 })
    const got = await take(
      grepStream(
        bytesOf('a\nab\nb\n'),
        /a/,
        streamOpts({ maxCount: 0, onlyMatching: false, afterContext: 1, beforeContext: 1, io }),
      ),
      64,
    )
    expect([got.text, io.exitCode]).toEqual(['', 1])
  })
})

describe('-o -v prints nothing', () => {
  // Measured on GNU grep 3.11 over `abc\ndef\n`: `grep -ov abc` is zero bytes
  // and exit 0, `grep -ovc abc` is `1`, and `grep -ovl abc` names the file.
  // ripgrep prints the whole line instead; GNU is the reference the rest of
  // this family already follows for -o.
  it('prints no line', () => {
    expect(grepLines('/f.txt', ['abc', 'def'], /abc/, lineOpts({ invert: true }))).toEqual([])
  })

  it('still counts the selected line', () => {
    expect(
      grepLines('/f.txt', ['abc', 'def'], /abc/, lineOpts({ invert: true, countOnly: true })),
    ).toEqual(['1'])
  })

  it('still names the file', () => {
    expect(
      grepLines('/f.txt', ['abc', 'def'], /abc/, lineOpts({ invert: true, filesOnly: true })),
    ).toEqual(['/f.txt'])
  })

  it('still reports selection', () => {
    const io = new IOResult({ exitCode: 1 })
    grepLines('/f.txt', ['abc', 'def'], /abc/, lineOpts({ invert: true, io }))
    expect(io.exitCode).toBe(0)
  })

  it('streams nothing', async () => {
    const io = new IOResult({ exitCode: 1 })
    const got = await take(
      grepStream(bytesOf('abc\ndef\n'), /abc/, streamOpts({ invert: true, io })),
      64,
    )
    expect([got.text, io.exitCode]).toEqual(['', 0])
  })

  it('streams the selected count', async () => {
    const got = await take(
      grepStream(bytesOf('abc\ndef\n'), /abc/, streamOpts({ invert: true, countOnly: true })),
      64,
    )
    expect(got.text).toBe('1\n')
  })
})

describe('offsets over a smuggled byte', () => {
  // `grep -bo a` over `\xffa\n` is `1:a` on GNU grep 3.11, and `grep -b a`
  // over `\xff\na\n` is `2:a`. A replacing decode read the invalid byte as
  // U+FFFD, three bytes wide, so both answers ran ahead.
  it('counts one byte for a match offset', async () => {
    const got = await rawTake(
      grepStream(rawOf([0xff, 0x61, 0x0a]), /a/, streamOpts({ byteOffsets: true })),
    )
    expect(got).toEqual([...ENC.encode('1:a\n')])
  })

  it('counts one byte for a line offset', async () => {
    const got = await rawTake(
      grepStream(
        rawOf([0xff, 0x0a, 0x61, 0x0a]),
        /a/,
        streamOpts({ onlyMatching: false, byteOffsets: true }),
      ),
    )
    expect(got).toEqual([...ENC.encode('2:a\n')])
  })

  it('prints the raw byte back on a streamed line', async () => {
    const got = await rawTake(
      grepStream(
        rawOf([0xff, 0x61, 0x0a]),
        /./,
        streamOpts({ onlyMatching: false, byteOffsets: true }),
      ),
    )
    expect(got).toEqual([0x30, 0x3a, 0xff, 0x61, 0x0a])
  })

  it('counts one byte in a list-returning scan', () => {
    expect(grepLines('/f.txt', ['\udcffa'], /a/, lineOpts({ byteOffsets: true }))).toEqual(['1:a'])
  })

  it('replaces a smuggled byte on the way out of a list-returning scan', () => {
    // A list-returning scan hands its lines to `formatRecords`, so the byte
    // comes back as U+FFFD -- exactly what a replacing decode used to give,
    // with the offset now right.
    expect(
      grepLines('/f.txt', ['\udcffa'], /a/, lineOpts({ onlyMatching: false, byteOffsets: true })),
    ).toEqual(['0:�a'])
  })
})
