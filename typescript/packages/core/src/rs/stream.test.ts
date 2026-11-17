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
import { encodeBase64 } from '../utils/base64.ts'
import { StreamRefusal } from './errors.ts'
import { GlobMatcher } from './glob.ts'
import { PosixRegex } from './regex.ts'
import {
  compiledModule,
  mergeOutput,
  openStream,
  serveRequests,
  StreamModule as Streams,
} from './stream.ts'
import type * as StreamModule from './stream.ts'

const DECODE = { mode: 'decode', ignore_garbage: false }

// The instance a stream runs on.
function instance(stream: unknown): unknown {
  return (stream as { exports: unknown }).exports
}

function memory(stream: unknown): WebAssembly.Memory {
  return (instance(stream) as { memory: WebAssembly.Memory }).memory
}

describe('stream lifetime', () => {
  it('detaches a retained closed wrapper and keeps a concurrent stream usable', async () => {
    const module = new Streams(compiledModule())
    const closed = await module.open('base64', DECODE)
    const live = await module.open('base64', DECODE)
    const grown = instance(closed)
    memory(closed).grow(513)
    closed.close()
    closed.close()
    expect(closed.live).toBe(false)
    expect(() => closed.finish()).toThrow('stream is closed')
    const same = await module.open('base64', DECODE)
    expect(instance(same)).toBe(grown)
    same.close()
    expect(new TextDecoder().decode(live.feed(new TextEncoder().encode('aGk=')))).toBe('hi')
    expect(live.finish().length).toBe(0)
    live.close()
    const fresh = await module.open('base64', DECODE)
    expect(instance(fresh)).not.toBe(grown)
    fresh.close()
  })

  it('respects each module recycling threshold after asynchronous readiness', async () => {
    for (const recycle of [1, 128 * 1024 * 1024]) {
      const module = new Streams(compiledModule(), recycle)
      const stream = module.openSync('base64', DECODE, false)
      const original = instance(stream)
      memory(stream).grow(513)
      stream.close()
      await module.ready()
      const next = module.openSync('base64', DECODE, false)
      expect(instance(next) === original).toBe(recycle > 64 * 1024 * 1024)
      next.close()
    }
  })

  it('rechecks live handles before completing deferred retirement', async () => {
    const module = new Streams(compiledModule())
    const stream = module.openSync('base64', DECODE, false)
    const grown = instance(stream)
    memory(stream).grow(513)
    stream.close()
    const pin = module.openSync('base64', DECODE, false)
    await module.ready()
    expect(instance(pin)).toBe(grown)
    expect(new TextDecoder().decode(pin.feed(new TextEncoder().encode('aGk=')))).toBe('hi')
    pin.close()
    const fresh = await module.open('base64', DECODE)
    expect(instance(fresh)).not.toBe(grown)
    fresh.close()
  })

  it('detaches a trapped wrapper and replaces the poisoned instance', async () => {
    const module = new Streams(compiledModule())
    const stream = await module.open('base64', DECODE)
    const sibling = await module.open('base64', DECODE)
    const poisoned = instance(stream) as {
      mirage_rs_args(len: number): number
    }
    expect(() => poisoned.mirage_rs_args(0xffffffff)).toThrow(WebAssembly.RuntimeError)
    expect(() => {
      sibling.close()
    }).toThrow(WebAssembly.RuntimeError)
    expect(sibling.live).toBe(false)
    const fresh = await module.open('base64', DECODE)
    expect(() => stream.feed(new Uint8Array())).toThrow(WebAssembly.RuntimeError)
    expect(stream.live).toBe(false)
    stream.close()
    expect(instance(fresh)).not.toBe(poisoned)
    expect(new TextDecoder().decode(fresh.feed(new TextEncoder().encode('aGk=')))).toBe('hi')
    fresh.close()
  })
})

