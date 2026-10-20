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

import { Workspace } from '../workspace/workspace/workspace.ts'
import { getTestParser } from '../../tests/workspace/fixtures/workspace_fixture.ts'
import { describe, expect, it, vi } from 'vitest'
import { encodeBase64 } from '../utils/base64.ts'
import { StreamRefusal } from './errors.ts'
import { Glob } from './glob.ts'
import { PosixRegex } from './regex.ts'
import { openStream } from './stream.ts'

const DECODE = { mode: 'decode', ignore_garbage: false }

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
    const instance = (stream: unknown): unknown => (stream as { exports: unknown }).exports
    const small = new PosixRegex('b')
    const large = new PosixRegex('x$')
    const size = 34 * 1024 * 1024
    expect(large.search('a'.repeat(size) + 'x')).toEqual([[size, size + 1]])
    const before = await openStream('base64', DECODE)
    const grown = instance(before)
    // Only the matchers are left on the grown instance, so it retires.
    before.close()
    const after = await openStream('base64', DECODE)
    expect(instance(after)).not.toBe(grown)
    after.close()
    expect(small.search('abc')).toEqual([[1, 2]])
    expect(large.search('ax')).toEqual([[1, 2]])
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

it.each([false, true])(
  'glob replacement cancellation prevents later output with reused subject %s',
  async (reuseSubject) => {
    const controller = new AbortController()
    const reason = new Error('replacement canceled')
    const glob = new Glob('+(?)', true, false, 'shell', controller.signal)
    const output: [number, number][][] = []
    const subject = 'a'.repeat(2_000_000)
    if (reuseSubject) expect(glob.end(subject, subject.length)).toBeNull()
    const timer = setTimeout(() => {
      controller.abort(reason)
    }, 0)
    try {
      const work = glob.spans(subject, true, null).then((spans) => {
        output.push(spans)
      })
      await expect(work).rejects.toBe(reason)
      expect(output).toEqual([])
    } finally {
      clearTimeout(timer)
      glob.close()
    }
  },
)

it('foreground parameter cancellation closes the matcher before returning', async () => {
  const ws = new Workspace({}, { shellParser: await getTestParser() })
  const controller = new AbortController()
  const spansSpy = vi.spyOn(Glob.prototype, 'spans')
  const closeSpy = vi.spyOn(Glob.prototype, 'close')
  let work: ReturnType<typeof ws.shell> | undefined
  try {
    await ws.shell('shopt -s extglob')
    work = ws.shell('x=${X//+(?)/x}; touched=yes', {
      signal: controller.signal,
      env: { X: 'a'.repeat(2_000_000) },
    })
    const aborted = expect(work).rejects.toMatchObject({ name: 'AbortError' })
    await expect.poll(() => spansSpy.mock.calls.length).toBe(1)
    const result = spansSpy.mock.results[0]
    if (result?.type !== 'return') throw new Error('the matcher did not return a promise')
    let settled = false
    void result.value.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    controller.abort()
    await aborted
    expect(settled).toBe(true)
    expect(closeSpy.mock.instances).toContain(spansSpy.mock.instances[0])
    const peer = await ws.shell('printf "%s\n" "${touched-unset}"')
    expect(new TextDecoder().decode(peer.stdout)).toBe('unset\n')
  } finally {
    controller.abort()
    await work?.catch(() => undefined)
    spansSpy.mockRestore()
    closeSpy.mockRestore()
    await ws.close()
  }
})
