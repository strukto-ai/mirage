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

import { describe, expect, it, vi } from 'vitest'
import { IOResult, materialize } from '../../../../io/types.ts'
import { EvaluationContext } from '../../../evaluation.ts'
import { SessionState } from '../../../session/session.ts'
import { handleXargs } from './xargs.ts'
import { shellJoin } from '../../../../shell/join.ts'
import type * as BytesModule from '../../../../utils/bytes.ts'

// The largest buffer `concat` builds, the one -I's filled-in text and each
// -0 item go through, and how many it has built.
const built = vi.hoisted(() => ({ largest: 0, calls: 0 }))

vi.mock('../../../../utils/bytes.ts', async (importOriginal) => {
  const real = await importOriginal<typeof BytesModule>()
  return {
    ...real,
    concat: (pieces: readonly Uint8Array[]): Uint8Array => {
      const out = real.concat(pieces)
      built.largest = Math.max(built.largest, out.length)
      built.calls += 1
      return out
    },
  }
})

const LINE_TOO_LONG = 'xargs: argument line too long\n'

function many(byte: number, count: number): Uint8Array {
  return new Uint8Array(count).fill(byte)
}

function joinBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values)
}

function shell(): { lines: string[]; fn: (line: string) => Promise<IOResult> } {
  const lines: string[] = []
  return {
    lines,
    fn: (line: string) => {
      lines.push(line)
      return Promise.resolve(new IOResult())
    },
  }
}

async function run(
  args: string[],
  input: Uint8Array | AsyncIterable<Uint8Array>,
): Promise<{ lines: string[]; stderr: string; exitCode: number }> {
  const fake = shell()
  const [out, io] = await handleXargs(
    fake.fn,
    args,
    new EvaluationContext(new SessionState({ sessionId: 'bounds' })),
    input,
  )
  await materialize(out)
  return {
    lines: fake.lines,
    stderr: new TextDecoder().decode(await materialize(io.stderr)),
    exitCode: io.exitCode,
  }
}