describe('openStream', () => {
  it('refuses a bad config with no output', async () => {
    const refused: unknown = await openStream('base64', { mode: 'nope' }).catch(
      (err: unknown) => err,
    )
    expect(refused).toBeInstanceOf(StreamRefusal)
    expect((refused as StreamRefusal).message).toMatch(/^bad stream config/)
    expect((refused as StreamRefusal).output.byteLength).toBe(0)
  })

  it('keeps the earlier pieces when a chunk past the input window refuses', async () => {
    const data = Uint8Array.from({ length: 256 * 1024 }, (_, i) => i % 256)
    const input = new TextEncoder().encode(`${encodeBase64(data)}*`)
    const stream = await openStream('base64', DECODE)
    let refused: unknown
    try {
      stream.feed(input)
    } catch (err) {
      refused = err
    } finally {
      stream.close()
      stream.close()
    }
    expect(refused).toBeInstanceOf(StreamRefusal)
    expect((refused as StreamRefusal).output).toEqual(data)
  })

  it('moves matchers off an instance a large search grew', async () => {
    const small = new PosixRegex('b')
    const glob = new GlobMatcher('a*b')
    const large = new PosixRegex('x$')
    const size = 34 * 1024 * 1024
    expect(await large.search('a'.repeat(size) + 'x')).toEqual([[size, size + 1]])
    const before = await openStream('base64', DECODE)
    const grown = instance(before)
    // Only the matchers are left on the grown instance, so it retires.
    before.close()
    const after = await openStream('base64', DECODE)
    expect(instance(after)).not.toBe(grown)
    after.close()
    expect(await small.search('abc')).toEqual([[1, 2]])
    expect(glob.matches('axb')).toBe(true)
    expect(await large.search('ax')).toEqual([[1, 2]])
  })

  it('keeps an instance a paused search is on', async () => {
    const size = 34 * 1024 * 1024
    // `a*` keeps the automaton from skipping to the `x`, so the search pauses.
    const regex = new PosixRegex('a*x$')
    const abort = new AbortController()
    const search = regex.search('a'.repeat(size) + 'x', 0, abort.signal)
    const before = await openStream('base64', DECODE)
    const grown = instance(before)
    before.close()
    const after = await openStream('base64', DECODE)
    expect(instance(after)).toBe(grown)
    after.close()
    abort.abort()
    await expect(search).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('reads one input after another', async () => {
    const stream = await openStream('grep', { patterns: ['*a'], syntax: 'extended', count: true })
    const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)
    try {
      expect(text(stream.takeStderr())).toBe('grep: warning: * at start of expression\n')
      for (const [data, count, status] of [
        ['a\nb\n', '1\n', 0],
        ['b\n', '0\n', 1],
      ] as const) {
        stream.begin({ label: 'in' })
        expect(stream.feed(new TextEncoder().encode(data)).byteLength).toBe(0)
        expect(stream.done()).toBe(false)
        expect(text(stream.finish())).toBe(count)
        expect(stream.status()).toBe(status)
      }
    } finally {
      stream.close()
    }
  })

  it('refuses a test from a stream that answers none', async () => {
    const stream = await openStream('base64', DECODE)
    try {
      expect(() => stream.test(new Uint8Array())).toThrow('answers no test')
    } finally {
      stream.close()
    }
  })

  it('refuses another input for a stream of one', async () => {
    const stream = await openStream('base64', DECODE)
    try {
      expect(() => {
        stream.begin({})
      }).toThrow(StreamRefusal)
    } finally {
      stream.close()
    }
  })
})

describe('adoptModule', () => {
  const bundle = async (): Promise<typeof StreamModule> => {
    vi.resetModules()
    vi.doMock('#mirage-rs-wasm', () => ({
      default: () => {
        throw new Error('a worker runs on the module its page hands it')
      },
      AHEAD: false,
    }))
    try {
      return await import('./stream.ts')
    } finally {
      vi.doUnmock('#mirage-rs-wasm')
      vi.resetModules()
    }
  }
  const decoded = (stream: { feed(c: Uint8Array): Uint8Array; finish(): Uint8Array }): string =>
    new TextDecoder().decode(
      new Uint8Array([...stream.feed(new TextEncoder().encode('aGk=')), ...stream.finish()]),
    )

  it('runs a bundle without the bytes on the module the page compiled', async () => {
    const page = compiledModule()
    const worker = await bundle()
    worker.adoptModule(page)
    expect(worker.compiledModule()).toBe(page)
    const sync = worker.openStreamSync('base64', DECODE)
    const async = await worker.openStream('base64', DECODE)
    try {
      expect(decoded(sync)).toBe('hi')
      expect(decoded(async)).toBe('hi')
    } finally {
      sync.close()
      async.close()
    }
  })

  it('a bundle without the bytes has no module of its own', async () => {
    const worker = await bundle()
    await expect(worker.openStream('base64', DECODE)).rejects.toThrow(
      'a worker runs on the module its page hands it',
    )
  })
})

describe('serveRequests', () => {
  it('moves stderr out of the stream after each drain', async () => {
    const program = 'BEGIN { for (i = 0; i < 100000; i++) print "line" > "/dev/stderr" }'
    const stream = await openStream('awk', { program })
    const sizes: number[] = []
    const host = {
      errors: {
        append: (data: Uint8Array): Promise<void> => {
          sizes.push(data.byteLength)
          return Promise.resolve()
        },
      },
      serve: (): never => {
        throw new Error('unexpected request')
      },
    }
    for await (const _ of serveRequests(stream, host)) void _
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(500000)
    expect(Math.max(...sizes)).toBeLessThan(70000)
    stream.close()
  })
})

describe('mergeOutput', () => {
  it('stops its work loop once the signal aborts', async () => {
    const stream = await openStream('tsort', { operands: [] })
    const controller = new AbortController()
    controller.abort()
    const run = async (): Promise<void> => {
      for await (const _ of mergeOutput(stream, () => Promise.resolve(null), controller.signal))
        void _
    }
    await expect(run()).rejects.toThrow()
    stream.close()
  })
})
