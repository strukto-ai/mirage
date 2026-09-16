import { describe, expect, it } from 'vitest'
import { specOf } from '../spec/builtins.ts'
import { FlagView } from '../spec/types.ts'
import { IOResult, materialize } from '../../io/types.ts'
import { parseFlags } from './generic/grep.ts'
import { grepInput, PROBE_BLOCK_BYTES } from './grep_binary.ts'
import { parseCommand, parseToKwargs } from '../spec/parser.ts'
import { UsageError } from '../errors.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

describe.each([1, 2, 7, 1024, PROBE_BLOCK_BYTES])(
  'binary grep with %i-byte backend chunks',
  (size) => {
    it.each([
      ['binary', '', 'grep: /remote/data.pdf: binary file matches\n', 0],
      ['without-match', '', '', 1],
      ['text', '2:needle\0tail\n', '', 0],
    ] as const)(
      '%s mode is independent of transport chunking',
      async (mode, stdout, stderr, code) => {
        const data = ENC.encode('before\nneedle\0tail\n')
        async function* source(): AsyncIterable<Uint8Array> {
          await Promise.resolve()
          for (let at = 0; at < data.length; at += size) yield data.subarray(at, at + size)
        }
        const f = parseFlags(new FlagView({ binary_files: mode, n: true }, specOf('grep')))
        const io = new IOResult({ exitCode: 1 })
        const out = await materialize(
          grepInput(source(), /needle/, f, '/remote/data.pdf', false, io),
        )
        expect(DEC.decode(out)).toBe(stdout)
        expect(DEC.decode((io.stderr as Uint8Array | null) ?? undefined)).toBe(stderr)
        expect(io.exitCode).toBe(code)
      },
    )
    it('preserves multibyte text split across reads', async () => {
      const data = ENC.encode('é needle 😀\n')
      async function* source(): AsyncIterable<Uint8Array> {
        await Promise.resolve()
        for (let at = 0; at < data.length; at += size) yield data.subarray(at, at + size)
      }
      const f = parseFlags(new FlagView({}, specOf('grep')))
      const io = new IOResult({ exitCode: 1 })
      expect(
        await materialize(grepInput(source(), /needle/, f, '/doc.gdoc.json', false, io)),
      ).toEqual(data)
      expect(io.exitCode).toBe(0)
      expect(io.stderr).toBeNull()
    })
  },
)

it.each([{ args_I: true }, { q: true }, {}])('bounds remote reads for %j', async (flags) => {
  const block = new Uint8Array(PROBE_BLOCK_BYTES).fill(120)
  block.set(ENC.encode('needle\0'))
  let closed = false
  async function* source(): AsyncIterable<Uint8Array> {
    await Promise.resolve()
    try {
      yield block
      throw new Error('unnecessary remote read')
    } finally {
      closed = true
    }
  }
  const f = parseFlags(new FlagView(flags, specOf('grep')))
  const io = new IOResult({ exitCode: 1 })
  expect(
    await materialize(grepInput(source(), /needle/, f, '/remote/large.pdf', false, io)),
  ).toEqual(new Uint8Array())
  expect(closed).toBe(true)
})

it('does not read past the probe block for max-count', async () => {
  let closed = false
  async function* source(): AsyncIterable<Uint8Array> {
    await Promise.resolve()
    try {
      yield ENC.encode('needle\n' + 'x'.repeat(PROBE_BLOCK_BYTES - 7))
      throw new Error('read past the requested match')
    } finally {
      closed = true
    }
  }
  const f = parseFlags(new FlagView({ m: 1 }, specOf('grep')))
  const io = new IOResult()
  expect(
    await materialize(grepInput(source(), /needle/, f, '/remote/rows.jsonl', false, io)),
  ).toEqual(ENC.encode('needle\n'))
  expect(io.exitCode).toBe(0)
  expect(closed).toBe(true)
})

