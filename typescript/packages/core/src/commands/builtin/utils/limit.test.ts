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
import { materialize } from '../../../io/types.ts'
import { Limit, OnExceed } from '../../../types.ts'
import { applyLimit } from './limit.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const TEN = ENC.encode(Array.from({ length: 10 }, (_, i) => `line${String(i)}\n`).join(''))

async function* stream(data: Uint8Array): AsyncIterable<Uint8Array> {
  await Promise.resolve()
  for (let i = 0; i < data.byteLength; i += 7) {
    yield data.subarray(i, i + 7)
  }
}

async function bytesOf(out: Uint8Array | AsyncIterable<Uint8Array> | null): Promise<Uint8Array> {
  if (out === null) return new Uint8Array()
  return materialize(out)
}

describe('applyLimit', () => {
  it('passes through when limit is null', async () => {
    const [out, io] = await applyLimit(TEN, null)
    expect(await bytesOf(out)).toEqual(TEN)
    expect(io.exitCode).toBe(0)
    expect(io.stderr).toBeNull()
  })

  it('passes through when under limit', async () => {
    const sg = new Limit({ maxLines: 100 })
    const [out, io] = await applyLimit(TEN, sg)
    expect(await bytesOf(out)).toEqual(TEN)
    expect(io.stderr).toBeNull()
  })

  it('truncates by lines', async () => {
    const sg = new Limit({ maxLines: 3 })
    const [out, io] = await applyLimit(TEN, sg)
    expect(DEC.decode(await bytesOf(out))).toBe('line0\nline1\nline2\n')
    expect(io.exitCode).toBe(0)
    expect(DEC.decode(await materialize(io.stderr))).toContain('truncated')
  })

  it('error mode returns null stdout + exit 1', async () => {
    const sg = new Limit({ maxLines: 3, onExceed: OnExceed.ERROR })
    const [out, io] = await applyLimit(TEN, sg)
    expect(out).toBeNull()
    expect(io.exitCode).toBe(1)
    expect(DEC.decode(await materialize(io.stderr))).toContain('truncated')
  })

  it('truncates by bytes', async () => {
    const sg = new Limit({ maxBytes: 10 })
    const [out, io] = await applyLimit(TEN, sg)
    expect(await bytesOf(out)).toEqual(TEN.subarray(0, 10))
    expect(DEC.decode(await materialize(io.stderr))).toContain('truncated')
  })

  it('truncates streaming input early', async () => {
    const sg = new Limit({ maxLines: 2 })
    const [out, io] = await applyLimit(stream(TEN), sg)
    expect(DEC.decode(await bytesOf(out))).toBe('line0\nline1\n')
    expect(DEC.decode(await materialize(io.stderr))).toContain('truncated')
  })
})

it.each([1, 2, 20])('intersects limits and detects exact fits with chunks of %i', async (size) => {
  for (const [text, limit, expected, truncated] of [
    ['a\nb\n', new Limit({ maxLines: 2 }), 'a\nb\n', false],
    ['a\nb\nc\nd\n', new Limit({ maxLines: 2, maxBytes: 7 }), 'a\nb\n', true],
    ['abc', new Limit({ maxLines: 0 }), '', true],
    ['abc', new Limit({ maxBytes: 0 }), '', true],
    ['abc', new Limit({ maxBytes: 3 }), 'abc', false],
    ['a\nb', new Limit({ maxLines: 1 }), 'a\n', true],
  ] as const) {
    async function* source(): AsyncIterable<Uint8Array> {
      for (let at = 0; at < text.length; at += size)
        yield await Promise.resolve(new TextEncoder().encode(text.slice(at, at + size)))
    }
    const [out, io] = await applyLimit(source(), limit)
    expect(new TextDecoder().decode(await materialize(out))).toBe(expected)
    expect((await io.stderrStr()).includes('truncated')).toBe(truncated)
  }
})
