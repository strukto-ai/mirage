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
import { CachableAsyncIterator } from './cachable_iterator.ts'
import { type ByteSource, IOResult, materialize } from './types.ts'

async function* toAsync(chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  await Promise.resolve()
  for (const c of chunks) yield c
}

describe('materialize', () => {
  it('returns empty Uint8Array for null/undefined', async () => {
    expect(await materialize(null)).toEqual(new Uint8Array())
    expect(await materialize(undefined)).toEqual(new Uint8Array())
  })

  it('returns the Uint8Array as-is', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    expect(await materialize(bytes)).toBe(bytes)
  })

  it('concatenates chunks from an async iterable', async () => {
    const source: ByteSource = toAsync([new Uint8Array([1, 2]), new Uint8Array([3])])
    expect(await materialize(source)).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('actively drains a CachableAsyncIterator (Python parity)', async () => {
    const ci = new CachableAsyncIterator(
      toAsync([new TextEncoder().encode('he'), new TextEncoder().encode('llo')]),
    )
    expect(new TextDecoder().decode(await materialize(ci))).toBe('hello')
    expect(ci.exhausted).toBe(true)
  })

  it('returns buffered bytes for an already-drained CachableAsyncIterator', async () => {
    const ci = new CachableAsyncIterator(
      toAsync([new TextEncoder().encode('he'), new TextEncoder().encode('llo')]),
    )
    await ci.drain()
    expect(new TextDecoder().decode(await materialize(ci))).toBe('hello')
  })
})

describe('IOResult', () => {
  it('defaults all fields', () => {
    const io = new IOResult()
    expect(io.stdout).toBeNull()
    expect(io.stderr).toBeNull()
    expect(io.exitCode).toBe(0)
    expect(io.reads).toEqual({})
    expect(io.writes).toEqual({})
    expect(io.cache).toEqual([])
    expect(io.streamSource).toBeNull()
  })

  it('materializeStdout caches and returns bytes', async () => {
    const io = new IOResult({ stdout: new TextEncoder().encode('hi') })
    const bytes = await io.materializeStdout()
    expect(new TextDecoder().decode(bytes)).toBe('hi')
    expect(io.stdout).toEqual(bytes)
  })

  it('stdoutStr returns decoded string', async () => {
    const io = new IOResult({ stdout: new TextEncoder().encode('hello') })
    expect(await io.stdoutStr()).toBe('hello')
  })

  it('stderrStr returns decoded string', async () => {
    const io = new IOResult({ stderr: new TextEncoder().encode('err') })
    expect(await io.stderrStr()).toBe('err')
  })

  it('stdoutStr replaces invalid utf-8 by default', async () => {
    const io = new IOResult({ stdout: new Uint8Array([0xff, 0xfe, 0xfd]) })
    const s = await io.stdoutStr()
    expect(s.length).toBeGreaterThan(0)
  })

  it('stdoutStr throws on invalid utf-8 with errors="strict"', async () => {
    const io = new IOResult({ stdout: new Uint8Array([0xff, 0xfe, 0xfd]) })
    await expect(io.stdoutStr('strict')).rejects.toThrow()
  })

  it('materializeStdout actively drains a CachableAsyncIterator', async () => {
    const ci = new CachableAsyncIterator(
      toAsync([new TextEncoder().encode('ab'), new TextEncoder().encode('cd')]),
    )
    const io = new IOResult({ stdout: ci })
    const bytes = await io.materializeStdout()
    expect(new TextDecoder().decode(bytes)).toBe('abcd')
    expect(io.stdout).toEqual(bytes)
  })
})

describe('IOResult.merge', () => {
  it('combines reads/writes/cache', async () => {
    const a = new IOResult({
      reads: { '/a': new Uint8Array([1]) },
      writes: { '/x': new Uint8Array([2]) },
      cache: ['/a'],
    })
    const b = new IOResult({
      reads: { '/b': new Uint8Array([3]) },
      writes: { '/y': new Uint8Array([4]) },
      cache: ['/b'],
    })
    const merged = await a.merge(b)
    expect(Object.keys(merged.reads).sort()).toEqual(['/a', '/b'])
    expect(Object.keys(merged.writes).sort()).toEqual(['/x', '/y'])
    expect(merged.cache).toEqual(['/a', '/b'])
  })

  it('concatenates stderr from both sides', async () => {
    const a = new IOResult({ stderr: new TextEncoder().encode('A:') })
    const b = new IOResult({ stderr: new TextEncoder().encode('B') })
    const merged = await a.merge(b)
    expect(new TextDecoder().decode(merged.stderr as Uint8Array)).toBe('A:B')
  })

  it('takes exit_code from the right side by default', async () => {
    const a = new IOResult({ exitCode: 0 })
    const b = new IOResult({ exitCode: 7 })
    const merged = await a.merge(b)
    expect(merged.exitCode).toBe(7)
  })

  it('merge sets streamSource to the right side', async () => {
    const a = new IOResult()
    const b = new IOResult({ exitCode: 3 })
    const merged = await a.merge(b)
    expect(merged.streamSource).toBe(b)
  })
})

describe('IOResult.mergeAggregate', () => {
  it('uses max of exit codes', async () => {
    const a = new IOResult({ exitCode: 2 })
    const b = new IOResult({ exitCode: 5 })
    const merged = await a.mergeAggregate(b)
    expect(merged.exitCode).toBe(5)
  })

  it('aggregation respects the higher code from left', async () => {
    const a = new IOResult({ exitCode: 9 })
    const b = new IOResult({ exitCode: 0 })
    const merged = await a.mergeAggregate(b)
    expect(merged.exitCode).toBe(9)
  })
})

describe('IOResult.syncExitCode', () => {
  it('pulls exit_code from the streamSource chain', async () => {
    const inner = new IOResult({ exitCode: 0 })
    const outer = await new IOResult().merge(inner)
    inner.exitCode = 42
    outer.syncExitCode()
    expect(outer.exitCode).toBe(42)
  })

  it('explicit exitCode assignment survives a later syncExitCode (issue #43)', async () => {
    const inner = new IOResult({ exitCode: 1 })
    const outer = await new IOResult().merge(inner)
    expect(outer.streamSource).toBe(inner)
    outer.exitCode = 0
    expect(outer.streamSource).toBeNull()
    outer.syncExitCode()
    expect(outer.exitCode).toBe(0)
  })

  it('explicit exitCode survives across a merge chain that ends with a failing leaf', async () => {
    const a = new IOResult({ exitCode: 0 })
    const b = new IOResult({ exitCode: 1 })
    const c = new IOResult({ exitCode: 1 })
    let merged = await new IOResult().merge(a)
    merged = await merged.merge(b)
    merged = await merged.merge(c)
    merged.exitCode = 0
    merged.syncExitCode()
    expect(merged.exitCode).toBe(0)
  })
})