it.each([
  [{ B: '-1' }, '-1'],
  [{ A: '-1' }, '-1'],
  [{ C: '-1' }, '-1'],
  [{ A: 'x' }, 'x'],
  [{ B: '1.5' }, '1.5'],
  [{ B: -1 }, '-1'],
  [{ B: '-1', A: 'x' }, '-1'],
  [{ A: 'x', B: '-1' }, 'x'],
])('rejects an invalid context length %j', (flags, shown) => {
  expect(() => parseFlags(new FlagView(flags, specOf('grep')))).toThrow(
    new UsageError(`grep: ${shown}: invalid context length argument`),
  )
})

it.each([{ B: '-0' }, { A: '0' }, { C: 2 }])('accepts context length %j', (flags) => {
  expect(() => parseFlags(new FlagView(flags, specOf('grep')))).not.toThrow()
})

it.each(['', 'bogus'])('rejects invalid binary mode %j', (value) => {
  expect(() => parseFlags(new FlagView({ binary_files: value }, specOf('grep')))).toThrow(
    'unknown binary-files type',
  )
})

describe.each([1024, PROBE_BLOCK_BYTES, 2 * PROBE_BLOCK_BYTES])(
  'late NUL with %i-byte backend chunks',
  (size) => {
    describe.each(['', '\n'])('preceding block ends with %j', (lineEnd) => {
      describe.each([false, true])('count-only %j', (countOnly) => {
        it.each([{ args_I: true }, { binary_files: 'without-match' }])(
          'discards earlier matches with %j',
          async (binaryFlag) => {
            const data = ENC.encode(
              'needle\n' +
                'x'.repeat(PROBE_BLOCK_BYTES - 7 - lineEnd.length) +
                lineEnd +
                '\0tail\n',
            )
            let closed = false
            async function* source(): AsyncIterable<Uint8Array> {
              await Promise.resolve()
              try {
                for (let at = 0; at < data.length; at += size) yield data.subarray(at, at + size)
                throw new Error('read past the binary block')
              } finally {
                closed = true
              }
            }
            const f = parseFlags(new FlagView({ ...binaryFlag, c: countOnly }, specOf('grep')))
            const io = new IOResult()
            const out = await materialize(
              grepInput(source(), /needle/, f, '/remote/late.txt', true, io),
            )
            // Streaming output already emitted before the NUL cannot be retracted.
            expect(DEC.decode(out)).toBe(
              countOnly ? '/remote/late.txt:0\n' : '/remote/late.txt:needle\n',
            )
            expect(io.stderr).toBeNull()
            expect(io.exitCode).toBe(1)
            expect(closed).toBe(true)
          },
        )
      })
    })
  },
)

it.each([
  [{ m: 1, c: true }, '1\n'],
  [{ q: true }, ''],
  [{ args_l: true }, '/remote/rows.jsonl\n'],
] as const)('does not read ahead after without-match early stop %j', async (flags, expected) => {
  let closed = false
  async function* source(): AsyncIterable<Uint8Array> {
    await Promise.resolve()
    try {
      yield ENC.encode('needle\n' + 'x'.repeat(PROBE_BLOCK_BYTES - 7))
      throw new Error('read past the requested match')
    } finally {
      closed = true
    }
  }
  const f = parseFlags(new FlagView({ args_I: true, ...flags }, specOf('grep')))
  const io = new IOResult()
  const out = await materialize(grepInput(source(), /needle/, f, '/remote/rows.jsonl', false, io))
  expect(DEC.decode(out)).toBe(expected)
  expect(io.stderr).toBeNull()
  expect(io.exitCode).toBe(0)
  expect(closed).toBe(true)
})

async function* lines(text: string): AsyncIterable<Uint8Array> {
  await Promise.resolve()
  yield ENC.encode(text)
}

it.each([
  [{ A: 1 }, true, '--\nf:a\nf-b\n'],
  [{ A: 1 }, false, 'f:a\nf-b\n'],
  [{ B: 1 }, true, '--\nf:a\n'],
  [{ c: true, A: 1 }, true, 'f:1\n'],
  [{ o: true, A: 1 }, true, 'f:a\n'],
  [{}, true, 'f:a\n'],
])(
  'opens a context group after earlier output with the separator %j %s',
  async (flags, afterOutput, expected) => {
    const f = parseFlags(new FlagView(flags, specOf('grep')))
    const io = new IOResult()
    const out = await materialize(grepInput(lines('a\nb\n'), /a/, f, 'f', true, io, afterOutput))
    expect(new TextDecoder().decode(out)).toBe(expected)
  },
)