describe('xargs size bounds', () => {
  it.each<[string, string[], string]>([
    ['word', ['echo'], ''],
    ['quoted', ['echo'], "'"],
    ['null', ['-0', 'echo'], ''],
    ['delimiter', ['-d,', 'echo'], ''],
    ['replace', ['-I{}', 'echo', '{}'], ''],
    ['lines', ['-L1', 'echo'], ''],
  ])('an endless %s stops at the size limit', async (_, args, lead) => {
    // GNU 4.10 reports at the first byte past the limit and reads no
    // further: 131072 bytes, eight 16 KiB chunks, not the 16 MiB on offer.
    let pulls = 0
    async function* endless(): AsyncGenerator<Uint8Array> {
      yield await Promise.resolve(new TextEncoder().encode(lead))
      for (let index = 0; index < 1024; index += 1) {
        pulls += 1
        yield new Uint8Array(16384).fill(0x61)
      }
    }
    const result = await run(args, endless())
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe(LINE_TOO_LONG)
    expect(result.lines).toEqual([])
    expect(pulls).toBeLessThanOrEqual(9)
  })

  it.each<[string, string[], Uint8Array]>([
    // The word is too long before the quote opens, or the NUL or the -E
    // word arrives.
    ['quote after', ['echo'], joinBytes(many(0x61, 200000), text("'b"))],
    ['newline in quote', ['echo'], joinBytes(text("'"), many(0x61, 200000), text('\nb\n'))],
    ['NUL after', ['echo'], joinBytes(many(0x61, 200000), text('\0b\n'))],
    ['end word', ['-s', '100', '-E', 'x'.repeat(150), 'echo'], text(`${'x'.repeat(150)} b\n`)],
  ])('a word past the limit ends the input there (%s)', async (_, args, data) => {
    const result = await run(args, data)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe(LINE_TOO_LONG)
    expect(result.lines).toEqual([])
  })

  it('counts the filled-in size before building it', async () => {
    // 500 copies of a 100 KB line would be 50 MB before `command too long`.
    built.largest = 0
    const result = await run(
      ['-I{}', 'echo', '{}'.repeat(500)],
      joinBytes(many(0x61, 100000), text('\n')),
    )
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe('xargs: command too long\n')
    expect(built.largest).toBeLessThanOrEqual(131072)
  })

  it.each<[string, string[], string, 'concat' | 'words']>([
    ['replace', ['-I{}', 'echo', 'x{}'], 'a\n'.repeat(1000), 'concat'],
    ['null', ['-0', '-n1', 'echo'], 'a\0'.repeat(1000), 'concat'],
    ['args', ['-n1', 'echo'], 'a '.repeat(1000), 'words'],
    ['lines', ['-L1', 'echo'], 'a\n'.repeat(1000), 'words'],
  ])('runs each command before the next is built (%s)', async (_, args, input, counter) => {
    // The reader pauses once a command is built, so one built command is
    // held at a time however many one chunk of input makes.
    built.calls = 0
    const words = vi.spyOn(Uint8Array, 'from')
    const seen: number[] = []
    try {
      const [out, io] = await handleXargs(
        (): Promise<IOResult> => {
          seen.push(counter === 'concat' ? built.calls : words.mock.calls.length)
          return Promise.resolve(new IOResult())
        },
        args,
        new EvaluationContext(new SessionState({ sessionId: 'pause' })),
        new TextEncoder().encode(input),
      )
      await materialize(out)
      expect(io.exitCode).toBe(0)
    } finally {
      words.mockRestore()
    }
    expect(seen).toHaveLength(1000)
    expect(seen[0]).toBeLessThanOrEqual(2)
    expect(seen[999]).toBeGreaterThanOrEqual(1000)
  })

  const noRoom = 'xargs: cannot fit single argument within argument list size limit\n'

  it.each<[string, string[], Uint8Array, string[][]]>([
    // GNU 4.10 skips \v, \f and \r before a word and keeps them in one.
    ['leading CR', ['echo'], text('\rfile\n'), [['echo', 'file']]],
    ['between words', ['echo'], text('\v\fa \r b\rc\n'), [['echo', 'a', 'b\rc']]],
    ['in quotes', ['echo'], text("'\ra' b\n"), [['echo', '\ra', 'b']]],
    ['escaped', ['echo'], text('a\\\rb\n'), [['echo', 'a\rb']]],
    // Skipping one leaves the line's last blank in place for -L.
    ['-L', ['-L1', 'echo'], text('a \v\nb\n'), [['echo', 'a', 'b']]],
    ['-I', ['-I{}', 'echo', '<{}>'], text('\r\vfile\n'), [['echo', '<file>']]],
    ['-E', ['-E', 'STOP', 'echo'], text('a \vSTOP b\n'), [['echo', 'a']]],
    // 0x85 and 0xa0 are bytes like any other.
    [
      '0x85 and 0xa0',
      ['echo'],
      bytes(0xa0, 0x61, 0x20, 0x85, 0x0a),
      [['echo', '\udca0a', '\udc85']],
    ],
  ])('skips VT, FF and CR only before a word (%s)', async (_, args, data, words) => {
    const result = await run(args, data)
    expect(result.lines).toEqual(words.map((line) => shellJoin(line)))
    expect(result.exitCode).toBe(0)
  })

  it.each<[string[], string, string[], string, number]>([
    // With no room after the command, a word with bytes is too long and an
    // empty one cannot fit at all.
    [['-0', '-s', '5', 'echo'], 'abc', [], LINE_TOO_LONG, 1],
    [['-d,', '-s', '5', 'echo'], 'abc', [], LINE_TOO_LONG, 1],
    [['-s', '5', 'echo'], 'abc', [], LINE_TOO_LONG, 1],
    [['-0', '-s', '5', 'echo'], '\0', [], noRoom, 1],
    [['-d,', '-s', '5', 'echo'], ',', [], noRoom, 1],
    [['-s', '5', 'echo'], "''\n", [], noRoom, 1],
    [['-0', '-s', '5', 'echo'], '', ['echo'], '', 0],
    // -I measures a line as its bytes arrive, so a later empty line passes
    // where one byte would not.
    [['-I{}', '-s', '5', 'echo'], "a\n''\n", ['echo', 'echo'], '', 0],
    [['-I{}', '-s', '5', 'echo'], 'a\nb\n', ['echo'], LINE_TOO_LONG, 1],
  ])('no room after the command (%j %j)', async (args, data, lines, stderr, code) => {
    const result = await run(args, text(data))
    expect(result.lines).toEqual(lines)
    expect(result.stderr).toBe(stderr)
    expect(result.exitCode).toBe(code)
  })
})
