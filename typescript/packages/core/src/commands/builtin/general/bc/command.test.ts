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

import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { NOOPAccessor } from '../../../../accessor/base.ts'
import { closeQuietly, ensureStream } from '../../../../io/stream.ts'
import { materialize, type ByteSource } from '../../../../io/types.ts'
import { PathSpec } from '../../../../types.ts'
import type { Context } from '../../../config.ts'
import { bc } from './command.ts'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

async function invoke(source: ByteSource, signal?: AbortSignal) {
  const ctx: Context = {
    stdin: source,
    flags: {},
    cwd: PathSpec.fromStrPath('/'),
    ...(signal === undefined ? {} : { signal }),
  }
  const result = await bc(new NOOPAccessor(), [], [], ctx)
  if (result === null) throw new Error('bc did not return a result')
  const [output, io] = result
  if (output === null) throw new Error('bc did not return stdout')
  return { output: ensureStream(output), io }
}

function cursor(output: AsyncIterable<Uint8Array>) {
  return output[Symbol.asyncIterator]()
}

describe('bc stream lifecycle', () => {
  for (const size of [1, 7, 16384]) {
    it(`preserves UTF-8 and state with ${String(size)}-byte chunks`, async () => {
      const program = encoder.encode('x=5/* comment */;print "中",x,"\\n"\nx+=2\nx\n')
      async function* source() {
        await Promise.resolve()
        for (let offset = 0; offset < program.length; offset += size)
          yield program.subarray(offset, offset + size)
      }
      const { output, io } = await invoke(source())
      expect(decoder.decode(await materialize(output))).toBe('中5\n7\n')
      expect(await io.stderrStr()).toBe('')
      expect(io.exitCode).toBe(0)
    })
  }

  for (const stop of ['quit', 'halt']) {
    it(`drains output and closes input after ${stop} without another pull`, async () => {
      let closed = false
      async function* source() {
        await Promise.resolve()
        try {
          yield encoder.encode('1\n'.repeat(2000) + stop + '\n')
          throw new Error('bc read after stopping')
        } finally {
          closed = true
        }
      }
      const { output, io } = await invoke(source())
      expect(decoder.decode(await materialize(output))).toBe('1\n'.repeat(2000))
      expect(closed).toBe(true)
      expect(await io.stderrStr()).toBe('')
      expect(io.exitCode).toBe(0)
    })
  }

  it('records diagnostics before the consumer stops', async () => {
    let closed = false
    async function* source() {
      await Promise.resolve()
      try {
        yield encoder.encode('1/0\n2+2\n')
        throw new Error('consumer stopped before the next pull')
      } finally {
        closed = true
      }
    }
    const { output, io } = await invoke(source())
    const iterator = cursor(output)
    let produced = ''
    while (produced.length < 2) {
      const part = await iterator.next()
      if (part.done === true) throw new Error('bc stopped before producing its result')
      produced += decoder.decode(part.value)
    }
    expect(produced).toBe('4\n')
    expect(await io.stderrStr()).toBe('Runtime error (func=(main), adr=3): Divide by zero\n')
    expect(io.exitCode).toBe(0)
    await iterator.return?.()
    expect(closed).toBe(true)
  })

  it('executes the final line without a newline at EOF', async () => {
    async function* source() {
      await Promise.resolve()
      yield encoder.encode('scale=3;')
      yield encoder.encode('1/2')
    }
    const { output, io } = await invoke(source())
    expect(decoder.decode(await materialize(output))).toBe('.500\n')
    expect(await io.stderrStr()).toBe('')
  })

  it('preserves prior diagnostics and closes input when a read fails', async () => {
    let closed = false
    async function* source() {
      await Promise.resolve()
      try {
        yield encoder.encode('1/0\n')
        throw new Error('input failed')
      } finally {
        closed = true
      }
    }
    const { output, io } = await invoke(source())
    await expect(materialize(output)).rejects.toThrow('input failed')
    expect(closed).toBe(true)
    expect(await io.stderrStr()).toBe('Runtime error (func=(main), adr=3): Divide by zero\n')
  })

  it('honors cancellation between Rust calls and closes the source', async () => {
    let closed = false
    async function* source() {
      await Promise.resolve()
      try {
        yield encoder.encode('1\n'.repeat(10000))
        throw new Error('bc read after cancellation')
      } finally {
        closed = true
      }
    }
    const controller = new AbortController()
    const { output } = await invoke(source(), controller.signal)
    const iterator = cursor(output)
    expect((await iterator.next()).done).toBe(false)
    controller.abort(new Error('cancelled'))
    await expect(iterator.next()).rejects.toThrow('cancelled')
    expect(closed).toBe(true)
    const next = await invoke(encoder.encode('2+2\n'))
    expect(decoder.decode(await materialize(next.output))).toBe('4\n')
  })

  it('keeps concurrent invocation registers and variables isolated', async () => {
    async function evaluate(program: string) {
      const { output, io } = await invoke(encoder.encode(program))
      return [decoder.decode(await materialize(output)), await io.stderrStr()]
    }
    expect(
      await Promise.all([evaluate('scale=3;x=9;obase=16\nx;scale\n'), evaluate('x;scale;obase\n')]),
    ).toEqual([
      ['9\n3\n', ''],
      ['0\n0\n10\n', ''],
    ])
  })

  it('closes an output that was never consumed', async () => {
    let closed = false
    const source: AsyncIterableIterator<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return this
      },
      next() {
        return Promise.reject(new Error('input must remain unread'))
      },
      return() {
        closed = true
        return Promise.resolve({ done: true, value: undefined })
      },
    }
    const { output } = await invoke(source)
    await closeQuietly(output)
    expect(closed).toBe(true)
  })
})