it.each([
  ['binary', 'needle\n', '', 0],
  ['without-match', 'needle\n', '', 1],
  ['text', 'needle\n', '', 0],
] as const)(
  // (printf 'needle\n'; sleep 1; printf '\0tail\n') | grep needle prints the
  // match under GNU 3.11 too; only a later match is suppressed, and -I still
  // reports 1. Merging chunks to avoid this would read ahead.
  'a NUL in a later chunk is GNU pipe behavior in %s mode',
  async (mode, stdout, stderr, code) => {
    let closed = false
    async function* source(): AsyncIterable<Uint8Array> {
      await Promise.resolve()
      try {
        yield ENC.encode('needle\n')
        yield ENC.encode('\0tail\n')
      } finally {
        closed = true
      }
    }
    const f = parseFlags(new FlagView({ binary_files: mode }, specOf('grep')))
    const io = new IOResult({ exitCode: 1 })
    const out = await materialize(grepInput(source(), /needle/, f, '/remote/data.pdf', false, io))
    expect(DEC.decode(out)).toBe(stdout)
    expect(DEC.decode((io.stderr as Uint8Array | null) ?? undefined)).toBe(stderr)
    expect(io.exitCode).toBe(code)
    expect(closed).toBe(true)
  },
)

it.each([
  ['a\0b\n', /^/, 'grep: /data/z: binary file matches\n'],
  ['a\0b\nzz\n', /z*/, 'grep: /data/z: binary file matches\n'],
  ['a\xffb\n', /^/, ''],
] as const)('a zero-width -o match on %j still notices a NUL', async (text, pattern, stderr) => {
  const bytes = Uint8Array.from(text, (ch) => ch.charCodeAt(0))
  async function* source(): AsyncIterable<Uint8Array> {
    await Promise.resolve()
    yield bytes
  }
  const f = parseFlags(new FlagView({ o: true }, specOf('grep')))
  const io = new IOResult({ exitCode: 1 })
  const out = await materialize(grepInput(source(), pattern, f, '/data/z', false, io))
  expect(DEC.decode(out)).toBe('')
  expect(DEC.decode((io.stderr as Uint8Array | null) ?? undefined)).toBe(stderr)
  expect(io.exitCode).toBe(0)
})

// -m0 selects no line and the whole command goes quiet, -c included.
// Measured on GNU grep 3.11: `grep -m0 a f`, `grep -m0 -c a f`,
// `grep -m0 -v a f`, `grep -m0 -l a f`, `grep -m0 -o a f`, `grep -m0 -A1 a f`
// and `grep -m0 -c a f g` are all zero bytes and exit 1, across the `-m0`,
// `-m 0` and `--max-count=0` spellings. -c printing a bare `0` here would be
// wrong twice over: GNU prints nothing, and a GENUINE zero still prints `0`
// (`grep -c a g` is `0\n`, exit 1), so the two cases have to stay
// distinguishable.
it.each([
  [{ m: 0 }],
  [{ m: 0, c: true }],
  [{ m: 0, v: true }],
  [{ m: 0, l: true }],
  [{ m: 0, o: true }],
  [{ m: 0, A: '1' }],
  [{ m: 0, c: true, n: true, b: true }],
])('prints nothing and closes the unread source under -m0 with %j', async (flags) => {
  // A source whose resources are already held before the first read.
  let closed = false
  const source: AsyncIterableIterator<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return this
    },
    next: () => Promise.reject(new Error('read under -m0')),
    return: () => {
      closed = true
      return Promise.resolve({ done: true as const, value: undefined })
    },
  }
  const f = parseFlags(new FlagView(flags, specOf('grep')))
  const io = new IOResult()
  const out = await materialize(grepInput(source, /needle/, f, '/remote/rows.jsonl', false, io))
  expect(DEC.decode(out)).toBe('')
  expect(io.exitCode).toBe(1)
  expect(closed).toBe(true)
})

