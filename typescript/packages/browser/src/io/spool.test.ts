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

import { ByteSpool } from '@struktoai/mirage-core/io/spool'
import { describe, expect, it } from 'vitest'
import './spool.ts'

function bytes(length: number, seed: number): Uint8Array {
  return Uint8Array.from({ length }, (_, at) => (at * 31 + seed) % 251)
}

function same(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, at) => byte === right[at])
}

async function collect(spool: ByteSpool): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  for await (const part of spool.stream()) parts.push(part)
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

describe('browser spool store', () => {
  it('spills past the memory limit and reads back what it holds', async () => {
    const spool = new ByteSpool(1024)
    const first = bytes(300_000, 1)
    const second = bytes(23_457, 2)
    await spool.append(first)
    await spool.append(second)
    const whole = new Uint8Array(first.length + second.length)
    whole.set(first)
    whole.set(second, first.length)
    expect(same(await collect(spool), whole)).toBe(true)
    expect(same(await spool.read(262_100, 300), whole.subarray(262_100, 262_400))).toBe(true)
    await spool.close()
  })

  it('rewrites a window across blocks in place', async () => {
    const spool = new ByteSpool(1024)
    const data = bytes(300_000, 3)
    await spool.append(data)
    const patch = bytes(5000, 9)
    await spool.write(260_000, patch)
    data.set(patch, 260_000)
    expect(same(await collect(spool), data)).toBe(true)
    const body = await spool.body('fetch')
    expect(body).toBeInstanceOf(Blob)
    expect(same(new Uint8Array(await (body as Blob).arrayBuffer()), data)).toBe(true)
    await spool.close()
  })
})