describe('bc arithmetic at the command boundary', () => {
  const powers: [string, string][] = [
    ['1.0^1000000000000', '1.000\n'],
    ['(-1.00)^1000000000001', '-1.000\n'],
    ['0.00^1000000000000', '0\n'],
    ['0^0', '1\n'],
    ['1.0^-1000000000000', '1.000\n'],
    ['(-1.00)^-1000000000001', '-1.000\n'],
    ['.1^1000000000000', '0\n'],
    ['.10^-2', '100.000\n'],
    ['1.2^3', '1.728\n'],
    ['1.2^-3', '.578\n'],
    ['(-1.20)^-3', '-.578\n'],
  ]
  for (const [expression, expected] of powers) {
    it(`preserves the original scale of ${expression}`, async () => {
      const { output, io } = await invoke(encoder.encode(`scale=3;${expression}\n`))
      expect(decoder.decode(await materialize(output))).toBe(expected)
      expect(await io.stderrStr()).toBe('')
    })
  }

  for (const expression of [
    '2^1000000',
    '2^-1000000',
    '2^' + String(10n ** 100n),
    '2^-' + String(10n ** 100n),
    '.1^-10000000000000000000000000000000000',
    '2^32768*2^32768',
    '1'.repeat(16001),
    '.' + '0'.repeat(16000) + '1',
  ]) {
    it(`refuses and recovers after ${expression.slice(0, 40)}`, () => {
      const script = `
import { bc } from ${JSON.stringify(new URL('./command.ts', import.meta.url).href)}
import { NOOPAccessor } from ${JSON.stringify(new URL('../../../../accessor/base.ts', import.meta.url).href)}
import { PathSpec } from ${JSON.stringify(new URL('../../../../types.ts', import.meta.url).href)}
import { materialize } from ${JSON.stringify(new URL('../../../../io/types.ts', import.meta.url).href)}
const [output, io] = await bc(new NOOPAccessor(), [], [], {
  stdin: new TextEncoder().encode(process.argv[1] + ';99\\n2+2\\n'),
  flags: {}, cwd: PathSpec.fromStrPath('/'),
})
const result = await materialize(output)
process.stdout.write(JSON.stringify([
  new TextDecoder().decode(result), await io.stderrStr(), io.exitCode,
]))
`
      const result = execFileSync(
        process.execPath,
        [
          '--experimental-transform-types',
          '--disable-warning=ExperimentalWarning',
          '--input-type=module',
          '-e',
          script,
          '--',
          expression,
        ],
        { encoding: 'utf8', timeout: 5000 },
      )
      expect(JSON.parse(result)).toEqual([
        '4\n',
        'Runtime error (func=(main), adr=3): Arithmetic limit exceeded\n',
        0,
      ])
    })
  }

  it('refuses growing remainder scales and recovers on the next line', async () => {
    const program = 'a=.1;scale=100;' + 'a=a%(3*a);'.repeat(200) + 'obase=2;a\n2+2\n'
    const { output, io } = await invoke(encoder.encode(program))
    expect(decoder.decode(await materialize(output))).toBe('4\n')
    expect(await io.stderrStr()).toBe(
      'Runtime error (func=(main), adr=3): Arithmetic limit exceeded\n',
    )
  })
})