it('still prints a genuine zero count', async () => {
  // The mirror of the -m0 rows above: without -m0, `grep -c` on a file
  // holding no match prints `0` and exits 1 (GNU grep 3.11).
  const f = parseFlags(new FlagView({ c: true }, specOf('grep')))
  const io = new IOResult({ exitCode: 1 })
  const out = await materialize(grepInput(lines('a\nb\n'), /needle/, f, '/data/z', false, io))
  expect(DEC.decode(out)).toBe('0\n')
  expect(io.exitCode).toBe(1)
})

// The byte layout of every fixture below is section Q1 of the GNU truth
// file, measured against GNU grep 3.11.
const F1 = 'abc\ndefabc\nabc abc\n'
const F3 = 'one\ntwo abc\nthree\nfour abc\nfive\n'
const F4 = 'a\nb\nHIT\nc\nd\ne\nf\nHIT\ng\n'
const F5 = 'café abc\nxéy abc\n'
const F6 = 'no-newline-abc'

async function runB(
  text: string,
  flags: Record<string, unknown>,
  pattern: RegExp,
  show: boolean,
): Promise<[string, number]> {
  const data = ENC.encode(text)
  async function* source(): AsyncIterable<Uint8Array> {
    await Promise.resolve()
    yield data
  }
  const f = parseFlags(new FlagView(flags as never, specOf('grep')))
  const io = new IOResult({ exitCode: 1 })
  const out = await materialize(grepInput(source(), pattern, f, 'f', show, io))
  return [DEC.decode(out), io.exitCode]
}

describe('grep -b / --byte-offset', () => {
  it.each([
    // Without -o the number is the offset of the LINE's first byte: line
    // two prints 4, not the 7 its match sits at.
    [F1, { byte_offset: true }, false, '0:abc\n4:defabc\n11:abc abc\n', 0],
    // With -o it is the offset of the match, and a line with two matches
    // prints both.
    [F1, { byte_offset: true, o: true }, false, '0:abc\n7:abc\n11:abc\n15:abc\n', 0],
    // Field order is FILENAME, LINE NUMBER, BYTE OFFSET, fixed by the
    // renderer rather than by the order the flags were given in.
    [F1, { byte_offset: true, n: true }, false, '1:0:abc\n2:4:defabc\n3:11:abc abc\n', 0],
    [F1, { byte_offset: true, H: true }, true, 'f:0:abc\nf:4:defabc\nf:11:abc abc\n', 0],
    [
      F1,
      { byte_offset: true, n: true, H: true, o: true },
      true,
      'f:1:0:abc\nf:2:7:abc\nf:3:11:abc\nf:3:15:abc\n',
      0,
    ],
    // -b does not reach a count, a file list or -q.
    [F1, { byte_offset: true, c: true }, false, '3\n', 0],
    [F3, { byte_offset: true, c: true }, false, '2\n', 0],
    [F1, { byte_offset: true, c: true, H: true }, true, 'f:3\n', 0],
    [F1, { byte_offset: true, args_l: true }, false, 'f\n', 0],
    [F1, { byte_offset: true, q: true }, false, '', 0],
    // -v prints the line-start offsets of the lines it did not select.
    [F3, { byte_offset: true, v: true }, false, '0:one\n12:three\n27:five\n', 0],
    [F1, { byte_offset: true, v: true }, false, '', 1],
    [F3, { byte_offset: true, m: '1' }, false, '4:two abc\n', 0],
    // A missing final newline does not shift an offset, and must not be
    // counted twice.
    [F6, { byte_offset: true }, false, '0:no-newline-abc\n', 0],
    [F6, { byte_offset: true, o: true }, false, '11:abc\n', 0],
  ] as const)(
    'prints the line start or the match for %j',
    async (text, flags, show, want, code) => {
      expect(await runB(text, flags, /abc/, show)).toEqual([want, code])
    },
  )

  it.each([
    [
      F3,
      /abc/,
      { byte_offset: true, A: '1' },
      false,
      '4:two abc\n12-three\n18:four abc\n27-five\n',
    ],
    [F3, /abc/, { byte_offset: true, B: '1' }, false, '0-one\n4:two abc\n12-three\n18:four abc\n'],
    [
      F3,
      /abc/,
      { byte_offset: true, C: '1' },
      false,
      '0-one\n4:two abc\n12-three\n18:four abc\n27-five\n',
    ],
    [F3, /three/, { byte_offset: true, A: '1' }, false, '12:three\n18-four abc\n'],
    // Every field on a context line takes `-`, the separator being chosen
    // once per line rather than per field.
    [
      F3,
      /abc/,
      { byte_offset: true, n: true, C: '1' },
      false,
      '1-0-one\n2:4:two abc\n3-12-three\n4:18:four abc\n5-27-five\n',
    ],
    [
      F3,
      /abc/,
      { byte_offset: true, n: true, H: true, C: '1' },
      true,
      'f-1-0-one\nf:2:4:two abc\nf-3-12-three\nf:4:18:four abc\nf-5-27-five\n',
    ],
    // The group separator is a bare `--` with no prefix fields at all.
    [
      F4,
      /HIT/,
      { byte_offset: true, n: true, C: '1' },
      false,
      '2-2-b\n3:4:HIT\n4-8-c\n--\n7-14-f\n8:16:HIT\n9-20-g\n',
    ],
    // -o beats -C entirely: only matches, no context and no separator.
    [F3, /abc/, { byte_offset: true, o: true, C: '1' }, false, '8:abc\n23:abc\n'],
  ] as const)(
    'gives a context line the dash separator for %j',
    async (text, pattern, flags, show, want) => {
      expect(await runB(text, flags, pattern, show)).toEqual([want, 0])
    },
  )

  it.each([
    // An empty match prints nothing under -ob, exactly as under -o, and
    // the line is still selected.
    ['ab\n', /[0-9]*/, { byte_offset: true, o: true }, ''],
    ['ab\n', new RegExp(''), { byte_offset: true, o: true }, ''],
    ['a1b\n', /[0-9]*/, { byte_offset: true, o: true }, '1:1\n'],
    ['a1b\nc2d\n', /[0-9]*/, { byte_offset: true, o: true }, '1:1\n5:2\n'],
    ['ab\ncd\n', /[0-9]*/, { byte_offset: true }, '0:ab\n3:cd\n'],
  ] as const)(
    'treats an empty match under -ob as under -o for %j',
    async (text, pattern, flags, want) => {
      expect(await runB(text, flags, pattern, false)).toEqual([want, 0])
    },
  )

  it.each([
    // `caf` + U+00E9 (two bytes) + a space is six bytes, so the match sits
    // at byte 6 and not at the code-unit index 5; line two starts at 10 and
    // its match is at 15, not 13. GNU reports the same numbers under C and
    // C.utf8.
    [{ byte_offset: true, o: true }, '6:abc\n15:abc\n'],
    [{ byte_offset: true, o: true, n: true }, '1:6:abc\n2:15:abc\n'],
    [{ byte_offset: true }, '0:café abc\n10:xéy abc\n'],
  ] as const)('counts bytes rather than characters for %j', async (flags, want) => {
    expect(await runB(F5, flags, /abc/, false)).toEqual([want, 0])
  })
})

it.each([
  [['-b', 'abc', 'f'], true],
  [['--byte-offset', 'abc', 'f'], true],
  [['-bn', 'abc', 'f'], true],
  [['abc', 'f'], false],
])('reaches the generic as byteOffsets for %j', (argv, want) => {
  // The dest of -b/--byte-offset is `byte_offset`, so a query for the short
  // spelling would read as absent without the parser ever complaining.
  const bag = parseToKwargs(parseCommand(specOf('grep'), argv, '/'))
  expect(parseFlags(new FlagView(bag, specOf('grep'))).byteOffsets).toBe(want)
})
